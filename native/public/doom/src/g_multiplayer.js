// Multiplayer player-flow helpers shared by g_game and d_main. Kept free of
// browser/rendering dependencies so the demo topology and vanilla spawn order
// can be regression-tested directly.

// Ensure every active slot has a player_t before P_SetupLevel starts spawning
// mapthings. An all-false topology is the normal local-game boot path, so only
// that case defaults to player 0; a demo-provided topology is otherwise kept
// byte-for-byte intact.
export function G_EnsurePlayerTopology(players, playeringame, makePlayer) {
  let haveActivePlayer = false;
  for (let i = 0; i < playeringame.length; i++) {
    if (playeringame[i] === true) { haveActivePlayer = true; break; }
  }
  if (!haveActivePlayer) playeringame[0] = true;

  for (let i = 0; i < playeringame.length; i++) {
    if (playeringame[i] !== true) continue;
    let player = players[i];
    if (player === null || player === undefined) {
      player = makePlayer();
      // g_game.c:1439-1441 — newly-created JS structs missed G_InitNew's
      // all-player PST_REBORN assignment, so apply it before their first spawn.
      player.playerstate = 2 /*PST_REBORN*/;
      players[i] = player;
    }
    // The old level thinker list is about to be discarded. Deathmatch's first
    // G_CheckSpot path specifically relies on active players starting with no mo.
    player.mo = null;
  }
}

// Return active players in the same ascending slot order used by vanilla's
// G_Ticker. Null means the level has not finished constructing the topology.
export function G_CollectActivePlayers(players, playeringame) {
  const active = [];
  for (let i = 0; i < playeringame.length; i++) {
    if (playeringame[i] !== true) continue;
    const player = players[i];
    if (player === null || player === undefined) return null;
    active.push(player);
  }
  return active;
}

function G_CopyTiccmd(target, source) {
  target.forwardmove = source.forwardmove;
  target.sidemove = source.sidemove;
  target.angleturn = source.angleturn;
  target.consistancy = source.consistancy;
  target.chatchar = source.chatchar;
  target.buttons = source.buttons;
}

function G_ClearTiccmd(cmd) {
  cmd.forwardmove = 0;
  cmd.sidemove = 0;
  cmd.angleturn = 0;
  cmd.consistancy = 0;
  cmd.chatchar = 0;
  cmd.buttons = 0;
}

// d_net.c:NetUpdate supplies a base netcmd before g_game.c:G_Ticker attempts
// to read each demo command. This browser port owns only the console node, so
// unavailable remote bases are neutral while the captured console slot gets
// the locally-built command. The base matters when G_ReadDemoTiccmd sees a
// marker and deliberately leaves that player's command untouched.
export function G_StagePlayerTiccmds(
  players,
  playeringame,
  commandConsoleplayer,
  localTiccmd,
  demoPlayback,
) {
  const activePlayers = G_CollectActivePlayers(players, playeringame);
  if (activePlayers === null) return null;

  if (demoPlayback === true) {
    for (const activePlayer of activePlayers) G_ClearTiccmd(activePlayer.cmd);
  }

  const localPlayer = players[commandConsoleplayer];
  if (playeringame[commandConsoleplayer] === true &&
      localPlayer !== undefined && localPlayer !== null) {
    G_CopyTiccmd(localPlayer.cmd, localTiccmd);
  }
  return activePlayers;
}

// g_game.c:658-669 reads one command per active player, in player-index order.
export function G_ReadDemoTiccmds(activePlayers, readDemoTiccmd) {
  for (const player of activePlayers) {
    if (readDemoTiccmd(player.cmd) === false) return false;
  }
  return true;
}

// g_game.c:658-669 records immediately after the optional demo read, using
// the same ascending active-player order as the stream header topology.
export function G_WriteDemoTiccmds(activePlayers, writeDemoTiccmd) {
  for (const player of activePlayers) {
    if (writeDemoTiccmd(player.cmd) === false) return false;
  }
  return true;
}

// p_mobj.c:717-725 — copy a type-11 mapthing into the fixed ten-entry array
// and return the updated numeric equivalent of deathmatch_p.
export function P_RecordDeathMatchStart(deathmatchstarts, deathmatchCount, mapthing) {
  const index = deathmatchCount | 0;
  if (index >= deathmatchstarts.length) return index;
  const spot = deathmatchstarts[index];
  spot.x = mapthing.x;
  spot.y = mapthing.y;
  spot.angle = mapthing.angle;
  spot.type = mapthing.type;
  spot.options = mapthing.options;
  return index + 1;
}

// g_game.c:893-919 — choose and spawn at a deathmatch start. Dependencies are
// explicit both to avoid the g_game/p_setup cycle and to make RNG consumption
// and the twenty-attempt fallback deterministic in tests.
export function G_DeathMatchSpawnPlayer(playernum, {
  deathmatchstarts,
  deathmatchCount,
  playerstarts,
  P_Random,
  G_CheckSpot,
  P_SpawnPlayer,
  I_Error,
}) {
  const selections = deathmatchCount | 0;
  if (selections < 4) {
    I_Error(`Only ${selections} deathmatch spots, 4 required`);
    return false;
  }

  for (let j = 0; j < 20; j++) {
    const i = P_Random() % selections;
    const spot = deathmatchstarts[i];
    if (G_CheckSpot(playernum, spot)) {
      spot.type = playernum + 1;
      P_SpawnPlayer(spot);
      return true;
    }
  }

  // No unoccupied deathmatch start was found. Vanilla deliberately falls back
  // to the matching co-op start even though the player may become stuck.
  P_SpawnPlayer(playerstarts[playernum]);
  return true;
}

// g_game.c:843-889 — validate an initial spawn or a corpse respawn. The fog is
// spawned before the new player mobj, which is significant because both mobj
// creations consume one play-RNG value for lastlook.
export function G_CheckSpot(playernum, mapthing, {
  players,
  playeringame,
  consoleplayer,
  bodyqueue,
  getBodyqueSlot,
  setBodyqueSlot,
  P_CheckPosition,
  P_RemoveMobj,
  R_PointInSubsector,
  P_SpawnMobj,
  S_StartSound,
  finecosine,
  finesine,
  ANG45,
  ANGLETOFINESHIFT,
  MT_TFOG,
  sfx_telept,
}) {
  const player = players[playernum];
  if (player === null || player === undefined ||
      player.mo === null || player.mo === undefined) {
    const x = mapthing.x << 16;
    const y = mapthing.y << 16;
    for (let i = 0; i < playernum; i++) {
      // Vanilla's valid net topologies have all preceding slots active. Skip a
      // hole defensively so a demo's explicit sparse topology does not crash.
      if (playeringame[i] !== true) continue;
      const other = players[i];
      if (other === null || other === undefined ||
          other.mo === null || other.mo === undefined) continue;
      if (other.mo.x === x && other.mo.y === y) return false;
    }
    return true;
  }

  const x = mapthing.x << 16;
  const y = mapthing.y << 16;
  if (!P_CheckPosition(player.mo, x, y)) return false;

  const bodyqueslot = getBodyqueSlot();
  if (bodyqueslot >= bodyqueue.length) {
    P_RemoveMobj(bodyqueue[bodyqueslot % bodyqueue.length]);
  }
  bodyqueue[bodyqueslot % bodyqueue.length] = player.mo;
  setBodyqueSlot(bodyqueslot + 1);

  const ss = R_PointInSubsector(x, y);
  const angle = (ANG45 * ((mapthing.angle / 45) | 0)) >>> 0;
  const an = angle >>> ANGLETOFINESHIFT;
  const fog = P_SpawnMobj(
    (x + 20 * finecosine[an]) | 0,
    (y + 20 * finesine[an]) | 0,
    ss.sector.floorheight,
    MT_TFOG);
  const localPlayer = players[consoleplayer];
  if (localPlayer !== null && localPlayer !== undefined && localPlayer.viewz !== 1) {
    S_StartSound(fog, sfx_telept);
  }
  return true;
}

// g_game.c:922-967 — route a reborn player through the local level reload,
// random deathmatch spawn, or co-op start search as appropriate.
export function G_DoReborn(playernum, {
  netgame,
  deathmatch,
  players,
  playerstarts,
  queueLoadLevel,
  G_CheckSpot,
  G_DeathMatchSpawnPlayer,
  P_SpawnPlayer,
}) {
  if (!netgame) {
    queueLoadLevel();
    return true;
  }

  const player = players[playernum];
  if (player !== null && player !== undefined &&
      player.mo !== null && player.mo !== undefined) {
    player.mo.player = null;
  }

  if (deathmatch !== 0) {
    G_DeathMatchSpawnPlayer(playernum);
    return true;
  }

  if (G_CheckSpot(playernum, playerstarts[playernum])) {
    P_SpawnPlayer(playerstarts[playernum]);
    return true;
  }

  for (let i = 0; i < playerstarts.length; i++) {
    if (!G_CheckSpot(playernum, playerstarts[i])) continue;
    playerstarts[i].type = playernum + 1;
    P_SpawnPlayer(playerstarts[i]);
    playerstarts[i].type = i + 1;
    return true;
  }

  P_SpawnPlayer(playerstarts[playernum]);
  return true;
}
