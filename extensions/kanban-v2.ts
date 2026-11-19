// v2 agent adapter for pi: the SAME external contract v1 exposed — tools `kanban` then
// `deliverable`, and a `/kanban` command — backed by the v2 stack (SQLite state.sqlite,
// composite (project, id), timeline in the same tx).
//
// Enable with `"pi": { "extensions": ["./extensions/kanban-v2.ts"] }` in package.json.
// Enabling it next to v1 extensions/kanban.ts is not supported: both register a `kanban`
// tool and both want port 8789 (this one attaches instead of failing, but the tools collide).
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseCommandArgs } from "../src/core/command.ts";
import { WIDGET_KEY, footerLine, footerText } from "../src/agent/footer.ts";
import type { Feed } from "../src/agent/footer.ts";
import type { OverviewRow } from "../src/shared/dto.ts";

// Node strips types but does not rewrite NodeNext's `./x.js` specifiers onto the sibling
// `./x.ts`, so src/**/*.ts cannot be imported without this bridge (same as src/api/serve.ts).
registerHooks({
	resolve(specifier, context, nextResolve) {
		if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {
			const url = new URL(specifier, context.parentURL);
			const asJs = fileURLToPath(url);
			const asTs = `${asJs.slice(0, -3)}.ts`;
			if (!existsSync(asJs) && existsSync(asTs)) {
				return { url: pathToFileURL(asTs).href, shortCircuit: true };
			}
		}
		return nextResolve(specifier, context);
	},
});

type Adapter = typeof import("../src/agent/adapter.ts");

let adapter: Adapter | null = null;
let loading: Promise<Adapter> | null = null;

/** Loaded lazily (it pulls the SQLite/server stack in) and memoized for the process. */
function load(): Promise<Adapter> {
	loading ??= import("../src/agent/adapter.ts").then((m) => (adapter = m));
	return loading;
}

/** The tool's cwd; a context without getCwd (an older host, a test double) reads as ours. */
function cwdOfCtx(ctx: ExtensionContext): string {
	const sm = (ctx as { sessionManager?: { getCwd?: () => string } }).sessionManager;
	try {
		const cwd = sm?.getCwd?.();
		if (typeof cwd === "string" && cwd !== "") return cwd;
	} catch {
		// fall through to the process cwd
	}
	return process.cwd();
}

const KANBAN_CUSTOM_TYPE = "kanban-board";

const WIDGET_POLL_MS = 15_000;

// One footer per session: pi shares this module scope across every session in the same cwd.
const footers = new Map<string, { stop: () => void; draw: () => void }>();

/** The host's own session id, when it has one (a card added here links back to it). */
function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try {
		const id = (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.();
		if (typeof id === "string" && id !== "") return id;
	} catch {
		// no session manager: there is no id to record
	}
	return undefined;
}

/** Session id for the per-session footer; hosts without one share a single slot. */
function sessionKeyOf(ctx: ExtensionContext): string {
	return sessionIdOf(ctx) ?? "default";
}

/** A disposed ctx must never take the process down: setWidget throws on a dead UI. */
function safeWidget(ctx: ExtensionContext, content: string[] | undefined): void {
	try {
		ctx.ui.setWidget(WIDGET_KEY, content, { placement: "aboveEditor" });
	} catch {
		// dead ctx / host: the footer is cosmetic
	}
}

/** One project's row from the running server (the extension and the server share the process). */
async function footerFeed(slug: string): Promise<Feed> {
	const m = await load();
	const rt = await m.kanbanRuntime();
	const url = `${rt.url.replace(/\/+$/, "")}/api/overview`;
	const res = await fetch(url, { headers: rt.token === null ? {} : { authorization: `Bearer ${rt.token}` } });
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		return { kind: "api", tag: `API: ${res.status}` };
	}
	const body = (await res.json()) as { data?: { projects?: OverviewRow[] } };
	const row = body.data?.projects?.find((p) => p.projectId === slug);
	if (row === undefined) return { kind: "empty" };
	const line = footerLine(row);
	return line === "" ? { kind: "empty" } : { kind: "line", line };
}

/**
 * Poll the overview and keep one footer line for this session. The timer is unref'd, but a
 * session that ends must not leave a loopback fetch behind: `stop` is per session.
 */
function startFooter(ctx: ExtensionContext, cwd: string): { stop: () => void; draw: () => void } {
	let last: string | null = null;
	let slug: string | null = null;
	let busy = false;
	let stopped = false;
	const run = async (): Promise<void> => {
		try {
			// projectSlugOf shells out to git: resolve it once, not on every poll.
			slug ??= (await load()).projectSlugOf(cwd);
			const feed = await footerFeed(slug);
			if (stopped) return;
			// A failing API keeps the last numbers and names the failure.
			if (feed.kind === "line") last = feed.line;
			if (feed.kind === "empty") last = null;
			safeWidget(ctx, footerText(feed, last));
		} catch {
			// The server may not be up yet (first boot) or the home may be unreadable.
			if (!stopped) safeWidget(ctx, footerText({ kind: "api", tag: "API: DOWN" }, last));
		}
	};
	const draw = (): void => {
		if (busy || stopped) return;
		busy = true;
		void run().finally(() => {
			busy = false;
		});
	};
	draw();
	const timer = setInterval(draw, WIDGET_POLL_MS);
	timer.unref();
	return {
		stop: () => {
			stopped = true;
			clearInterval(timer);
			safeWidget(ctx, undefined);
		},
		draw,
	};
}

/** v1 `/kanban` subcommands that v2 has no backing for: answer, never add a card. */
const V1_ONLY = new Set(["loop", "pick", "take", "interval", "stuck", "maxloops", "priority"]);

const HELP =
	"/kanban <タスク内容>  TODO に追加（add は省略可）\n" +
	"/kanban add <タスク内容>  同じ（空のカードは作りません）\n" +
	"/kanban list  このプロジェクトの板を表示\n" +
	"/kanban move <id> <col>  列を移す（col は todo|doing|done）\n" +
	"/kanban remove <id>  カードを削除\n" +
	"/kanban check  DB/スキーマ/板の自己診断\n" +
	"/kanban digest [--since 7d]  期間の完了・成果物・コミットを Markdown 1 枚に（既定 7d、ISO も可）\n" +
	"/kanban url  ダッシュボードの URL（トークン付き）\n" +
	"/kanban resume  そのプロジェクトの自走ループを running にする（TODO を DOING へ送る・モデルは起こさない）\n" +
	"v1 の loop / pick / take / interval / stuck / maxloops / priority は v2 未実装（カードは作りません）\n" +
	"kanban ツール: list/add/move/remove/edit/check/url/img/ref（img は画像を media に取り込み添付、ref はカードの参照パス）\n" +
	"deliverable ツール: add/list/edit/remove/ref（見せたい出力はカードではなくこちら）\n" +
	"ボードは project（既定 = cwd のリポジトリ）/ global（読み取り専用の集約）。project=<slug> で明示指定\n" +
	"/kanban  このメニュー";

export default function kanbanV2Extension(pi: ExtensionAPI): void {
	// Warm the stack in the background: registration stays synchronous (pi collects tools at
	// load), and the first tool call awaits the same promise.
	void load()
		.then((m) => m.refreshInjection(process.cwd()))
		.catch(() => {
			// no DB yet (init not run): the tools report that when called
		});

	pi.registerTool({
		name: "kanban",
		label: "Kanban board (v2)",
		description:
			"Shared kanban board for this project: columns todo / doing / done, persisted in ~/.pi/kanban (v2 SQLite), shown in the GUI. Holds what you owe — one card per promise; done only when it actually works.\n" +
			"Actions: list reads; add creates (text, col, priority, labels, session, commit, blocked, nextFireAt); move sets col; edit rewrites text/priority/labels/session/commit/blocked/nextFireAt; remove deletes; check self-tests db/schema/home; edit also rewrites ref; resume starts the doing-loop (each tick moves the next TODO into DOING, WIP=1; it does not wake a model); url returns the token link; img copies a local image into the media store and attaches it; ref records a local path on the card.\n" +
			"A deliverable is not a card: it is a row in the belt under the board (deliverable tool). No column is called deliverable.\n" +
			"scope picks the board: project (default — the git root of the cwd, shared by every session in it) or global (read-only aggregate). Ids are per board, so a global id is always named as <project>/#<id>. project=<slug> selects a board explicitly instead of the cwd's.\n" +
			"Cards are (project, id) in v2: an id alone is only meaningful inside one board.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("add"),
				Type.Literal("move"),
				Type.Literal("remove"),
				Type.Literal("edit"),
				Type.Literal("check"),
				Type.Literal("resume"),
				Type.Literal("url"),
				Type.Literal("img"),
				Type.Literal("ref"),
			], { description: "What to do. add/move/edit/remove act on the selected board; img copies an image into the media store and attaches it." }),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("global")], {
					description: "Which board: project (default, this repo) or global (read-only aggregate).",
				}),
			),
			text: Type.Optional(Type.String({ description: "Card text. Required by add; edit replaces it (empty is an error). Over 500 chars keeps everything: the head becomes the title and the whole text the body." })),
			id: Type.Optional(Type.Number({ description: "Card id inside the selected board (ids are per board — see list). Not a deliverable id: the deliverable tool has its own space." })),
			col: Type.Optional(
				Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("done")], {
					description: "Target column: todo | doing | done (a custom column id is accepted too).",
				}),
			),
			nextFireAt: Type.Optional(
				Type.String({ description: "ISO 8601 or +90m/+3h/+1d. v2 has no fire-at loop, so it is stored as the card's due DATE (the time part is dropped). \"\" clears it." }),
			),
			blocked: Type.Optional(
				Type.Union([Type.String(), Type.Boolean()], { description: "Reason the card is blocked (true = \"blocked\", false or \"\" clears it)." }),
			),
			project: Type.Optional(
				Type.String({ description: "Board slug to act on instead of the cwd's (a-z 0-9 . _ -, lowercased). Not a tag on the card: in v2 the project IS the board." }),
			),
			session: Type.Optional(Type.String({ description: "Conversation tag on a card ([A-Za-z0-9._:@-]). \"\" clears it." })),
			commit: Type.Optional(Type.String({ description: "Commit sha, 7-40 hex, stored lowercase. \"\" clears it." })),
			labels: Type.Optional(
				Type.Union([Type.String(), Type.Array(Type.String())], { description: "Comma-separated string or an array. \"\" clears them." }),
			),
			image: Type.Optional(Type.String({ description: "Local path. img copies it into the media store and attaches it to the card; ref records the path on the card as-is." })),
			priority: Type.Optional(Type.Number({ description: "Integer -99..99, higher sorts first (default 0). Used by add and edit." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const m = await load();
			const out = await m.executeKanban(params, { cwd: cwdOfCtx(ctx), actor: "agent", sessionId: sessionIdOf(ctx) });
			// Keep the per-turn injection in step with the board this call just touched.
			void m.refreshInjection(cwdOfCtx(ctx)).catch(() => {});
			footers.get(sessionKeyOf(ctx))?.draw();
			return {
				content: [{ type: "text" as const, text: out.text }],
				details: out.details,
				...(out.ok ? {} : { isError: true }),
			};
		},
	});

	pi.registerTool({
		name: "deliverable",
		label: "Deliverables",
		description:
			"Output you want the user to see: a screenshot, a report, a video, a file. Shown in the belt under the board, not in a column - do not create a TODO card for output.\n" +
			"Actions: add posts one (text, optional ref/cardId); list shows them; edit rewrites the text; remove deletes it; ref stores a local path in place (not copied); img copies a local image into the media store and attaches it.\n" +
			"A deliverable is a row, not a card: no column, no owner, no phase. Ids are the deliverable space, so #3 here and card #3 are different things.\n" +
			"scope: project (default, this repo — or project=<slug>) or global (read-only aggregate; ids repeat per board, so a global listing names the board with each id).",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("add"),
					Type.Literal("list"),
					Type.Literal("edit"),
					Type.Literal("remove"),
					Type.Literal("img"),
					Type.Literal("ref"),
				],
				{ description: "What to do: add posts one, list shows them, edit rewrites the text, remove deletes it, ref records a path in place, img attaches a local image." },
			),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("global")], {
					description: "Which board: project (default, this repo) or global (read-only aggregate; every write is refused).",
				}),
			),
			id: Type.Optional(Type.Number({ description: "Deliverable id (deliverable space — not a card id; the same number can exist as a card). Required by edit/remove/ref/img." })),
			text: Type.Optional(Type.String({ description: "What the deliverable is. Required by add; edit replaces it (empty is an error)." })),
			title: Type.Optional(Type.String({ description: "Alias of text (v2 tool-contract spelling)." })),
			ref: Type.Optional(Type.String({ description: "Local path stored on the row in place (not copied). Relative paths are resolved against the session cwd. Used by add and ref." })),
			image: Type.Optional(Type.String({ description: "Local path for img (v1 alias of ref). img copies it into the media store." })),
			cardId: Type.Optional(Type.Number({ description: "Card this deliverable came from (same board). Optional." })),
			project: Type.Optional(Type.String({ description: "Board slug to act on instead of the cwd's." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const m = await load();
			const out = await m.executeDeliverable(params, { cwd: cwdOfCtx(ctx), actor: "agent" });
			footers.get(sessionKeyOf(ctx))?.draw();
			return {
				content: [{ type: "text" as const, text: out.text }],
				details: out.details,
				...(out.ok ? {} : { isError: true }),
			};
		},
	});

	pi.registerCommand("kanban", {
		description: "Add a card to this project's TODO, or: list / move / remove / check / url / resume / help",
		handler: async (args, ctx) => {
			const m = await load();
			const argv = parseCommandArgs(args);
			const head = argv[0];
			const cwd = cwdOfCtx(ctx);

			if (head === undefined || head === "help") {
				ctx.ui.notify(HELP);
				return;
			}
			if (head === "url") {
				const out = await m.executeKanban({ action: "url" }, { cwd, actor: "user" });
				ctx.ui.notify(out.ok ? `ダッシュボード: ${out.text}` : `kanban: ${out.text}`);
				return;
			}
			if (head === "check") {
				const out = await m.executeKanban({ action: "check" }, { cwd, actor: "user" });
				ctx.ui.notify(out.text);
				return;
			}
			if (head === "resume") {
				const out = await m.executeKanban({ action: "resume" }, { cwd, actor: "user" });
				ctx.ui.notify(out.text);
				footers.get(sessionKeyOf(ctx))?.draw();
				return;
			}
			if (head === "list") {
				const out = await m.executeKanban({ action: "list" }, { cwd, actor: "user" });
				ctx.ui.notify(out.text);
				return;
			}
			// v1 subcommands with no v2 counterpart must NOT become a card named after them.
			if (V1_ONLY.has(head)) {
				ctx.ui.notify(`/kanban ${head}: v2 には doing-loop / media が無いので未実装（カードは作りません）`);
				return;
			}
			if (head === "digest") {
				const rest = argv.slice(1);
				const since = rest[0] === "--since" ? rest[1] : rest[0];
				if (rest[0] === "--since" && since === undefined) {
					ctx.ui.notify("使い方: /kanban digest [--since 7d|36h|<ISO>]");
					return;
				}
				try {
					const out = await m.executeDigest({ since }, { cwd, actor: "user" });
					ctx.ui.notify(out.ok ? out.text : `kanban: ${out.text}`);
				} catch (err) {
					ctx.ui.notify(`kanban: ${err instanceof Error ? err.message : String(err)}`);
				}
				return;
			}
			if (head === "move") {
				const id = Number(argv[1]);
				const col = argv[2];
				if (!Number.isInteger(id) || id < 1 || col === undefined) {
					ctx.ui.notify("使い方: /kanban move <id> <todo|doing|done>");
					return;
				}
				const out = await m.executeKanban({ action: "move", id, col }, { cwd, actor: "user" });
				ctx.ui.notify(out.ok ? out.text : `kanban: ${out.text}`);
				footers.get(sessionKeyOf(ctx))?.draw();
				return;
			}
			if (head === "remove") {
				const id = Number(argv[1]);
				if (!Number.isInteger(id) || id < 1) {
					ctx.ui.notify("使い方: /kanban remove <id>");
					return;
				}
				const out = await m.executeKanban({ action: "remove", id }, { cwd, actor: "user" });
				ctx.ui.notify(out.ok ? out.text : `kanban: ${out.text}`);
				footers.get(sessionKeyOf(ctx))?.draw();
				return;
			}
			// Anything else is card text: `/kanban 買い物` and `/kanban add 買い物` are the same.
			const text = (head === "add" ? argv.slice(1) : argv).join(" ").trim();
			if (text.length === 0) {
				ctx.ui.notify("使い方: /kanban add <タスク内容>（空のカードは作りません）");
				return;
			}
			try {
				const out = await m.executeKanban({ action: "add", text }, { cwd, actor: "user" });
				ctx.ui.notify(out.ok ? out.text : `kanban: ${out.text}`);
				footers.get(sessionKeyOf(ctx))?.draw();
			} catch (err) {
				ctx.ui.notify(`kanban: ${err instanceof Error ? err.message : String(err)}`);
			}
			void m.refreshInjection(cwd).catch(() => {});
		},
	});

	// Warm the cache for the session that just started (the board may have changed while
	// this process was idle). Async on purpose: the handler returns nothing.
	pi.on("session_start", (_event, ctx) => {
		void load()
			.then((m) => m.refreshInjection(cwdOfCtx(ctx)))
			.catch(() => {});
		// A host without a UI has no footer: do not start a timer or a fetch for one.
		if ((ctx as { hasUI?: boolean }).hasUI === false) return;
		const key = sessionKeyOf(ctx);
		footers.get(key)?.stop();
		footers.set(key, startFooter(ctx, cwdOfCtx(ctx)));
	});

	// Per-turn injection: this cwd's project board as a request-only trailing message.
	// NOT a system-prompt section — mutating the system prompt on every board edit would
	// invalidate the provider prefix cache for the whole conversation. Global is never
	// injected. Empty board or an uninitialized home -> nothing appended.
	pi.on("before_agent_start", () => {
		const text = adapter?.injectionTextSync() ?? null;
		if (text === null) return;
		return { message: { customType: KANBAN_CUSTOM_TYPE, content: text, display: false } };
	});

	// The DB handle and the HTTP server are process-wide (shared by every session, like v1's),
	// so the footer's timer is the only per-session thing to stop — and only its own.
	pi.on("session_shutdown", (_event, ctx) => {
		const key = sessionKeyOf(ctx);
		footers.get(key)?.stop();
		footers.delete(key);
	});
}
