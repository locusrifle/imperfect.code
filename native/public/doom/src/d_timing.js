// Browser timing helper for D_DoomLoop.
//
// Rendering may run slower or faster than Doom's fixed 35 Hz simulation.
// Convert elapsed wall time into a whole-tic count while carrying the
// fractional remainder forward. No due tics are discarded: a sustained low
// render rate must not slow the game clock.

import { TICRATE } from './doomdef.js';
import { BACKUPTICS } from './doomstat.js';

// Page Visibility gives the browser a non-heuristic suspension boundary.
// Hidden RAF callbacks freeze simulation; the first visible callback may run
// only the command debt Linux Doom's NetUpdate can actually buffer.
export const D_VisibilityFrameState = Object.freeze({
  active: 0,
  hidden: 1,
  resumed: 2,
});

// d_net.c:404 — maketic may lead gametic by BACKUPTICS/2-1 commands.
export const D_SUSPENSION_TIC_CAP = BACKUPTICS / 2 - 1;

export function D_CreateVisibilitySuspension(target) {
  let hiddenSinceLastVisibleFrame = target?.visibilityState === 'hidden';
  let disposed = false;
  const onVisibilityChange = () => {
    if (target.visibilityState === 'hidden') hiddenSinceLastVisibleFrame = true;
  };
  target?.addEventListener?.('visibilitychange', onVisibilityChange);

  return {
    frameState() {
      if (target?.visibilityState === 'hidden') {
        hiddenSinceLastVisibleFrame = true;
        return D_VisibilityFrameState.hidden;
      }
      if (hiddenSinceLastVisibleFrame === true) {
        hiddenSinceLastVisibleFrame = false;
        return D_VisibilityFrameState.resumed;
      }
      return D_VisibilityFrameState.active;
    },

    dispose() {
      if (disposed === true) return;
      disposed = true;
      target?.removeEventListener?.('visibilitychange', onVisibilityChange);
    },
  };
}

export function D_AccumulateTics(remainder, elapsedSeconds) {
  const accumulated = remainder + elapsedSeconds * TICRATE;
  const due = Math.floor(accumulated);
  return { due, remainder: accumulated - due };
}

function D_DiscardWholeTics(remainder, elapsedSeconds) {
  const accumulated = remainder + elapsedSeconds * TICRATE;
  return { due: 0, remainder: accumulated - Math.floor(accumulated) };
}

// d_main.c:D_Display completes the entire blocking melt before D_DoomLoop can
// return to TryRunTics.  A browser frame cannot block, so discard every whole
// simulation tic that passes while the melt spans RAFs.  Keep only the updated
// sub-tic phase: native timing is anchored to integer I_GetTime boundaries, and
// resetting the fraction would add up to one extra tic of post-wipe latency.
export function D_AdvanceSimulationClock(
  remainder,
  elapsedSeconds,
  wipeActive,
  singletics = false,
  visibilityState = D_VisibilityFrameState.active,
) {
  // Browsers may still deliver a final throttled RAF while hidden. It must not
  // consume the suspension latch or advance gameplay before the visible frame.
  if (wipeActive === true || visibilityState === D_VisibilityFrameState.hidden) {
    return D_DiscardWholeTics(remainder, elapsedSeconds);
  }
  // d_main.c:D_DoomLoop's singletics branch advances once per presented loop
  // iteration, independent of wall time. In the browser one RAF is that
  // iteration. Drop adaptive-clock debt so leaving timedemo cannot burst it.
  if (singletics === true) return { due: 1, remainder: 0 };
  if (visibilityState === D_VisibilityFrameState.resumed) {
    const accumulated = remainder + elapsedSeconds * TICRATE;
    const whole = Math.floor(accumulated);
    return {
      due: Math.min(whole, D_SUSPENSION_TIC_CAP),
      remainder: accumulated - whole,
    };
  }
  return D_AccumulateTics(remainder, elapsedSeconds);
}
