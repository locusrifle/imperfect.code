import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listWallpapers, resolveWallpaper } from '../wallpapers.mjs';

test('wallpaper inventory is derived from theme background directories', async () => {
	const root = await mkdtemp(join(tmpdir(), 'imperfect-wallpapers-'));
	try {
		await mkdir(join(root, 'garden', 'backgrounds'), { recursive: true });
		await mkdir(join(root, 'night', 'backgrounds'), { recursive: true });
		await writeFile(join(root, 'garden', 'backgrounds', '01-morning.jpg'), 'jpg');
		await writeFile(join(root, 'night', 'backgrounds', '02-stars.png'), 'png');
		await writeFile(join(root, 'night', 'backgrounds', 'ignore.txt'), 'no');

		assert.deepEqual(await listWallpapers(root), [
			{ id: 'garden/01-morning.jpg', theme: 'garden', name: '01-morning.jpg', label: 'Morning' },
			{ id: 'night/02-stars.png', theme: 'night', name: '02-stars.png', label: 'Stars' },
		]);
		assert.equal((await resolveWallpaper(root, 'garden', '01-morning.jpg')).toString().endsWith('01-morning.jpg'), true);
		assert.equal(await resolveWallpaper(root, '../etc', 'passwd'), null);
		assert.equal(await resolveWallpaper(root, 'garden', '../night/02-stars.png'), null);
	} finally { await rm(root, { recursive: true, force: true }); }
});
