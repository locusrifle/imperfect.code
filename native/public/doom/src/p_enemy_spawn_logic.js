// Pure fixed-point helpers extracted from p_enemy.c spawn actions.

import { FixedMul } from './m_fixed.js';

// p_enemy.c:A_PainShootSkull — retain FixedMul's arithmetic right-shift for
// negative products instead of JavaScript's truncation toward zero.
export function P_PainSkullCoordinate(origin, prestep, fineComponent) {
  return (origin + FixedMul(prestep, fineComponent)) | 0;
}

// p_enemy.c:A_PainShootSkull counts only thinkers still dispatched through
// P_MobjThinker. Thinkers marked for lazy removal remain linked temporarily.
export function P_CountActiveSkulls(thinkercap, mobjThinker, skullType) {
  if (thinkercap === null || thinkercap === undefined) return 0;
  let count = 0;
  let thinker = thinkercap.next;
  while (thinker !== thinkercap) {
    const mobj = thinker.__mobj;
    if (thinker.function === mobjThinker &&
        mobj !== null && mobj !== undefined &&
        mobj.type === skullType) {
      count++;
    }
    thinker = thinker.next;
  }
  return count;
}
