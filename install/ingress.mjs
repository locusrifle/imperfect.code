#!/usr/bin/env node
// Password gate in front of the loopback app. Box also publishes the raw machine port, so the
// supplier's HTTPS token is not enough. This process is snapshot-captured under /opt.
import { createServer, request as httpRequest } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function same(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req, user, password) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ') || !password) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); }
  catch { return false; }
  const cut = decoded.indexOf(':');
  if (cut < 0) return false;
  return same(decoded.slice(0, cut), user) && same(decoded.slice(cut + 1), password);
}

function deny(res) {
  res.writeHead(401, {
    'www-authenticate': 'Basic realm="Locus"',
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end('Password required');
}

export function createIngressServer({
  listenHost = '0.0.0.0',
  listenPort = 8080,
  backendHost = '127.0.0.1',
  backendPort = 5067,
  user = 'locus',
  password,
} = {}) {
  if (!password) throw new Error('ingress password is required');
  const backend = `${backendHost}:${backendPort}`;

  const server = createServer((req, res) => {
    if (!authorized(req, user, password)) return deny(res);
    const headers = { ...req.headers };
    for (const name of Object.keys(headers)) if (HOP.has(name.toLowerCase())) delete headers[name];
    delete headers.authorization;
    headers.host = backend;
    if (headers.origin) headers.origin = `http://${backend}`;
    const outgoing = httpRequest({
      hostname: backendHost,
      port: backendPort,
      path: req.url,
      method: req.method,
      headers,
    }, upstream => {
      const out = { ...upstream.headers };
      for (const name of Object.keys(out)) if (HOP.has(name.toLowerCase())) delete out[name];
      delete out['set-cookie'];
      res.writeHead(upstream.statusCode, out);
      upstream.pipe(res);
    });
    outgoing.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Locus is not reachable');
      } else res.end();
    });
    req.pipe(outgoing);
  });

  server.on('upgrade', (req, socket, head) => {
    if (!authorized(req, user, password)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Locus"\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const headers = { ...req.headers };
    for (const name of Object.keys(headers)) {
      const key = name.toLowerCase();
      if (HOP.has(key) && key !== 'upgrade' && key !== 'connection') delete headers[name];
    }
    delete headers.authorization;
    headers.host = backend;
    headers.origin = `http://${backend}`;
    const outgoing = httpRequest({
      hostname: backendHost,
      port: backendPort,
      path: req.url,
      method: req.method,
      headers,
    });
    outgoing.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      socket.write(`HTTP/1.1 101 ${upstreamRes.statusMessage}\r\n` +
        Object.entries(upstreamRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (upstreamHead?.length) socket.unshift(upstreamHead);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      for (const s of [socket, upstreamSocket]) s.on('error', () => { socket.destroy(); upstreamSocket.destroy(); });
    });
    outgoing.on('response', () => socket.destroy());
    outgoing.on('error', () => socket.destroy());
    if (head?.length) outgoing.write(head);
    outgoing.end();
  });

  return {
    listen: () => new Promise(done => server.listen(listenPort, listenHost, () => done(server.address()))),
    close: () => new Promise(done => {
      server.closeAllConnections?.();
      server.close(done);
    }),
  };
}

async function main() {
  const password = process.env.IMPERFECT_INGRESS_PASSWORD;
  if (!password) {
    process.stderr.write('IMPERFECT_INGRESS_PASSWORD is required\n');
    process.exit(1);
  }
  const app = createIngressServer({
    listenHost: process.env.IMPERFECT_INGRESS_HOST || '0.0.0.0',
    listenPort: Number(process.env.IMPERFECT_INGRESS_PORT || 8080),
    backendHost: process.env.IMPERFECT_HOST || '127.0.0.1',
    backendPort: Number(process.env.IMPERFECT_PORT || 5067),
    user: process.env.IMPERFECT_INGRESS_USER || 'locus',
    password,
  });
  const address = await app.listen();
  console.log(`imperfect ingress on ${address.address}:${address.port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
}
