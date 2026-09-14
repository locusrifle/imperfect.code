// Incoming shares from Android (Google Recorder, Files, Camera).
// The service worker stashes the bytes; this page takes them into the
// same upload path as the plus button. Not used by stock Guey.

export const SHARE_CACHE = 'guey-share-target';

function filenameOf(response, request) {
	const header = response.headers.get('X-Filename');
	if (header) {
		try { return decodeURIComponent(header); } catch { return header; }
	}
	const leaf = new URL(request.url, 'http://local').pathname.split('/').pop();
	if (!leaf) return 'recording';
	try { return decodeURIComponent(leaf); } catch { return leaf; }
}

export async function takeSharedFiles() {
	if (typeof caches === 'undefined') return [];
	const cache = await caches.open(SHARE_CACHE);
	const keys = await cache.keys();
	const files = [];
	for (const request of keys) {
		const response = await cache.match(request);
		if (!response) continue;
		const blob = await response.blob();
		const name = filenameOf(response, request);
		files.push(new File([blob], name, { type: blob.type || 'application/octet-stream' }));
	}
	return files;
}

export async function clearSharedFiles() {
	if (typeof caches === 'undefined') return;
	const cache = await caches.open(SHARE_CACHE);
	const keys = await cache.keys();
	await Promise.all(keys.map(key => cache.delete(key)));
}
