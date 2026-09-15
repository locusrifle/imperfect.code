// Pure channel selection from linuxdoom-1.10/s_sound.c:S_getChannel.
// Kept independent of Web Audio so allocation and priority preemption can be
// checked exactly.

export function S_ChooseChannel(channels, origin, sfxinfo, isChannelFree, stopChannel) {
  let cnum;

  // Take the first open slot. A non-null origin already using a slot reuses
  // that slot before any later free one, matching the source's index walk.
  for (cnum = 0; cnum < channels.length; cnum++) {
    if (isChannelFree(cnum)) break;
    if (origin !== null && channels[cnum].origin === origin) {
      stopChannel(cnum);
      break;
    }
  }

  // With no open slot, replace the first sound whose numeric priority is at
  // least the new sound's. Lower numbers are more important in Doom.
  if (cnum === channels.length) {
    for (cnum = 0; cnum < channels.length; cnum++) {
      if (channels[cnum].sfxinfo.priority >= sfxinfo.priority) break;
    }
    if (cnum === channels.length) return -1;
    stopChannel(cnum);
  }

  channels[cnum].sfxinfo = sfxinfo;
  channels[cnum].origin = origin;
  return cnum;
}
