// Shared imperfect computer launcher for vaita and Box.
// Loopback app; ingress stays on the existing authenticated proxy.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGueyServer } from './server.mjs';
import { ensureDataDirs, readConfig, resolvePrefix } from './machine.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const prefix = resolvePrefix();
const p = await ensureDataDirs(prefix);
const config = await readConfig(prefix);
if (config.person) process.env.IMPERFECT_PERSON = config.person;

const app = await createGueyServer({
  host: config.host,
  port: config.port,
  product: config.product,
  brand: config.brand,
  cwd: p.workspace,
  stateDir: p.state,
  agentDir: p.agent,
  sessionDir: p.sessions,
  authentication: config.authentication,
  ownArchive: config.ownArchive,
  liveSessions: config.liveSessions,
  filesRoot: p.workspace,
  knowledgeRoot: p.workspace,
  uiDir: p.ui,
  origins: config.origins,
  serviceOptions: {
    resourceLoaderOptions: {
      additionalExtensionPaths: [join(here, 'extensions/imperfect-environment')],
    },
  },
});
const address = await app.listen();
console.log(`imperfect.computer listening on ${address.address}:${address.port} (${p.workspace})`);

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  });
}
