// Immediate HTTP upload for locusrifle. The file lands on disk before any
// prompt; the composer later names the saved path. Not used by stock Guey.

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

export function uploadPercent(loaded, total) {
	if (!(total > 0)) return '…';
	return `${Math.min(100, Math.max(0, Math.floor((loaded / total) * 100)))}%`;
}

export function postUpload(file, { onProgress, signal } = {}) {
	return new Promise((resolve, reject) => {
		if (!file) {
			reject(new Error('no file'));
			return;
		}
		if (file.size > MAX_UPLOAD_BYTES) {
			reject(new Error(`${file.name || 'file'} is larger than 1 GB`));
			return;
		}
		const xhr = new XMLHttpRequest();
		const fail = (error) => {
			signal?.removeEventListener('abort', onAbort);
			reject(error);
		};
		const onAbort = () => xhr.abort();
		if (signal) {
			if (signal.aborted) {
				const error = new Error('upload aborted');
				error.name = 'AbortError';
				reject(error);
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		}
		xhr.open('POST', '/upload');
		xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'file'));
		xhr.setRequestHeader('Content-Type', 'application/octet-stream');
		xhr.upload.onprogress = event => {
			onProgress?.(event.loaded, event.lengthComputable ? event.total : 0);
		};
		xhr.onload = () => {
			signal?.removeEventListener('abort', onAbort);
			if (xhr.status >= 200 && xhr.status < 300) {
				try { resolve(JSON.parse(xhr.responseText)); }
				catch { fail(new Error('upload failed')); }
				return;
			}
			fail(new Error(xhr.responseText || `upload failed (${xhr.status})`));
		};
		xhr.onerror = () => fail(new Error('upload failed'));
		xhr.onabort = () => {
			const error = new Error('upload aborted');
			error.name = 'AbortError';
			fail(error);
		};
		xhr.send(file);
	});
}
