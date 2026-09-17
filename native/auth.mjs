import { randomUUID } from 'node:crypto';
import { CredentialSynchronizationError } from '@earendil-works/pi-coding-agent';
import {
  CLAUDE_PROVIDER_ID, CLAUDE_PROVIDER_NAME, ClaudeKeyRejected,
  ambientClaudeKey, claudeConfigured, readClaudeKey, removeClaudeKey, resolveClaudeAuth,
  verifyClaudeKey, writeClaudeKey,
} from './claude-credentials.mjs';

// Only UI/lifecycle adaptation. Pi owns provider flows, callbacks, token exchange,
// credential persistence, refresh and availability. No credentials enter snapshots.
//
// One panel, two destinations. This machine runs two harnesses, and a person
// should not have to know which one owns their account to sign in: the provider
// list is a single list, and the row decides where the answer goes. Every row
// but Claude Agent is Pi's; that one is ours, and takes an API key only.
export function createAuth({ models, changed, assertIdle, timeoutMs = 10 * 60 * 1000, agentDir = null, verifyClaude = verifyClaudeKey }) {
  let flow = null;
  let state = { status: 'idle', prompt: null, events: [] };
  const update = () => changed();
  // Offered only where there is somewhere to put the key. Without an agentDir
  // this console has no profile of its own, so the row would be a dead door.
  function claudeProvider() {
    if (!agentDir) return null;
    const ambient = Boolean(ambientClaudeKey());
    // Says which credential this machine would run on, so the panel can tell a
    // person who is already signed in that they need nothing from this screen.
    const credential = resolveClaudeAuth(agentDir).source;
    return {
      id: CLAUDE_PROVIDER_ID, name: CLAUDE_PROVIDER_NAME,
      configured: claudeConfigured(agentDir), credential,
      // No oauth shape exists here at all, and this is the reason: signing a
      // person into a claude.ai account is not a thing this console may do on
      // Anthropic's behalf. It is not a statement about subscriptions — a
      // machine already signed in through Claude's own CLI runs on that, and
      // `credential` above reports it. What is withheld is the login flow.
      methods: [{ type: 'api_key', name: 'Anthropic API key', label: 'Use an API key', ambient: ambient && !readClaudeKey(agentDir) }],
    };
  }
  function providers() {
    const runtime = models();
    const pi = runtime.getProviders().map(p => ({
      id: p.id, name: p.name,
      configured: runtime.getProviderAuthStatus(p.id).configured,
      methods: [
        ...(p.auth.oauth ? [{ type: 'oauth', name: p.auth.oauth.name, label: p.auth.oauth.loginLabel ?? 'Use a subscription / sign in', subscription: Boolean(p.auth.oauth.isSubscription) }] : []),
        ...(p.auth.apiKey ? [{ type: 'api_key', name: p.auth.apiKey.name, label: 'Use an API key', ambient: !p.auth.apiKey.login }] : []),
      ],
    }));
    return [...pi, claudeProvider()].filter(p => p?.methods.length);
  }
  function notify(event, current) {
    if (flow !== current || current.controller.signal.aborted) return;
    // Deliberate event allowlist: never expose provider objects or credentials.
    let item;
    if (event.type === 'auth_url') item = { type: event.type, url: event.url, instructions: event.instructions };
    else if (event.type === 'device_code') item = { type: event.type, userCode: event.userCode, verificationUri: event.verificationUri };
    else if (event.type === 'info') item = { type: event.type, message: event.message, links: event.links?.map(l => ({ url: l.url, label: l.label })) };
    else if (event.type === 'progress') item = { type: event.type, message: event.message };
    if (item) { state.events = [...state.events, item].slice(-20); update(); }
  }
  function prompt(request, current) {
    if (flow !== current || current.controller.signal.aborted || request.signal?.aborted) return Promise.reject(new Error('Login cancelled'));
    if (current.pending) return Promise.reject(new Error('Overlapping login prompts'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        request.signal?.removeEventListener('abort', abort);
        current.controller.signal.removeEventListener('abort', abort);
        if (current.pending?.id === id) { current.pending = null; state.prompt = null; update(); }
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new Error('Login cancelled'));
      current.pending = { id, finish };
      state.prompt = { id, type: request.type, message: request.message, placeholder: request.placeholder,
        ...(request.type === 'select' ? { options: request.options.map(o => ({ id: o.id, label: o.label, description: o.description })) } : {}) };
      request.signal?.addEventListener('abort', abort, { once: true });
      current.controller.signal.addEventListener('abort', abort, { once: true });
      update();
    });
  }
  // Ours, not Pi's. Same prompt/notify channel, so the panel renders this the
  // way it renders every other provider and needs to know nothing about it.
  async function runClaude(current, logout) {
    if (logout) {
      removeClaudeKey(agentDir);
      state.message = 'Stored credentials removed. Environment and cloud credentials are unchanged.';
      return;
    }
    const key = await prompt({ type: 'secret', message: 'Anthropic API key', placeholder: 'sk-ant-…' }, current);
    state.message = 'Checking the key with Anthropic…'; update();
    // Metadata only, never a model turn — the same courtesy Pi's catalog
    // refresh does, and the same rule: only an outright rejection is fatal.
    const checkSignal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(15000)]);
    const result = await verifyClaude(key, { signal: checkSignal });
    writeClaudeKey(agentDir, key);
    state.message = result.checked
      ? 'Signed in. The key is saved in this console’s own profile.'
      : 'Key saved, but Anthropic could not be reached to check it. A Claude session will say so if it is wrong.';
  }

  function begin(providerId, method, logout = false) {
    assertIdle();
    const claude = providerId === CLAUDE_PROVIDER_ID;
    const provider = providers().find(p => p.id === providerId) ?? (logout && !claude ? { id: providerId, name: providerId } : null);
    if (!provider) throw new Error('Unknown login provider');
    if (!logout && !provider.methods.some(m => m.type === method && !m.ambient)) throw new Error('Unsupported login method; ambient credentials are configured outside this console');
    const current = { controller: new AbortController(), pending: null, done: null };
    flow = current;
    state = { id: randomUUID(), status: 'working', providerId, providerName: provider.name, method, prompt: null, events: [], message: logout ? 'Removing stored credentials…' : `Starting ${claude ? 'Claude' : 'Pi'} sign-in…` };
    update();
    const timer = setTimeout(() => current.controller.abort(), logout ? 15000 : timeoutMs);
    current.done = (async () => {
      const runtime = models();
      try {
        if (claude) await runClaude(current, logout);
        else if (logout) await runtime.logout(providerId, { signal: current.controller.signal });
        else await runtime.login(providerId, method, { signal: current.controller.signal, prompt: p => prompt(p, current), notify: e => notify(e, current) });
        state.status = 'success';
        if (!claude) state.message = logout ? 'Stored credentials removed. Environment and cloud credentials are unchanged.' : 'Signed in. Credentials saved in this console’s own profile.';
        // The same supported catalog refresh used after terminal Pi login. This
        // fetches metadata only, not a model turn; failure cannot undo login.
        // Claude has no catalog in Pi's ModelRuntime, so there is nothing here
        // to refresh — its own check already ran inside runClaude.
        if (!logout && !claude) {
          state.message = 'Signed in. Updating the provider’s model list…'; update();
          const refreshSignal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(15000)]);
          try {
            const result = await runtime.refresh({ providers: [providerId], allowNetwork: true, signal: refreshSignal });
            state.message = result.aborted || result.errors.size
              ? 'Signed in, but the model list could not be refreshed. A cached model is used until it can be.'
              : 'Signed in.';
          } catch { state.message = 'Signed in, but the model list could not be refreshed. A cached model is used until it can be.'; }
        }
      } catch (error) {
        // A key Anthropic named as bad is the one failure worth repeating back,
        // because the person can act on it. It never quotes the key itself, and
        // the shared finally below still does the cleanup.
        if (claude && error instanceof ClaudeKeyRejected) {
          state.status = 'error';
          state.message = error.message;
        }
        // A cancellation racing the commit can leave saved credentials. Pi tells
        // us explicitly; don't misreport that as an unsaved/cancelled login.
        else if (error instanceof CredentialSynchronizationError) {
          state.status = 'warning';
          state.message = logout ? 'Credentials removed, but local model state could not be updated. Restart this console.' : 'Credentials saved, but local model state could not be updated. Restart this console; do not repeat sign-in blindly.';
        } else {
          state.status = current.controller.signal.aborted ? 'cancelled' : 'error';
          // Provider exceptions may contain submitted keys/codes. Never log or
          // return them to a transcript/browser; the user can retry explicitly.
          state.message = current.controller.signal.aborted ? 'Sign-in cancelled or timed out.' : 'Pi could not complete sign-in. Check the provider/account and try again.';
        }
      } finally {
        clearTimeout(timer);
        current.pending?.finish(new Error('Login ended'));
        state.prompt = null; state.events = []; flow = null; update();
      }
    })();
    return { started: true };
  }
  return {
    get busy() { return Boolean(flow); },
    // `configured` gates the welcome panel, and it stays a question about Pi.
    // A machine holding only a Claude key still opens on a Pi tab that cannot
    // run, so suppressing the sign-in there would hide the thing it needs.
    // `claude` is reported beside it rather than folded into it.
    snapshot() {
      const available = models().getAvailableSnapshot();
      return {
        ...state, busy: Boolean(flow),
        configured: providers().some(p => p.id !== CLAUDE_PROVIDER_ID && p.configured),
        claude: Boolean(agentDir && claudeConfigured(agentDir)),
        availableModels: available.length,
      };
    },
    providers,
    async accounts() {
      const runtime = models();
      const pi = (await runtime.listCredentials({ signal: AbortSignal.timeout(15000) })).map(c => ({ id: c.providerId, name: runtime.getProvider(c.providerId)?.name ?? c.providerId, type: c.type }));
      // Only a key this console stored. An ambient one is not an account here;
      // nothing in this panel put it there and logout could not remove it.
      const claude = agentDir && readClaudeKey(agentDir)
        ? [{ id: CLAUDE_PROVIDER_ID, name: CLAUDE_PROVIDER_NAME, type: 'api_key' }]
        : [];
      return [...pi, ...claude];
    },
    login: (providerId, method) => begin(providerId, method),
    async logout(providerId) {
      assertIdle();
      if (providerId === CLAUDE_PROVIDER_ID) {
        if (!agentDir || !readClaudeKey(agentDir)) throw new Error('No stored credential to remove; environment credentials are unchanged');
        return begin(providerId, undefined, true);
      }
      const stored = await models().listCredentials({ signal: AbortSignal.timeout(15000) });
      if (!stored.some(c => c.providerId === providerId)) throw new Error('No stored credential to remove; environment credentials are unchanged');
      return begin(providerId, undefined, true); // rechecks idle after enumeration
    },
    answer(id, value) {
      if (!flow?.pending || flow.pending.id !== id) throw new Error('Login prompt expired or already answered');
      if (typeof value !== 'string' || value.length > 20000 || !value.trim()) throw new Error('A nonempty answer is required (maximum 20000 characters)');
      if (state.prompt.type === 'select' && !state.prompt.options.some(o => o.id === value)) throw new Error('Invalid login choice');
      flow.pending.finish(null, value); // never return/persist an answer ourselves
    },
    async cancel() { if (flow) { const current = flow; current.controller.abort(); await current.done; } },
    dismiss() { if (flow) throw new Error('Cancel sign-in before dismissing it'); state = { status: 'idle', prompt: null, events: [] }; update(); },
  };
}
