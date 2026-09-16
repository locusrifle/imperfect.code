// The image lab's library: what was made, what it was made from, and where
// the person filed it.
//
// Pictures and pins are ordinary files in the workspace, not rows in a
// database, because the person owns this machine and should be able to find
// their own pictures with the files app, a shell, or a backup -- and because
// leaving is a thing this product promises. The index beside them holds only
// what the filesystem cannot: the prompt, what was combined, which folder.
//
// A lost index must not lose the pictures. Every read repairs itself from the
// directory: a picture on disk with no entry is adopted, an entry with no
// picture is dropped. The index is a convenience over the files, never the
// authority for whether a picture exists.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { extname, join, resolve } from 'node:path';

const INDEX = 'library.json';
const PICTURES = 'pictures';
const PINS = 'pins';

// A folder name is shown, so it may be anything a person types; an id is a
// path segment, so it may not. Keeping them separate is what stops a folder
// called "../.." from being a traversal.
const MAX_NAME = 80;
const MAX_PROMPT = 4000;

const PIN_TYPES = new Map([
  ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'], ['image/gif', '.gif'],
]);
export const PICTURE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'],
]);

function bad(status, message) {
  return Object.assign(new Error(message), { status });
}

// Ids are generated here and never accepted from a caller without passing
// through this. Anything that is not a plain uuid-ish token is refused rather
// than sanitised, because a silently rewritten id resolves to the wrong file.
function safeId(value) {
  const id = String(value ?? '');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw bad(400, 'not a picture id');
  return id;
}

function cleanName(value, fallback) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return name || fallback;
}

function nowStamp() {
  return new Date().toISOString();
}

export function createImageLab({ root }) {
  const ROOT = resolve(root);
  const picturesDir = join(ROOT, PICTURES);
  const pinsDir = join(ROOT, PINS);
  const indexPath = join(ROOT, INDEX);

  // Every write goes through one promise chain. Two tabs pressing send at the
  // same moment is the ordinary case here, not the exotic one, and a
  // read-modify-write of the index without this loses one of them.
  let queue = Promise.resolve();
  function serialize(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function ensureDirs() {
    await mkdir(picturesDir, { recursive: true, mode: 0o700 });
    await mkdir(pinsDir, { recursive: true, mode: 0o700 });
  }

  async function readIndex() {
    try {
      const parsed = JSON.parse(await readFile(indexPath, 'utf8'));
      return {
        folders: Array.isArray(parsed.folders) ? parsed.folders : [],
        pictures: Array.isArray(parsed.pictures) ? parsed.pictures : [],
        boards: Array.isArray(parsed.boards) ? parsed.boards : [],
        pins: Array.isArray(parsed.pins) ? parsed.pins : [],
      };
    } catch {
      // A missing or corrupt index is not an error worth showing anybody: the
      // pictures are still on disk and reconcile() is about to find them.
      return { folders: [], pictures: [], boards: [], pins: [] };
    }
  }

  // Written beside the real file and renamed over it, so a process that dies
  // mid-write leaves the previous index intact rather than a half one.
  async function writeIndex(data) {
    await ensureDirs();
    const temporary = `${indexPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(temporary, indexPath);
  }

  async function filesIn(directory) {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.filter(e => e.isFile()).map(e => e.name);
    } catch {
      return [];
    }
  }

  // The directory is the truth. Anything the index claims that is not on disk
  // is forgotten; anything on disk the index never heard of is adopted with
  // what little can be known about it, which is better than hiding a picture
  // the person can plainly see in their own files app.
  async function reconcile(data) {
    const onDisk = new Map();
    for (const name of await filesIn(picturesDir)) {
      const id = name.slice(0, name.length - extname(name).length);
      if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) onDisk.set(id, name);
    }
    const known = new Set();
    const pictures = [];
    for (const picture of data.pictures) {
      const id = String(picture?.id ?? '');
      if (!onDisk.has(id) || known.has(id)) continue;
      known.add(id);
      pictures.push({ ...picture, file: onDisk.get(id) });
    }
    for (const [id, name] of onDisk) {
      if (known.has(id)) continue;
      let created = nowStamp();
      try { created = (await stat(join(picturesDir, name))).mtime.toISOString(); } catch { /* keep now */ }
      pictures.push({ id, file: name, prompt: '', references: [], folder: '', created, adopted: true });
    }
    pictures.sort((a, b) => String(b.created).localeCompare(String(a.created)));

    const pinFiles = new Set(await filesIn(pinsDir));
    const pins = data.pins.filter(pin => pin?.file && pinFiles.has(pin.file));
    const folderIds = new Set(data.folders.map(f => f?.id));
    return {
      folders: data.folders.filter(f => f?.id && f?.name),
      // A picture whose folder was deleted goes back to the top level rather
      // than disappearing into a folder that is not drawn anywhere.
      pictures: pictures.map(p => (p.folder && !folderIds.has(p.folder) ? { ...p, folder: '' } : p)),
      boards: data.boards.filter(b => b?.id && b?.name),
      pins,
    };
  }

  async function load() {
    return reconcile(await readIndex());
  }

  /** Everything the lab draws: folders, pictures, boards and their pins. */
  async function library() {
    const data = await load();
    return {
      folders: data.folders,
      boards: data.boards,
      pictures: data.pictures.map(picture => ({
        id: picture.id,
        prompt: picture.prompt || '',
        references: picture.references || [],
        folder: picture.folder || '',
        created: picture.created,
        src: `/lab/picture?id=${encodeURIComponent(picture.id)}`,
      })),
      pins: data.pins.map(pin => ({
        id: pin.id,
        board: pin.board || '',
        note: pin.note || '',
        link: pin.link || '',
        src: `/lab/pin?id=${encodeURIComponent(pin.id)}`,
      })),
    };
  }

  /**
   * File a finished picture.
   *
   * `references` are the ids of the pins and pictures it was made from, kept
   * so the person can ask later what a picture came out of -- the one thing
   * about a generated image that is genuinely unrecoverable from the file.
   */
  async function savePicture({ image, prompt = '', references = [], folder = '' }) {
    if (!Buffer.isBuffer(image) || !image.length) throw bad(400, 'no picture to save');
    return serialize(async () => {
      await ensureDirs();
      const data = await load();
      const id = randomUUID();
      const file = `${id}.png`;
      await writeFile(join(picturesDir, file), image, { mode: 0o600 });
      const record = {
        id,
        file,
        prompt: String(prompt).slice(0, MAX_PROMPT),
        references: references.map(String).slice(0, 16),
        folder: folder && data.folders.some(f => f.id === folder) ? folder : '',
        created: nowStamp(),
      };
      data.pictures.unshift(record);
      await writeIndex(data);
      return { ...record, src: `/lab/picture?id=${encodeURIComponent(id)}` };
    });
  }

  /** The bytes of one picture, for serving it back. */
  async function readPicture(id) {
    const wanted = safeId(id);
    const data = await load();
    const picture = data.pictures.find(p => p.id === wanted);
    if (!picture) throw bad(404, 'no such picture');
    const full = join(picturesDir, picture.file);
    return { body: await readFile(full), type: PICTURE_TYPES.get(extname(picture.file).toLowerCase()) || 'image/png' };
  }

  /** The bytes of one cached pin. */
  async function readPin(id) {
    const wanted = safeId(id);
    const data = await load();
    const pin = data.pins.find(p => p.id === wanted);
    if (!pin) throw bad(404, 'no such pin');
    return { body: await readFile(join(pinsDir, pin.file)), type: PIN_TYPES.get(pin.type) ? pin.type : 'image/png' };
  }

  // Generation needs real paths on disk, not ids. Both pins and pictures can
  // be combined -- a picture you just made is as good a reference as a pin,
  // and the person selecting them does not distinguish.
  async function referencePaths(ids) {
    const data = await load();
    const paths = [];
    for (const raw of ids) {
      const id = safeId(raw);
      const picture = data.pictures.find(p => p.id === id);
      if (picture) { paths.push(join(picturesDir, picture.file)); continue; }
      const pin = data.pins.find(p => p.id === id);
      if (pin) { paths.push(join(pinsDir, pin.file)); continue; }
      throw bad(404, 'no such image to combine');
    }
    return paths;
  }

  async function createFolder(name) {
    return serialize(async () => {
      const data = await load();
      const folder = { id: randomUUID(), name: cleanName(name, 'Untitled'), created: nowStamp() };
      data.folders.push(folder);
      await writeIndex(data);
      return folder;
    });
  }

  async function renameFolder(id, name) {
    const wanted = safeId(id);
    return serialize(async () => {
      const data = await load();
      const folder = data.folders.find(f => f.id === wanted);
      if (!folder) throw bad(404, 'no such folder');
      folder.name = cleanName(name, folder.name);
      await writeIndex(data);
      return folder;
    });
  }

  // Deleting a folder keeps its pictures. A person tidying their shelves does
  // not expect the books to burn, and this is the one destructive-looking
  // action in the lab.
  async function deleteFolder(id) {
    const wanted = safeId(id);
    return serialize(async () => {
      const data = await load();
      if (!data.folders.some(f => f.id === wanted)) throw bad(404, 'no such folder');
      data.folders = data.folders.filter(f => f.id !== wanted);
      data.pictures = data.pictures.map(p => (p.folder === wanted ? { ...p, folder: '' } : p));
      await writeIndex(data);
      return { ok: true };
    });
  }

  async function movePicture(id, folder) {
    const wanted = safeId(id);
    return serialize(async () => {
      const data = await load();
      const picture = data.pictures.find(p => p.id === wanted);
      if (!picture) throw bad(404, 'no such picture');
      const target = String(folder ?? '');
      if (target && !data.folders.some(f => f.id === target)) throw bad(404, 'no such folder');
      picture.folder = target;
      await writeIndex(data);
      return { ok: true };
    });
  }

  async function deletePicture(id) {
    const wanted = safeId(id);
    return serialize(async () => {
      const data = await load();
      const picture = data.pictures.find(p => p.id === wanted);
      if (!picture) throw bad(404, 'no such picture');
      await rm(join(picturesDir, picture.file), { force: true });
      data.pictures = data.pictures.filter(p => p.id !== wanted);
      await writeIndex(data);
      return { ok: true };
    });
  }

  async function createBoard({ name, source = 'local', remoteId = '' }) {
    return serialize(async () => {
      const data = await load();
      const existing = remoteId && data.boards.find(b => b.remoteId === remoteId && b.source === source);
      if (existing) return existing;
      const board = { id: randomUUID(), name: cleanName(name, 'Board'), source, remoteId, created: nowStamp() };
      data.boards.push(board);
      await writeIndex(data);
      return board;
    });
  }

  async function deleteBoard(id) {
    const wanted = safeId(id);
    return serialize(async () => {
      const data = await load();
      if (!data.boards.some(b => b.id === wanted)) throw bad(404, 'no such board');
      const doomed = data.pins.filter(p => p.board === wanted);
      for (const pin of doomed) await rm(join(pinsDir, pin.file), { force: true });
      data.boards = data.boards.filter(b => b.id !== wanted);
      data.pins = data.pins.filter(p => p.board !== wanted);
      await writeIndex(data);
      return { ok: true };
    });
  }

  /**
   * Cache one inspiration image on this machine.
   *
   * The bytes must land here whatever their source. The product's own policy
   * is `default-src 'self'`, so a remote URL cannot be drawn in the page at
   * all -- and a board that only holds other people's URLs stops working the
   * day those URLs rot. A pin the person kept is a file they kept.
   */
  async function savePin({ image, type, board = '', note = '', link = '', remoteId = '' }) {
    if (!Buffer.isBuffer(image) || !image.length) throw bad(400, 'no image to save');
    const extension = PIN_TYPES.get(type);
    if (!extension) throw bad(400, 'not an image this can keep');
    return serialize(async () => {
      await ensureDirs();
      const data = await load();
      // The same pin saved twice is one pin. Content is what makes it the
      // same, not the URL it arrived through: Pinterest serves one image on
      // many addresses, and a board full of duplicates is the visible result.
      const digest = createHash('sha256').update(image).digest('hex').slice(0, 32);
      const known = data.pins.find(p => p.digest === digest && p.board === board);
      if (known) return { ...known, src: `/lab/pin?id=${encodeURIComponent(known.id)}` };
      const id = randomUUID();
      const file = `${id}${extension}`;
      await writeFile(join(pinsDir, file), image, { mode: 0o600 });
      const record = {
        id, file, type, digest,
        board: board && data.boards.some(b => b.id === board) ? board : '',
        note: String(note).slice(0, MAX_NAME * 2),
        link: String(link).slice(0, 500),
        remoteId: String(remoteId).slice(0, 120),
        created: nowStamp(),
      };
      data.pins.unshift(record);
      await writeIndex(data);
      return { ...record, src: `/lab/pin?id=${encodeURIComponent(id)}` };
    });
  }

  async function deletePin(id) {
    const wanted = safeId(id);
    return serialize(async () => {
      const data = await load();
      const pin = data.pins.find(p => p.id === wanted);
      if (!pin) throw bad(404, 'no such pin');
      await rm(join(pinsDir, pin.file), { force: true });
      data.pins = data.pins.filter(p => p.id !== wanted);
      await writeIndex(data);
      return { ok: true };
    });
  }

  return {
    root: ROOT,
    picturesDir,
    pinsDir,
    library,
    savePicture,
    readPicture,
    readPin,
    referencePaths,
    createFolder,
    renameFolder,
    deleteFolder,
    movePicture,
    deletePicture,
    createBoard,
    deleteBoard,
    savePin,
    deletePin,
  };
}
