#!/usr/bin/env node
// The drawer shows each application's own mark, and Doom's is inside the game.
//
// M_DOOM is the title-screen logo lump in the IWAD the port already loads, so the icon is the
// real one rather than a drawing of it. It is written next to the port, under `native/public/doom/`
// -- the directory git ignores -- because this repository is published and carries no
// redistribution grant for id Software's artwork. A clone with no WAD simply has no logo, and the
// drawer falls back to its own glyph; see docs/doom.md.
//
//   node tools/doom-logo.mjs
//
// Doom's picture format: a header, then one offset per column, and each column a run of posts
// (top, length, a pad byte, the pixels, a pad byte) ending at 0xff. Colours are indexes into
// PLAYPAL. Everything not covered by a post is transparent, which is why the logo has no ground.

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doom = join(root, 'native/public/doom');

function directory(wad) {
  if (wad.subarray(0, 4).toString('ascii') !== 'IWAD' && wad.subarray(0, 4).toString('ascii') !== 'PWAD') {
    throw new Error('not a WAD');
  }
  const count = wad.readUInt32LE(4);
  const start = wad.readUInt32LE(8);
  const lumps = new Map();
  for (let i = 0; i < count; i += 1) {
    const at = start + 16 * i;
    const name = wad.subarray(at + 8, at + 16).toString('ascii').replace(/\0+$/, '');
    if (!lumps.has(name)) lumps.set(name, wad.subarray(wad.readUInt32LE(at), wad.readUInt32LE(at) + wad.readUInt32LE(at + 4)));
  }
  return lumps;
}

function png(width, height, rgba) {
  const chunk = (type, body) => {
    const head = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crcOf(head));
    return Buffer.concat([lengthOf(body), head, crc]);
  };
  const lengthOf = body => { const n = Buffer.alloc(4); n.writeUInt32BE(body.length); return n; };
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crcOf = buf => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rgba, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const wad = ['doom.wad', 'doom2.wad', 'doom1.wad']
  .map(name => join(doom, name))
  .find(path => { try { readFileSync(path); return true; } catch { return false; } });
if (!wad) {
  console.error(`no IWAD under ${doom} -- see docs/doom.md`);
  process.exit(1);
}

const lumps = directory(readFileSync(wad));
const palette = lumps.get('PLAYPAL');
const picture = lumps.get('M_DOOM');
if (!palette || !picture) throw new Error('that WAD has no M_DOOM');

const width = picture.readInt16LE(0);
const height = picture.readInt16LE(2);
// One filtered scanline per row: a leading filter byte, then RGBA.
const rows = Buffer.alloc(height * (1 + width * 4));
for (let x = 0; x < width; x += 1) {
  let at = picture.readUInt32LE(8 + 4 * x);
  while (picture[at] !== 0xff) {
    const top = picture[at];
    const length = picture[at + 1];
    at += 3;
    for (let k = 0; k < length; k += 1) {
      const y = top + k;
      if (y < 0 || y >= height) continue;
      const colour = picture[at + k] * 3;
      const out = y * (1 + width * 4) + 1 + x * 4;
      rows[out] = palette[colour];
      rows[out + 1] = palette[colour + 1];
      rows[out + 2] = palette[colour + 2];
      rows[out + 3] = 0xff;
    }
    at += length + 1;
  }
}

const out = join(doom, 'M_DOOM.png');
writeFileSync(out, png(width, height, rows));
console.log(`${out} ${width}x${height} from ${wad}`);
