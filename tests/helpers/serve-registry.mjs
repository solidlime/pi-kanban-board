// #53: the serve MCP tool is gone, but the /serve/* HTTP surface stays for old links.
// These tests used the tool's `add` as their only way to register a path, so this helper
// keeps the same rules (allowlist -> id -> serve.json) without the tool.
// 規則の写し元: extensions/kanban.ts の serveAdd / serveIdFor / serveAllowRoots / serveBaseUrl。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve, sep } from "node:path";

export const serveIdFor = (abs) => createHash("sha256").update(resolve(abs)).digest("hex").slice(0, 16);

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function allowRoots(kbDir) {
	const raw = readJson(join(kbDir, "serve-allow.json"));
	if (raw && Array.isArray(raw.roots)) {
		const roots = raw.roots.filter((r) => typeof r === "string" && r.length > 0);
		if (roots.length > 0) return roots.map((r) => resolve(r));
	}
	return [resolve(join(homedir(), "workspace"))];
}

const under = (abs, roots) =>
	roots.some((r) => {
		const base = r.endsWith(sep) ? r.slice(0, -1) : r;
		return abs === base || abs.startsWith(base + sep);
	});

/** serveBaseUrl(): KANBAN_BASE_URL -> serve-allow.json baseUrl -> learned host -> hostname. */
function baseUrl(kbDir) {
	const port = process.env.KANBAN_PORT ?? "8789";
	const allow = readJson(join(kbDir, "serve-allow.json"));
	const learned = readJson(join(kbDir, "serve-host.json"));
	const explicit = process.env.KANBAN_BASE_URL || (allow && allow.baseUrl) || "";
	if (typeof explicit === "string" && explicit.length > 0) {
		const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(explicit) ? explicit : `http://${explicit}`;
		try {
			const u = new URL(withScheme);
			// normalizeBaseUrl(): http(s) 以外と空ホストは「壊れた指定」として無視する。
			if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad scheme");
			if (u.hostname.length === 0) throw new Error("bad host");
			if (u.port === "") u.port = port;
			return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
		} catch {
			// malformed -> fall through to the learned/fallback host
		}
	}
	const host = learned && typeof learned.host === "string" && learned.host.length > 0 ? learned.host : hostname();
	return `http://${host}:${port}`;
}

const readRegistry = (kbDir) => {
	const raw = readJson(join(kbDir, "serve.json"));
	return raw && Array.isArray(raw.entries) ? raw.entries : [];
};
const writeRegistry = (kbDir, entries) => {
	mkdirSync(kbDir, { recursive: true });
	writeFileSync(join(kbDir, "serve.json"), JSON.stringify({ entries }, null, 2));
};

const expiresAt = (e) => {
	if (e && typeof e.expiresAt === "string") return Date.parse(e.expiresAt);
	if (e && e.permanent === true) return null;
	return e && typeof e.createdAt === "string" ? Date.parse(e.createdAt) + 7 * 24 * 60 * 60 * 1000 : null;
};
const isExpired = (e) => {
	const at = expiresAt(e);
	return at !== null && Number.isFinite(at) && at <= Date.now();
};
const urlFor = (kbDir, e) => {
	let dir = false;
	try {
		dir = statSync(e.path).isDirectory();
	} catch {
		// gone -> the bare id URL still 404s cleanly
	}
	return `${baseUrl(kbDir)}/serve/${e.id}${dir ? "/" : ""}`;
};

/** inbox-seen.json: { entryId: epochMs }. ack has no product path since #53 removed the
 * serve tool, but the watermarks it wrote are still read by the nudge line and /serve badge. */
const readSeen = (kbDir) => {
	const raw = readJson(join(kbDir, "inbox-seen.json"));
	const out = {};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
	return out;
};
const writeSeen = (kbDir, seen) => {
	mkdirSync(kbDir, { recursive: true });
	const path = join(kbDir, "inbox-seen.json");
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(seen, null, 2));
	renameSync(tmp, path);
};

/** inboxUnread(): files under <path>/_inbox newer than the entry's watermark. */
function inboxUnread(entry, seen) {
	const since = seen[entry.id] ?? 0;
	let names;
	try {
		names = readdirSync(join(entry.path, "_inbox"), { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const d of names) {
		let st;
		try {
			st = statSync(join(entry.path, "_inbox", d.name));
		} catch {
			continue;
		}
		if (!st.isFile() || st.mtimeMs <= since) continue;
		out.push({ name: d.name, mtime: st.mtimeMs });
	}
	return out.sort((a, b) => a.mtime - b.mtime);
}

/** serveCall(kbDir, args) — the subset of the old `serve` tool the HTTP tests drive. */
export function serveCall(kbDir, args) {
	const fail = (status, error) => ({
		isError: true,
		content: [{ type: "text", text: `serve ${args.action} failed (${status}): ${error}` }],
		details: { ok: false, status, error },
	});
	const ok = (text, details, hint = null) => ({
		content: hint === null ? [{ type: "text", text }] : [{ type: "text", text }, { type: "text", text: hint }],
		details,
	});

	if (args.action === "add") {
		const input = String(args.path ?? "").trim();
		if (!input.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(input)) return fail(400, "path must be absolute");
		const abs = resolve(input);
		if (!under(abs, allowRoots(kbDir))) return fail(403, `outside the serve allowlist: ${abs}`);
		if (!existsSync(abs)) return fail(404, `not found: ${abs}`);
		const id = serveIdFor(abs);
		const entries = readRegistry(kbDir);
		const existing = entries.find((e) => e.id === id);
		const entry = existing ?? { id, path: abs, createdAt: new Date().toISOString() };
		if (args.permanent === true) entry.permanent = true;
		if (typeof args.title === "string" && args.title.trim().length > 0) entry.title = args.title.trim().slice(0, 200);
		if (existing === undefined) writeRegistry(kbDir, [...entries, entry]);
		else writeRegistry(kbDir, entries);
		const url = urlFor(kbDir, entry);
		return ok(url, { ok: true, id: entry.id, path: entry.path, url });
	}
	if (args.action === "remove") {
		const input = String(args.id ?? args.path ?? "").trim();
		if (input.length === 0) return fail(400, "id or path is required");
		const entries = readRegistry(kbDir);
		const target = entries.some((e) => e.id === input) ? input : serveIdFor(resolve(input));
		const removed = entries.find((e) => e.id === target);
		if (removed === undefined) return fail(404, `not registered: ${input}`);
		writeRegistry(kbDir, entries.filter((e) => e.id !== target));
		return ok(`removed ${removed.path}`, { ok: true, id: removed.id, path: removed.path });
	}
	if (args.action === "ack") {
		const entries = readRegistry(kbDir);
		const seen = readSeen(kbDir);
		const targets = typeof args.id === "string" && args.id.length > 0 ? entries.filter((e) => e.id === args.id) : entries;
		if (targets.length === 0) return fail(404, `not registered: ${args.id}`);
		let acked = 0;
		for (const e of targets) {
			let unread = inboxUnread(e, seen);
			if (typeof args.name === "string" && args.name.length > 0) unread = unread.filter((u) => u.name === args.name);
			if (unread.length === 0) continue;
			seen[e.id] = unread[unread.length - 1].mtime;
			acked += unread.length;
		}
		writeSeen(kbDir, seen);
		return ok(`acked ${acked}`, { ok: true, acked });
	}
	const seen = readSeen(kbDir);
	const rows = readRegistry(kbDir)
		.filter((e) => existsSync(e.path) && !isExpired(e))
		.map((e) => ({ id: e.id, path: e.path, url: urlFor(kbDir, e), unread: inboxUnread(e, seen).length }));
	return ok(
		rows.length === 0
			? "no served paths"
			: rows.map((r) => `${r.url}\t${r.path}${r.unread > 0 ? ` (${r.unread} unread)` : ""}`).join("\n"),
		{ ok: true, entries: rows },
	);
}
