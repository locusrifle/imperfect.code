// Pure p_enemy.c:A_Chase action. Dependencies are explicit so target selection,
// movement, and RNG ordering can be verified without loading the renderer or a
// WAD. The registered production action supplies live bindings from p_enemy.js.

const ANG90 = 0x40000000;

export function A_Chase(actor, deps) {
  const {
    gameskill,
    fastparm,
    netgame,
    MF_SHOOTABLE,
    MF_JUSTATTACKED,
    P_CheckSight,
    P_LookForPlayers,
    P_CheckMeleeRange,
    P_CheckMissileRange,
    P_SetMobjState,
    P_Move,
    P_NewChaseDir,
    P_Random,
    S,
  } = deps;

  if (actor.reactiontime > 0) actor.reactiontime--;

  if (actor.threshold > 0) {
    if (actor.target === null || actor.target.health <= 0) actor.threshold = 0;
    else actor.threshold--;
  }

  if (actor.movedir < 8) {
    actor.angle = (actor.angle & ((7 << 29) >>> 0)) >>> 0;
    const delta = ((actor.angle - ((actor.movedir << 29) >>> 0)) | 0);
    if (delta > 0) actor.angle = (actor.angle - (ANG90 >>> 1)) >>> 0;
    else if (delta < 0) actor.angle = (actor.angle + (ANG90 >>> 1)) >>> 0;
  }

  if (actor.target === null || (actor.target.flags & MF_SHOOTABLE) === 0) {
    if (P_LookForPlayers(actor, true)) return;
    P_SetMobjState(actor, actor.info.spawnstate);
    return;
  }

  if ((actor.flags & MF_JUSTATTACKED) !== 0) {
    actor.flags &= ~MF_JUSTATTACKED;
    if (gameskill !== 4 /*sk_nightmare*/ && !fastparm) P_NewChaseDir(actor);
    return;
  }

  if (actor.info.meleestate !== 0 && P_CheckMeleeRange(actor)) {
    if (actor.info.attacksound !== 0 && S !== null) {
      S.S_StartSound(actor, actor.info.attacksound);
    }
    P_SetMobjState(actor, actor.info.meleestate);
    return;
  }

  if (actor.info.missilestate !== 0) {
    // The C actor->movecount condition is true for every non-zero value,
    // including -1 after the preceding tic's decrement.
    const movecountGate = gameskill < 4 /*sk_nightmare*/ &&
      !fastparm && actor.movecount !== 0;
    if (!movecountGate && P_CheckMissileRange(actor)) {
      P_SetMobjState(actor, actor.info.missilestate);
      actor.flags |= MF_JUSTATTACKED;
      return;
    }
  }

  // p_enemy.c:752-761 — possibly choose another target.
  if (netgame
      && !actor.threshold
      && !P_CheckSight(actor, actor.target)) {
    if (P_LookForPlayers(actor, true)) return;
  }

  // Chase toward target.
  if (--actor.movecount < 0 || !P_Move(actor)) {
    P_NewChaseDir(actor);
  }

  // Active sound (random).
  if (actor.info.activesound !== 0 && S !== null && P_Random() < 3) {
    S.S_StartSound(actor, actor.info.activesound);
  }
}
