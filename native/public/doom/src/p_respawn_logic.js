const FRACBITS = 16;
const ANG45 = 0x20000000;
const MF_SPAWNCEILING = 0x100;
const ONFLOORZ = -0x80000000;
const ONCEILINGZ = 0x7fffffff;

// The altdeath queue contains original mapthings. Vanilla resolves the
// doomednum and calls P_SpawnMobj directly; it does not revisit map filters,
// randomize the state's tics, or update level totals.
export function P_SpawnRespawnedSpecial(mthing, mobjinfo, spawnMobj) {
  let type = 0;
  while (type < mobjinfo.length && mobjinfo[type].doomednum !== mthing.type) type++;
  if (type === mobjinfo.length) {
    throw new Error(`Unknown respawn doomednum ${mthing.type}`);
  }

  const x = mthing.x << FRACBITS;
  const y = mthing.y << FRACBITS;
  const z = (mobjinfo[type].flags & MF_SPAWNCEILING) !== 0 ? ONCEILINGZ : ONFLOORZ;
  const mo = spawnMobj(x, y, z, type);
  // C assigns the mapthing struct by value, so do not retain the queue entry.
  mo.spawnpoint = {
    x: mthing.x,
    y: mthing.y,
    angle: mthing.angle,
    type: mthing.type,
    options: mthing.options,
  };
  mo.angle = (((mthing.angle / 45) | 0) * ANG45) >>> 0;
  return mo;
}
