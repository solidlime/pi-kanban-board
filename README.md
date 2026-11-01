# pi-kanban-board

A kanban board for [pi](https://github.com/earendil-works/pi) that the agent keeps in sync with its own work.

Long sessions lose the thread: the goal drifts, an earlier decision gets forgotten, and the model starts re-litigating things it already settled. A board fixes that by putting the plan somewhere both the human and the model read from — the agent updates it as work moves, and the board is injected back into the conversation every turn. A board belongs to a **project** (the cwd's git root), so every session opened in that repo sees the same one.

## What you get

- **A board the model maintains.** The `kanban` tool is the model's handle: add, move, remove, schedule, attach images, record why something is blocked.
- **A live dashboard.** An HTTP dashboard at `http://<host>:8789/` covering this project's board plus a GLOBAL row that aggregates every project board at once, with per-board loop and pick toggles.
- **An autonomous loop.** With the loop on, pi wakes itself when a card sits in DOING, continues the work, and moves the card when it is done. Optional auto-pick pulls the next TODO in when nothing is in flight.
- **Two layers.** A per-project board (where cards live) and GLOBAL, a read-only aggregate over every project board: it shows them without holding any cards of its own.

## Install

```bash
pi install npm:pi-kanban-board
```

Or pin a version:

```bash
pi install npm:pi-kanban-board@0.1.0
```

From a git checkout instead:

```bash
pi install git:github.com/solidlime/pi-kanban-board@v0.1.0
```

To try it without touching your settings:

```bash
pi -e npm:pi-kanban-board
```

## Use

### Slash command

```
/kanban                    show the board
/kanban add <text>         add a card to this project's TODO
/kanban done <id>          move a card to DONE
/kanban loop on|off        toggle the autonomous loop for this board
/kanban pick on|off        toggle auto-pick for this board
/kanban interval <min>     set the loop interval (1 minute minimum)
/kanban maxloops [global] <n>  doing-loop budget (0 = unlimited, default 10)
/kanban status             loop state, intervals, counts
/kanban url                the token-bearing dashboard URL to open
```

### The `kanban` tool

The model calls this directly. Actions include `list`, `add`, `move`, `remove`, `schedule`, `blocked`, `priority`, and `check` (a self-diagnosis of the board, serve registry, media directory, and mode files).

`add` and `edit` take an optional `project` slug (`[A-Za-z0-9._-]`, case kept, cut to 24 chars) that tags a card. Slugs match case-insensitively (`Repos/App` and `repos/app` are one project), so the spelling you first wrote is the one on the board. An empty value clears it; anything else unnormalizable is rejected. To relabel a card, use `edit` with `project`, or `/api/schedule?project=`. `/api/upload` only reads `project` when it creates a card; uploading to an existing `id` leaves that card's label alone. A card project is only a label — the auto-pick loop never reads it.

`/api/add` also takes the board-metadata trio: `due=YYYY-MM-DD` (a date, never a time), `estimate=<integer >= 0>` (points), and `blocks=<id,id,...>` (cards this one blocks). Invalid values are a 400, never silently dropped. Dependencies are stored in their own `card_dep` table and rewritten with the board on every write; a self-reference or a cycle (`a blocks b blocks a`) is a 400.

`project` and `decision` are global tables keyed by slug (a card's `project` is that slug). A decision keeps `why`, because a decision log without the reason is just a diary. Deleting a project takes its decisions with it in one transaction. Milestones and phases are not tables: a milestone is a card with a `due`, and a phase is a label that #7 decides how to attach.

`/api/projects` returns every project at once — declared, or merely named by a card nobody has declared — with progress **derived from the cards on every read**: done/total, points from `estimate`, an overdue count, milestones (its dated cards), blockers (its `blocked` cards) and its decision log. No percentage is stored, so moving a card is enough to move the number. `/api/project?project=<slug>&name=<name>` declares a project or renames one (no `name` means the slug); `/api/decision?project=<slug>&text=<what>&why=<why>` appends to the log and `/api/decision?action=delete&id=<n>` drops an entry — `id` only, a `project` sent with it is ignored. A decision with no project is returned in the payload's top-level `decisions` — the board-wide log that no per-project list can hold. `/api/projects` is a read; `/api/project` and `/api/decision` are writes.

### Dashboard

The extension starts an HTTP server on port 8789 the first time a session begins. Open `http://<host>:8789/` for the dashboard — it is the only view.

The dashboard has four tabs: ボード, プロジェクト, 週次 and 設定. The board tab is two rows, not a list of sessions — the board of this project (the server's cwd), and GLOBAL below it, which aggregates every project board and is read-only. Each row carries its own `loops` (the count this session has used on that board) and `halted` flag, which is what 「残り N / 上限」 and the 再開 button read, so a stopped loop is visible on the row it belongs to. Inline card editing (double-click the body; `Shift+Enter` inserts a newline) is on the project board only: GLOBAL is read-only, so every write control on that row is disabled and the server answers a global write with 400. The project selector beside the search box filters the cards by `card.project` (including `(unassigned)`), and a card created while a project is selected inherits it. The totals in the header follow the filter, so "TODO 1/3" while a project is selected means one card of that project out of the three on the board.

The 検索 box (`/` focuses, `Esc` clears) looks at these and nothing else: 本文・#番号 (an exact `7` or `#7`, never a substring)・project・sid・session・commit・blocked・label. Internal fields (`img`, `estimate`, `col`, `blocks`, `priority`, `movedBy`) are deliberately left out: a value you cannot see on the card only produces hits you cannot explain. The placeholder in the HTML names the same vocabulary, and `tests/kanban-search-vocabulary.test.mjs` fails if `cardHit` grows a field that the wording does not cover.

### 週次

The 週次 tab is the weekly summary — nothing is asked of a model. When `poll()` notices the ISO week changed it writes one row for that week: the cards that finished (moved to DONE), the cards that went stale, and the cards that are `blocked`, grouped by project slug. `STALE_DAY_MS` decides stale, and the day count in the row is that same number, not a second opinion. The same sweep runs hourly, so a card moved after the last tick of a week is still counted in that week, and the week that just ended is finalized within the hour of the week change rather than at the boundary itself. `/api/weekly` returns the current week computed on the spot (so the tab never waits for a tick) plus the weeks that are stored; `/api/weekly?week=2026-W30` returns one stored week, and a value that is not a real ISO week (`2026-W54`) is a 400. A week with no stored row says so — it is not the same thing as a week with no cards.

### Serve

Files can be published through the board and fetched over the same server:

```
/kanban serve <path>       publish a file or directory
```

Served entries expire after 7 days by default. Mark one `permanent` to keep it. Expired entries answer `410 Gone` rather than `404`, so a client can tell "removed" from "never existed".

The `serve` tool also takes an optional `title`, which the dashboard shows above the URL. It is free-form and may be omitted — an entry without one renders as URL only.

## Where state lives

```
~/.pi/kanban/
├── global.json          global view (read-only; no cards of its own)
├── projects/<slug>.json per-project board (where cards live)
├── modes.json           per-board loop/pick/interval settings
├── serve.json           published files
├── media/               images attached to cards
├── token                the secret every HTTP route requires (0600)
├── server.log           HTTP server log
└── dashboard.html       generated dashboard
```

The boards themselves live in one SQLite file, `boards.sqlite`; the rest is plain JSON on disk. Nothing leaves the machine.

Since #17 there is no per-session board: a pi session ID is only an *actor* (it is what `movedBy` and the move log record), never a board key. On startup the extension runs the scope reset once, which deletes every non-project board row and keeps the project ones — `boards.sqlite.pre-scope-reset` holds the copy taken first, so the old rows can be recovered from it. Project boards survive the reset untouched.

## Debugging the loop

The autonomous loop decides once every 1.5s whether to wake the agent. Set `KANBAN_DEBUG=1` to get one `kanban: poll ... => fire|skip:<reason>` line per tick on stderr; unset, the loop stays silent. `~/.pi/kanban/server.log` keeps the HTTP side (bind, reuse, API down); a rejected wake shows up there as `wake rejected: ...`.

## Security notes

The HTTP server binds `0.0.0.0`, so every data route (`/api/*`, `/serve/*`) requires a token: 64 hex chars in `~/.pi/kanban/token`, generated on first start with mode `0600` in a `0700` dir. Mutating endpoints are `GET`-reachable so the board works from a plain browser tab, so the token — not the verb — is what guards them.

Get the URL with `/kanban url` (or the `kanban` tool's `url` action) and open it once: `GET /?token=<t>` sets an `HttpOnly` `kb_auth` cookie and redirects to the bare `/`, so the secret stays out of the page and out of your history after that. `/` itself is always served — opening it without the cookie shows the board, whose fetch gets a 401 and puts up a banner telling you where to get the URL. Scripts can pass `?token=<t>` on any `/api/*` call.

The `Sec-Fetch-Site` / `Origin` checks from #68 are still there as a second layer: a cross-origin page is refused with 403 even when it somehow has the token. Do not port-forward 8789 to the internet.

The verb is a layer too (#80-⑥): the thirteen `GET`-reachable write routes (`/api/add`, `/api/move`, `/api/remove`, `/api/rename`, `/api/modes`, `/api/interval`, `/api/stuck`, `/api/maxloops`, `/api/resume`, `/api/priority`, `/api/schedule`, `/api/project`, `/api/decision`) plus `/api/serve`, `/api/upload`, `/api/host` and `/api/selftest` answer `405 {"ok":false,"error":"method not allowed"}` to a `GET` whose `Sec-Fetch-Site` is present and not `same-origin` — that is a pasted URL, a bookmark (`none`), a link in another site (`cross-site`/`same-site`), i.e. exactly the prefetch that a chat unfurl or a URL scanner makes. The dashboard's own clicks (`same-origin`) are unaffected. **Provisional:** a request with no `Sec-Fetch-Site` at all still goes through, because curl, older browsers and a sibling pi send none; that gap closes when `Sec-Fetch-*` is universal.

The first layer is a **Host allowlist** (#80-⑨), checked before the token: a request whose `Host` is not `localhost`, `127.0.0.1`, `::1`, this machine's hostname, one of its interface addresses, or a name listed in `KANBAN_HOSTS` (comma-separated) gets `403 {"ok":false,"error":"host not allowed"}`. This is what stops DNS rebinding — the browser sends the attacker's domain as `Host`, so the cookie is never even read. Reaching the board under a name no interface carries (`nas`, a MagicDNS name, a reverse-proxy host) needs `KANBAN_HOSTS=nas,...`; the interfaces are read per request, so a new tailscale/docker address needs no restart, only the env var does.

## Nothing here is a service

There is no daemon. The HTTP server lives inside the pi process, so board state is available exactly as long as pi is running. The generated HTML is written once at startup. Its source is `web/dashboard.html` - see below.

## Working on the code

The dashboard used to be a 1,500-line template literal inside the extension. It is now split:

```
web/dashboard.html      the page itself (markup, script, style)
web/md.js               card-body markdown renderer, inlined into the page
web/memory.js           column scroll / open-card memory, inlined into the page
scripts/build-web.mjs   inlines the three into extensions/dashboard.generated.ts
```

npm run build regenerates extensions/dashboard.generated.ts. prepack runs it; pretest only checks it (--check) and fails when the file is stale. The generated file is committed because the published package ships only extensions/ and pi loads extensions/kanban.ts straight off disk - it cannot build at install time. Edit web/, never the generated file.

npm test runs the whole suite with no dependencies beyond Node itself.

## License

MIT
