// Grok/xAI plan meter from the same CLI billing proxy Grok's own /usage uses.
// No secrets in the returned object.

export const GROK_CREDITS_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

export function grokAccess(auth) {
  if (!auth || typeof auth !== 'object') return null;
  for (const value of Object.values(auth)) {
    const key = String(value?.key ?? '').trim();
    if (!key) continue;
    return {
      token: key,
      expiresAt: value.expires_at ?? null,
      label: 'grok-cli',
    };
  }
  return null;
}

export function piXaiAccess(auth) {
  const access = String(auth?.xai?.access ?? '').trim();
  if (!access) return null;
  const exp = auth.xai.expires;
  const ms = typeof exp === 'number' ? (exp > 1e12 ? exp : exp * 1000) : Date.parse(exp);
  return {
    token: access,
    expiresAt: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
    label: 'pi',
  };
}

export function parseGrokCredits(payload) {
  const config = payload?.config ?? payload ?? {};
  const percentRaw = config.creditUsagePercent;
  let percent = null;
  if (percentRaw != null && Number.isFinite(Number(percentRaw))) {
    // Grok's proxy reports 0–100, not a 0–1 fraction.
    percent = Math.round(Math.max(0, Math.min(100, Number(percentRaw))) * 10) / 10;
  } else {
    const cap = Number(config.onDemandCap?.val);
    const used = Number(config.onDemandUsed?.val);
    if (cap > 0 && Number.isFinite(used)) {
      percent = Math.round(Math.max(0, Math.min(100, (used / cap) * 100)) * 10) / 10;
    }
  }
  const resetsAt = config.currentPeriod?.end || config.billingPeriodEnd || null;
  const plan = config.subscriptionTier || payload?.subscriptionTier || 'xAI';
  const windows = percent == null ? [] : [{
    label: 'Usage limit',
    percent,
    resetsAt,
  }];
  return { plan, windows };
}

async function readJson(path) {
  try {
    return JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function grokProvider(home, fetchImpl = fetch) {
  const empty = {
    id: 'grok',
    name: 'Grok',
    plan: 'xAI',
    source: 'grok billing',
    fetchedAt: null,
    windows: [],
    note: 'run grok login',
  };
  const grokAuth = await readJson(`${home}/.grok/auth.json`);
  const piAuth = await readJson(`${home}/.pi/agent/auth.json`);
  const candidates = [grokAccess(grokAuth), piXaiAccess(piAuth)].filter(Boolean);
  if (!candidates.length) return { ...empty, note: 'no Grok or Pi xAI login on this machine' };

  let lastNote = empty.note;
  for (const access of candidates) {
    const expired = access.expiresAt && Date.parse(access.expiresAt) <= Date.now();
    try {
      const response = await fetchImpl(GROK_CREDITS_URL, {
        headers: {
          Authorization: `Bearer ${access.token}`,
          'x-xai-token-auth': 'xai-grok-cli',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 401 || response.status === 403) {
        lastNote = expired || access.label === 'grok-cli'
          ? 'Grok CLI login expired; Pi xAI is a different sign-in'
          : 'xAI billing refused this login';
        continue;
      }
      if (!response.ok) {
        lastNote = `Grok billing HTTP ${response.status}`;
        continue;
      }
      const parsed = parseGrokCredits(await response.json());
      return {
        id: 'grok',
        name: 'Grok',
        plan: parsed.plan,
        source: access.label === 'pi' ? 'pi xai' : 'grok billing',
        fetchedAt: new Date().toISOString(),
        windows: parsed.windows,
        note: parsed.windows.length ? null : 'Grok returned no credit percent',
      };
    } catch {
      lastNote = expired ? 'Grok CLI login expired; Pi xAI is a different sign-in' : 'Grok billing unreachable';
    }
  }
  return { ...empty, note: lastNote };
}
