// Pure message lifetime/overwrite state from hu_stuff.c:HU_Ticker.

export const HU_MSGTIMEOUT = 4 * 35;

function copyState(state) {
  return {
    text: state?.text ?? '',
    counter: Math.max(0, state?.counter | 0),
    locked: state?.locked === true,
    forcePending: state?.forcePending === true,
  };
}

export function HU_EmptyMessageState() {
  return { text: '', counter: 0, locked: false, forcePending: false };
}

// message_dontfuckwithme is a one-shot flag applied to the next player.message.
export function HU_ForceNextMessage(state) {
  return { ...copyState(state), forcePending: true };
}

// Install a direct browser-side message without advancing its lifetime.
export function HU_InstallMessageState(state, text, showMessages, force = false) {
  const next = copyState(state);
  const hasText = text !== null && text !== undefined && text !== '';
  if (!hasText || (showMessages !== true && force !== true) ||
      (next.locked === true && force !== true)) {
    return { state: next, consumed: false };
  }
  next.text = String(text);
  next.counter = HU_MSGTIMEOUT;
  next.locked = force === true;
  return { state: next, consumed: true };
}

// hu_stuff.c:505-530: expire the old message first, then consider the current
// player.message. A forced message may replace a locked message and starts a
// new lock; an ordinary message remains pending while that lock is active.
export function HU_AdvanceMessageState(state, incomingText, showMessages) {
  let next = copyState(state);
  if (next.counter > 0 && --next.counter === 0) next.locked = false;

  const force = next.forcePending;
  const installed = HU_InstallMessageState(next, incomingText, showMessages, force);
  next = installed.state;
  if (installed.consumed === true && force === true) next.forcePending = false;
  return { state: next, consumed: installed.consumed };
}
