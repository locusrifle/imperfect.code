// A one-shot stash for Android shares. Do not cache the console —
// a stale service worker is a second copy of imperfect, and this origin is
// a live agent.
const SHARE_CACHE = 'guey-share-target';
const SHARE_PATH = '/share-target';
const SHARE_FIELD = 'recordings';

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
	const url = new URL(event.request.url);
	if (event.request.method !== 'POST' || url.pathname !== SHARE_PATH) return;
	event.respondWith(stashShare(event.request));
});

async function stashShare(request) {
	const formData = await request.formData();
	const files = formData.getAll(SHARE_FIELD);
	const cache = await caches.open(SHARE_CACHE);
	const existing = await cache.keys();
	await Promise.all(existing.map(key => cache.delete(key)));
	let i = 0;
	for (const file of files) {
		if (!file || typeof file.size !== 'number') continue;
		const name = file.name || `recording-${i}`;
		i += 1;
		await cache.put(`__share/${i}/${encodeURIComponent(name)}`, new Response(file, {
			headers: {
				'Content-Type': file.type || 'application/octet-stream',
				'X-Filename': encodeURIComponent(name),
			},
		}));
	}
	return Response.redirect(new URL('/?shared=1', self.location.origin), 303);
}
