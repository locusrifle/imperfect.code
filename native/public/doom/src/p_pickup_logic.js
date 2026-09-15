// Pure pickup-mode decisions shared by p_inter.js and focused tests.
// These mirror linuxdoom-1.10/p_inter.c:P_GiveWeapon/P_TouchSpecialThing.

export function P_WeaponStaysInWorld(netgame, deathmatch, dropped) {
  return netgame === true && deathmatch !== 2 && dropped === false;
}

export function P_WeaponAmmoClips(netgame, deathmatch, dropped) {
  if (P_WeaponStaysInWorld(netgame, deathmatch, dropped)) {
    return deathmatch !== 0 ? 5 : 2;
  }
  return dropped ? 1 : 2;
}

export function P_KeyStaysInWorld(netgame) {
  return netgame === true;
}

export function P_PickupSoundIsLocal(player, players, consoleplayer) {
  return player === players[consoleplayer];
}

export function P_MegasphereAvailable(gamemode) {
  return gamemode === 2 /*commercial*/;
}
