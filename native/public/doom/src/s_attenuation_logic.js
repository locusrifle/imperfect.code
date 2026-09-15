// Pure volume half of linuxdoom-1.10/s_sound.c:S_AdjustSoundParams.
// Doom calculates in whole map units before dividing by S_ATTENUATOR; the
// browser adapter then maps the resulting 0..15 volume to Web Audio by *8.

const FRACUNIT = 65536;
const S_CLOSE_DIST = 160 * FRACUNIT;
const S_CLIPPING_DIST = 1200 * FRACUNIT;
const S_ATTENUATOR = (S_CLIPPING_DIST - S_CLOSE_DIST) / FRACUNIT;

export function S_AttenuatedVolume(approxDistance, sfxVolume, bossMap) {
  let distance = approxDistance;
  if (bossMap !== true && distance > S_CLIPPING_DIST) return null;

  let doomVolume;
  if (distance < S_CLOSE_DIST) {
    doomVolume = sfxVolume;
  } else {
    if (bossMap === true && distance > S_CLIPPING_DIST) {
      distance = S_CLIPPING_DIST;
    }

    // s_sound.c shifts the fixed-point remainder before either multiply or
    // divide. The remainder is non-negative here, so floor matches `>>16`.
    const remainingUnits = Math.floor((S_CLIPPING_DIST - distance) / FRACUNIT);
    if (bossMap === true) {
      doomVolume = 15 + Math.trunc((sfxVolume - 15) * remainingUnits / S_ATTENUATOR);
    } else {
      doomVolume = Math.trunc(sfxVolume * remainingUnits / S_ATTENUATOR);
    }
  }

  return doomVolume > 0 ? doomVolume * 8 : null;
}
