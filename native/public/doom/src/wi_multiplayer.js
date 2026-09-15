// Pure co-op/deathmatch intermission counters from wi_stuff.c. Rendering and
// animated backgrounds stay in wi_stuff.js; these models preserve the original
// integer formulas, phase timing, acceleration behavior, and sound ordering.

import { MAXPLAYERS, TICRATE } from './doomdef.js';
import { sfx_barexp, sfx_pistol, sfx_pldeth, sfx_sgcock, sfx_slop } from './sounds.js';

function activePlayer(playeringame, playernum) {
  return playeringame[playernum] === true;
}

function fragAt(plrs, playernum, victimnum) {
  return plrs[playernum]?.frags?.[victimnum] | 0;
}

export function WI_FragSum(playernum, plrs, playeringame) {
  let frags = 0;
  for (let i = 0; i < MAXPLAYERS; i++) {
    if (activePlayer(playeringame, i) && i !== playernum) {
      frags = (frags + fragAt(plrs, playernum, i)) | 0;
    }
  }
  // wi_stuff.c:833 — suicides/telefrags credited to oneself count negatively.
  return (frags - fragAt(plrs, playernum, playernum)) | 0;
}

function percent(count, max) {
  return ((count * 100) / max) | 0;
}

export function WI_InitDeathmatchStats(playeringame) {
  const frags = Array.from({ length: MAXPLAYERS }, () => new Int32Array(MAXPLAYERS));
  const totals = new Int32Array(MAXPLAYERS);
  // The C initializer only writes active cells. Fresh typed arrays provide the
  // same zeroed static-storage values without exposing stale inactive entries.
  for (let i = 0; i < MAXPLAYERS; i++) {
    if (!activePlayer(playeringame, i)) continue;
    totals[i] = 0;
    for (let j = 0; j < MAXPLAYERS; j++) {
      if (activePlayer(playeringame, j)) frags[i][j] = 0;
    }
  }
  return { state: 1, pause: TICRATE, frags, totals };
}

export function WI_UpdateDeathmatchStats(model, plrs, playeringame, bcnt, accelerate) {
  const sounds = [];
  let advance = false;
  let pendingAccelerate = accelerate ? 1 : 0;

  if (pendingAccelerate && model.state !== 4) {
    pendingAccelerate = 0;
    for (let i = 0; i < MAXPLAYERS; i++) {
      if (!activePlayer(playeringame, i)) continue;
      for (let j = 0; j < MAXPLAYERS; j++) {
        if (activePlayer(playeringame, j)) model.frags[i][j] = fragAt(plrs, i, j);
      }
      model.totals[i] = WI_FragSum(i, plrs, playeringame);
    }
    sounds.push(sfx_barexp);
    model.state = 4;
  }

  if (model.state === 2) {
    if ((bcnt & 3) === 0) sounds.push(sfx_pistol);
    let stillticking = false;

    for (let i = 0; i < MAXPLAYERS; i++) {
      if (!activePlayer(playeringame, i)) continue;
      for (let j = 0; j < MAXPLAYERS; j++) {
        if (!activePlayer(playeringame, j)) continue;
        const target = fragAt(plrs, i, j);
        if (model.frags[i][j] !== target) {
          model.frags[i][j] += target < 0 ? -1 : 1;
          if (model.frags[i][j] > 99) model.frags[i][j] = 99;
          if (model.frags[i][j] < -99) model.frags[i][j] = -99;
          // Vanilla remains in this phase for one extra tic after the last
          // displayed matrix entry reaches its target.
          stillticking = true;
        }
      }

      model.totals[i] = WI_FragSum(i, plrs, playeringame);
      if (model.totals[i] > 99) model.totals[i] = 99;
      if (model.totals[i] < -99) model.totals[i] = -99;
    }

    if (!stillticking) {
      sounds.push(sfx_barexp);
      model.state++;
    }
  } else if (model.state === 4) {
    if (pendingAccelerate) {
      sounds.push(sfx_slop);
      advance = true;
    }
  } else if ((model.state & 1) !== 0) {
    model.pause--;
    if (model.pause === 0) {
      model.state++;
      model.pause = TICRATE;
    }
  }

  return { sounds, advance, accelerate: pendingAccelerate };
}

export function WI_InitNetgameStats(plrs, playeringame, previousDofrags = 0) {
  const kills = new Int32Array(MAXPLAYERS);
  const items = new Int32Array(MAXPLAYERS);
  const secret = new Int32Array(MAXPLAYERS);
  const frags = new Int32Array(MAXPLAYERS);
  let dofrags = previousDofrags | 0;

  for (let i = 0; i < MAXPLAYERS; i++) {
    if (!activePlayer(playeringame, i)) continue;
    kills[i] = items[i] = secret[i] = frags[i] = 0;
    // Preserve Linux Doom's static dofrags accumulator as the seed for the
    // current intermission instead of resetting it before these additions.
    dofrags = (dofrags + WI_FragSum(i, plrs, playeringame)) | 0;
  }

  return {
    state: 1,
    pause: TICRATE,
    kills,
    items,
    secret,
    frags,
    dofrags: dofrags !== 0,
  };
}

export function WI_UpdateNetgameStats(model, wbs, playeringame, bcnt, accelerate) {
  const sounds = [];
  let advance = false;
  let pendingAccelerate = accelerate ? 1 : 0;
  const plrs = wbs.plyr;

  if (pendingAccelerate && model.state !== 10) {
    pendingAccelerate = 0;
    for (let i = 0; i < MAXPLAYERS; i++) {
      if (!activePlayer(playeringame, i)) continue;
      model.kills[i] = percent(plrs[i].skills, wbs.maxkills);
      model.items[i] = percent(plrs[i].sitems, wbs.maxitems);
      model.secret[i] = percent(plrs[i].ssecret, wbs.maxsecret);
      if (model.dofrags) model.frags[i] = WI_FragSum(i, plrs, playeringame);
    }
    sounds.push(sfx_barexp);
    model.state = 10;
  }

  if (model.state === 2) {
    if ((bcnt & 3) === 0) sounds.push(sfx_pistol);
    let stillticking = false;
    for (let i = 0; i < MAXPLAYERS; i++) {
      if (!activePlayer(playeringame, i)) continue;
      const target = percent(plrs[i].skills, wbs.maxkills);
      model.kills[i] += 2;
      if (model.kills[i] >= target) model.kills[i] = target;
      else stillticking = true;
    }
    if (!stillticking) {
      sounds.push(sfx_barexp);
      model.state++;
    }
  } else if (model.state === 4) {
    if ((bcnt & 3) === 0) sounds.push(sfx_pistol);
    let stillticking = false;
    for (let i = 0; i < MAXPLAYERS; i++) {
      if (!activePlayer(playeringame, i)) continue;
      const target = percent(plrs[i].sitems, wbs.maxitems);
      model.items[i] += 2;
      if (model.items[i] >= target) model.items[i] = target;
      else stillticking = true;
    }
    if (!stillticking) {
      sounds.push(sfx_barexp);
      model.state++;
    }
  } else if (model.state === 6) {
    if ((bcnt & 3) === 0) sounds.push(sfx_pistol);
    let stillticking = false;
    for (let i = 0; i < MAXPLAYERS; i++) {
      if (!activePlayer(playeringame, i)) continue;
      const target = percent(plrs[i].ssecret, wbs.maxsecret);
      model.secret[i] += 2;
      if (model.secret[i] >= target) model.secret[i] = target;
      else stillticking = true;
    }
    if (!stillticking) {
      sounds.push(sfx_barexp);
      model.state += 1 + 2 * (model.dofrags ? 0 : 1);
    }
  } else if (model.state === 8) {
    if ((bcnt & 3) === 0) sounds.push(sfx_pistol);
    let stillticking = false;
    for (let i = 0; i < MAXPLAYERS; i++) {
      if (!activePlayer(playeringame, i)) continue;
      const target = WI_FragSum(i, plrs, playeringame);
      model.frags[i] += 1;
      if (model.frags[i] >= target) model.frags[i] = target;
      else stillticking = true;
    }
    if (!stillticking) {
      sounds.push(sfx_pldeth);
      model.state++;
    }
  } else if (model.state === 10) {
    if (pendingAccelerate) {
      sounds.push(sfx_sgcock);
      advance = true;
    }
  } else if ((model.state & 1) !== 0) {
    model.pause--;
    if (model.pause === 0) {
      model.state++;
      model.pause = TICRATE;
    }
  }

  return { sounds, advance, accelerate: pendingAccelerate };
}
