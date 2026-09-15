// Pure movement helper for p_enemy.c:A_Fire.

export function P_RelinkVileFire(actor, dest, fineCosine, fineSine, unsetPosition, setPosition) {
  unsetPosition(actor);
  actor.x = (dest.x + 24 * fineCosine) | 0;
  actor.y = (dest.y + 24 * fineSine) | 0;
  actor.z = dest.z;
  setPosition(actor);
}
