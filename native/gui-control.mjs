#!/usr/bin/env node
// Fire a harness command with no UI. Used by the agent:
//   node native/gui-control.mjs capture phone
//   node native/gui-control.mjs desktop-open
//   node native/gui-control.mjs window-open --kind video --src /content/media/<project>/<asset> --title Clip
import { WebSocket } from 'ws';

function parseArgv(argv) {
  const type = argv[0];
  if (!type) {
    console.error('usage: node native/gui-control.mjs <command> [phone|desktop|all]');
    console.error('       node native/gui-control.mjs window-open --kind video|image|text|desktop|page [--src /antiburn.html] [--title …] [--text …] [--id …]');
    console.error('       node native/gui-control.mjs window-close --id <windowId>');
    process.exit(2);
  }
  const extra = { type };
  if (type === 'window-open' || type === 'window-close') {
    for (let i = 1; i < argv.length; i++) {
      const token = argv[i];
      const next = argv[i + 1];
      if (token === '--kind' && next) { extra.kind = next; i++; }
      else if ((token === '--id' || token === '--window-id') && next) { extra.windowId = next; i++; }
      else if (token === '--title' && next) { extra.title = next; i++; }
      else if (token === '--src' && next) { extra.src = next; i++; }
      else if (token === '--text' && next) { extra.text = next; i++; }
      else if (token === 'phone' || token === 'desktop' || token === 'all') extra.client = token;
      else {
        console.error(`unknown argument: ${token}`);
        process.exit(2);
      }
    }
    return extra;
  }
  if (argv[1]) extra.client = argv[1];
  return extra;
}

const extra = parseArgv(process.argv.slice(2));
const host = process.env.IMPERFECT_HOST || '127.0.0.1';
const port = process.env.IMPERFECT_PORT || '5057';
const url = `ws://${host}:${port}/pi`;
const ws = new WebSocket(url, { headers: { Host: `${host}:${port}` } });
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
const pending = new Map();
ws.on('message', raw => {
  const message = JSON.parse(raw);
  if (message.type === 'response') pending.get(message.id)?.(message);
});
const send = (id, payload) => new Promise(resolve => {
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, ...payload }));
});
const response = await send('1', extra);
ws.close();
if (!response.success) {
  console.error(response.error);
  process.exit(1);
}
if (response.data !== undefined) console.log(JSON.stringify(response.data, null, 2));
