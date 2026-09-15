// Deterministic accounting for g_game.c:G_TimeDemo. Native Doom reports
// I_GetTime() tics; the browser keeps the same 35 Hz units while also exposing
// the exact start/end values to callers instead of terminating through I_Error.

import { TICRATE } from './doomdef.js';

function wholeTic(value) {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

export function G_BeginTimeDemoSample(name, gameTic, realTic) {
  return Object.freeze({
    name: String(name ?? ''),
    startGameTic: wholeTic(gameTic),
    startRealTic: wholeTic(realTic),
  });
}

export function G_CompleteTimeDemoSample(sample, gameTic, realTic) {
  const endGameTic = wholeTic(gameTic);
  const endRealTic = wholeTic(realTic);
  const gametics = Math.max(0, endGameTic - sample.startGameTic);
  const realtics = Math.max(0, endRealTic - sample.startRealTic);
  return Object.freeze({
    name: sample.name,
    startGameTic: sample.startGameTic,
    endGameTic,
    startRealTic: sample.startRealTic,
    endRealTic,
    gametics,
    realtics,
    seconds: realtics / TICRATE,
    fps: realtics === 0 ? null : gametics * TICRATE / realtics,
    message: `timed ${gametics} gametics in ${realtics} realtics`,
  });
}
