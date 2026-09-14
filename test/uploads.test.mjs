import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, stat, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createGueyServer } from "../server.mjs";
import {
	absorbUploads,
	receiveHttpUpload,
	sanitizeUploadName,
	uniqueUploadName,
	filenameFromHeader,
	MAX_UPLOAD_BYTES,
	UPLOAD_TIMEOUT_MS,
} from "../native/uploads.mjs";
import { uploadPercent } from "../native/public/js/uploads.js";

function stubRuntime(cwd) {
	const events = new EventEmitter();
	const data = { cwd, sessionId: "up", busy: false, messages: [], failed: null };
	return {
		events,
		data,
		snapshot: () => data,
		async command() { return {}; },
		async close() {},
	};
}

async function withApp(options, fn) {
	const root = await mkdtemp(join(tmpdir(), "guey-uploads-http-"));
	const runtime = stubRuntime(options.cwd ?? root);
	const app = await createGueyServer({
		port: 0,
		host: "127.0.0.1",
		stateDir: join(root, "state"),
		runtime,
		product: "imperfect",
		...options,
	});
	try {
		const address = await app.listen();
		const base = `http://127.0.0.1:${address.port}`;
		await fn({ app, runtime, root, base, port: address.port, origin: base });
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
}

function rawUpload({ port, origin, filename, body, contentLength, extraHeaders = {}, pauseBeforeBody, abortAfter }) {
	return new Promise((resolve, reject) => {
		const payload = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
		const length = contentLength ?? payload.length;
		const sock = createConnection({ port, host: "127.0.0.1" }, () => {
			sock.write(
				`POST /upload HTTP/1.1\r\n` +
				`Host: 127.0.0.1:${port}\r\n` +
				`Origin: ${origin}\r\n` +
				`X-Filename: ${filename ?? "file"}\r\n` +
				`Content-Length: ${length}\r\n` +
				Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join("") +
				`\r\n`,
			);
			const sendBody = () => {
				if (payload.length) sock.write(payload);
			};
			if (pauseBeforeBody) setTimeout(sendBody, pauseBeforeBody);
			else sendBody();
			if (abortAfter != null) setTimeout(() => sock.destroy(), abortAfter);
		});
		let data = Buffer.alloc(0);
		sock.on("data", chunk => {
			data = Buffer.concat([data, chunk]);
			if (data.includes("\r\n\r\n")) sock.end();
		});
		sock.on("error", () => resolve({ status: 0, raw: data.toString("utf8") }));
		sock.on("close", () => {
			const raw = data.toString("utf8");
			const status = Number((raw.match(/^HTTP\/1\.\d (\d+)/) || [])[1] || 0);
			const split = raw.indexOf("\r\n\r\n");
			resolve({ status, raw, body: split >= 0 ? raw.slice(split + 4) : "" });
		});
		sock.setTimeout(3000, () => sock.destroy());
	});
}

describe("phone uploads", () => {
	it("writes attachments into cwd/uploads and names them in the prompt", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "guey-uploads-"));
		try {
			const text = absorbUploads("here", [
				{ name: "notes.txt", data: Buffer.from("hello").toString("base64") },
			], cwd);
			const dest = join(cwd, "uploads", "notes.txt");
			assert.equal(text, `here\n\n[uploaded file: ${dest}]`);
			assert.equal(await readFile(dest, "utf8"), "hello");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps a traversing name inside the uploads directory", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "guey-uploads-"));
		try {
			absorbUploads("", [{ name: "../../etc/passwd", data: "" }], cwd);
			assert.deepEqual(await readdir(join(cwd, "uploads")), ["passwd"]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("leaves the text alone when nothing is attached", () => {
		assert.equal(absorbUploads("plain", undefined, "/nonexistent"), "plain");
		assert.equal(absorbUploads("plain", [], "/nonexistent"), "plain");
	});

	it("supplies text for a prompt that is only an attachment", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "guey-uploads-"));
		try {
			const text = absorbUploads("", [{ name: "a.bin", data: "AAAA" }], cwd);
			assert.ok(text.trim().startsWith("[uploaded file:"));
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("http upload names and progress", () => {
	it("sanitizes traversal and keeps a unique original stem", () => {
		assert.equal(sanitizeUploadName("../../etc/passwd"), "passwd");
		assert.equal(filenameFromHeader("notes%20v2.txt"), "notes v2.txt");
		assert.match(uniqueUploadName("notes.txt", "deadbeef"), /^notes-deadbeef\.txt$/);
		assert.equal(uploadPercent(0, 100), "0%");
		assert.equal(uploadPercent(42, 100), "42%");
		assert.equal(uploadPercent(100, 100), "100%");
		assert.equal(uploadPercent(5, 0), "…");
		assert.equal(MAX_UPLOAD_BYTES, 1024 * 1024 * 1024);
		assert.ok(UPLOAD_TIMEOUT_MS > 300_000);
	});
});

describe("POST /upload", () => {
	it("streams original bytes to a unique path under cwd/uploads", async () => {
		await withApp({}, async ({ base, origin, runtime }) => {
			const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
			const first = await fetch(`${base}/upload`, {
				method: "POST",
				headers: { Origin: origin, "X-Filename": "shot.png", "Content-Type": "application/octet-stream" },
				body: png,
			});
			assert.equal(first.status, 200);
			const a = await first.json();
			assert.deepEqual(await readFile(a.path), png);
			assert.match(a.name, /^shot-[0-9a-f-]+\.png$/);
			assert.equal(a.size, png.length);
			const info = await stat(a.path);
			assert.equal(info.mode & 0o777, 0o600);

			const second = await fetch(`${base}/upload`, {
				method: "POST",
				headers: { Origin: origin, "X-Filename": "shot.png" },
				body: png,
			});
			const b = await second.json();
			assert.notEqual(a.path, b.path);
			const names = await readdir(join(runtime.data.cwd, "uploads"));
			assert.equal(names.filter(n => n.endsWith(".part")).length, 0);
			assert.equal(names.length, 2);
		});
	});

	it("refuses a missing origin, a foreign origin, and a declared oversized file", async () => {
		await withApp({ uploadMaxBytes: 16 }, async ({ app, base, origin }) => {
			assert.equal(app.server.requestTimeout, 0);
			assert.equal(app.server.headersTimeout, 60_000);
			assert.equal((await fetch(`${base}/upload`, { method: "POST", headers: { "X-Filename": "a.txt" }, body: "hi" })).status, 403);
			assert.equal((await fetch(`${base}/upload`, { method: "POST", headers: { Origin: "https://evil.example", "X-Filename": "a.txt" }, body: "hi" })).status, 403);
			const huge = await fetch(`${base}/upload`, {
				method: "POST",
				headers: { Origin: origin, "X-Filename": "big.bin", "Content-Length": "17" },
				body: Buffer.alloc(17),
			});
			assert.equal(huge.status, 413);
			assert.deepEqual(await readdir(join(app.runtime.snapshot().cwd, "uploads")).catch(() => []), []);
		});
	});

	it("keeps a traversing filename inside uploads and does not follow it out", async () => {
		await withApp({}, async ({ base, origin, runtime }) => {
			const res = await fetch(`${base}/upload`, {
				method: "POST",
				headers: { Origin: origin, "X-Filename": encodeURIComponent("../../etc/passwd") },
				body: "secret",
			});
			assert.equal(res.status, 200);
			const saved = await res.json();
			assert.equal(saved.path.startsWith(join(runtime.data.cwd, "uploads") + "/"), true);
			assert.doesNotMatch(saved.path, /\/etc\//);
			assert.equal(await readFile(saved.path, "utf8"), "secret");
		});
	});

	it("writes to the cwd frozen at request start if the focused tab changes", async () => {
		await withApp({}, async ({ port, origin, runtime, root }) => {
			const first = runtime.data.cwd;
			const moved = join(root, "other-tab");
			const result = await new Promise((resolve, reject) => {
				const sock = createConnection({ port, host: "127.0.0.1" }, () => {
					sock.write(
						`POST /upload HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nX-Filename: tab.txt\r\nContent-Length: 4\r\n\r\n`,
					);
					setTimeout(() => {
						runtime.data.cwd = moved;
						sock.write("keep");
					}, 40);
				});
				let data = "";
				sock.on("data", c => {
					data += c;
					if (data.includes("\r\n\r\n")) sock.end();
				});
				sock.on("close", () => resolve(data));
				sock.on("error", reject);
				sock.setTimeout(3000, () => sock.destroy());
			});
			const split = result.indexOf("\r\n\r\n");
			const saved = JSON.parse(result.slice(split + 4));
			assert.equal(saved.path.startsWith(join(first, "uploads")), true);
			assert.equal(await readFile(saved.path, "utf8"), "keep");
			assert.equal(runtime.data.cwd, moved);
		});
	});

	it("times out a stalled body and leaves no partial", async () => {
		await withApp({ uploadTimeoutMs: 80 }, async ({ port, origin, runtime }) => {
			const result = await rawUpload({
				port,
				origin,
				filename: "slow.bin",
				body: "",
				contentLength: 64,
				pauseBeforeBody: 400,
			});
			assert.equal(result.status, 408);
			const dir = join(runtime.data.cwd, "uploads");
			const names = await readdir(dir).catch(() => []);
			assert.deepEqual(names, []);
		});
	});

	it("cleans a dropped connection's partial file", async () => {
		await withApp({}, async ({ port, origin, runtime }) => {
			await rawUpload({
				port,
				origin,
				filename: "drop.bin",
				body: "partial",
				contentLength: 64,
				abortAfter: 20,
			});
			await new Promise(r => setTimeout(r, 50));
			const names = await readdir(join(runtime.data.cwd, "uploads")).catch(() => []);
			assert.equal(names.some(n => n.endsWith(".part")), false);
			assert.equal(names.length, 0);
		});
	});

	it("does not overwrite or delete an existing dest when the preferred name collides", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "guey-upload-collide-"));
		try {
			const dir = join(cwd, "uploads");
			await mkdir(dir, { recursive: true, mode: 0o700 });
			const existing = join(dir, "notes-fixed.txt");
			await writeFile(existing, "keep me", { mode: 0o600 });
			const req = Readable.from([Buffer.from("fresh")]);
			req.headers = { "content-length": "5", "x-filename": "notes.txt" };
			const saved = await receiveHttpUpload(req, { cwd, filename: "notes.txt", uniqueName: "notes-fixed.txt" });
			assert.notEqual(saved.path, existing);
			assert.equal(await readFile(existing, "utf8"), "keep me");
			assert.equal(await readFile(saved.path, "utf8"), "fresh");
			assert.match(saved.name, /^notes-[0-9a-f-]+\.txt$/);
			const leftovers = (await readdir(dir)).filter(n => n.endsWith(".part") || n.startsWith(".upload-"));
			assert.deepEqual(leftovers, []);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("filesystem failure does not kill the server", async () => {
		await withApp({}, async ({ base, origin, runtime }) => {
			const blocked = join(runtime.data.cwd, "uploads");
			await writeFile(blocked, "not a directory");
			const blockedRes = await fetch(`${base}/upload`, {
				method: "POST",
				headers: { Origin: origin, "X-Filename": "a.txt" },
				body: "hello",
			});
			assert.equal(blockedRes.status, 500);
			assert.equal((await fetch(`${base}/health`)).status, 200);
			await rm(blocked);
			await mkdir(blocked, { mode: 0o700 });
			await chmod(blocked, 0o500);
			try {
				const denied = await fetch(`${base}/upload`, {
					method: "POST",
					headers: { Origin: origin, "X-Filename": "b.txt" },
					body: "hello",
				});
				assert.equal(denied.status, 500);
				assert.equal((await fetch(`${base}/health`)).status, 200);
				assert.equal((await readdir(blocked)).some(n => n.endsWith(".part")), false);
			} finally {
				await chmod(blocked, 0o700);
			}
		});
	});
});
