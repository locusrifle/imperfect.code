const MF_SOLID = 0x2;
const PST_DEAD = 1;

// p_inter.c:P_KillMobj orders these operations deliberately: the corpse is
// made non-solid, the player enters PST_DEAD, then the weapon starts lowering.
export function P_DropWeaponOnDeath(target, dropWeapon) {
  target.flags &= ~MF_SOLID;
  target.player.playerstate = PST_DEAD;
  if (typeof dropWeapon !== 'function') {
    throw new Error('P_DropWeapon dependency was not wired');
  }
  dropWeapon(target.player);
}

// p_inter.c:708-714 — only the player whose view this client owns exits the
// automap on death. A remote player's death must not change the local view.
export function P_ShouldStopAutomapOnDeath(player, players, consoleplayer, automapactive) {
  return automapactive === true && player === players[consoleplayer];
}
