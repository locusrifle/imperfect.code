#!/usr/bin/env node
// locusrifle /usage: Omarchy collectors first; Codex session files if RPC is empty.
// Omarchy percents are 0–1. The harness bars use 0–100.
import { spawn } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { grokProvider } from './usage-grok.mjs';

function collect(agent) {
  return new Promise(resolve => {
    const child = spawn(`omarchy-agent-usage-${agent}`, ['--limits-only'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 20000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); }
      catch { resolve(null); }
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function asPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const pct = n <= 1 ? n * 100 : n;
  return Math.round(pct * 10) / 10;
}

function windowsFrom(record) {
  return (record?.limits ?? []).map(limit => ({
    label: limit.label || 'limit',
    percent: asPercent(limit.percent),
    resetsAt: limit.resetsAt || null,
  })).filter(window => window.percent != null);
}

function modelsFrom(record) {
  return Object.entries(record?.modelUsage ?? {}).map(([id, usage]) => {
    const input = Number(usage?.inputTokens) || 0;
    const output = Number(usage?.outputTokens) || 0;
    const cacheRead = Number(usage?.cacheReadInputTokens) || 0;
    return { id, input, output, cacheRead, tokens: input + output };
  }).sort((a, b) => b.tokens - a.tokens).slice(0, 8);
}

function statsFrom(record) {
  if (!record) return null;
  return {
    todaySessions: Number(record.todaySessions) || 0,
    todayTokens: Number(record.todayTotalTokens) || 0,
    totalSessions: Number(record.totalSessions) || 0,
    activeDays: Number(record.activeDays) || 0,
  };
}

function provider(id, name, record, fallbackNote) {
  if (!record) {
    return { id, name, plan: null, source: 'omarchy', fetchedAt: null, windows: [], note: fallbackNote, stats: null, models: [] };
  }
  const status = record.usageStatusText || record.authHelpText || null;
  return {
    id,
    name: record.name || name,
    plan: record.tierLabel || name,
    source: 'omarchy',
    fetchedAt: record.updatedAt || null,
    windows: windowsFrom(record),
    note: status && status !== 'OK' ? status : null,
    stats: statsFrom(record),
    models: modelsFrom(record),
  };
}

async function newestJsonl(dir, limit = 40) {
  const out = [];
  async function walk(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.jsonl')) {
        const info = await stat(path);
        out.push({ path, mtime: info.mtimeMs });
      }
    }
  }
  await walk(dir);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

async function codexFromDisk(home) {
  const files = await newestJsonl(join(home, '.codex/sessions'), 80);
  for (const file of files) {
    const text = await readFile(file.path, 'utf8').catch(() => '');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue;
      let row;
      try { row = JSON.parse(lines[i]); }
      catch { continue; }
      const limits = row?.payload?.rate_limits;
      const primary = limits?.primary;
      const secondary = limits?.secondary;
      if (primary?.used_percent == null && secondary?.used_percent == null) continue;
      const windows = [];
      if (primary?.used_percent != null) {
        windows.push({ label: 'Session (5-hour)', percent: asPercent(primary.used_percent), resetsAt: primary.resets_at ?? null });
      }
      if (secondary?.used_percent != null) {
        windows.push({ label: 'Weekly (7-day)', percent: asPercent(secondary.used_percent), resetsAt: secondary.resets_at ?? null });
      }
      return {
        id: 'codex',
        name: 'Codex',
        plan: limits.plan_type || 'Codex',
        source: 'codex session',
        fetchedAt: new Date(file.mtime).toISOString(),
        windows,
        note: 'last Codex session — live limits unavailable',
      };
    }
  }
  return null;
}

export async function buildUsageReport() {
  const homeDir = homedir();
  const [claudeRecord, codexRecord, grok] = await Promise.all([
    collect('claude'),
    collect('codex'),
    grokProvider(homeDir),
  ]);
  const claudeOut = provider('claude', 'Claude', claudeRecord, 'Claude collector missing');
  let codexOut = provider('codex', 'Codex', codexRecord, 'Codex collector missing');
  if (!codexOut.windows.length) {
    const disk = await codexFromDisk(homeDir);
    if (disk) {
      disk.stats = codexOut.stats;
      disk.models = codexOut.models;
      codexOut = disk;
    }
  }
  return {
    fetchedAt: new Date().toISOString(),
    live: true,
    providers: [claudeOut, codexOut, grok],
  };
}

const runningAsCli = process.argv[1]?.includes('usage-read');
if (runningAsCli) {
  const report = await buildUsageReport();
  const out = process.argv[2] || join(import.meta.dirname, 'public/antiburn-report.json');
  await writeFile(out, `${JSON.stringify(report)}\n`);
  process.stdout.write(`${out}\n`);
}
