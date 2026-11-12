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

The model calls this directly. Actions are `list`, `add`, `move`, `remove`, `edit`, `check` (a self-diagnosis of the board, media directory, and mode files), `resume` (clear a doing-loop halt — the same door the dashboard's 再開 uses through `/api/resume`), `url` (the token-bearing dashboard link), `img` (copy a local file into `media/` and attach it to a card) and `ref` (attach by reference: the card stores `file:<path>`, nothing is copied). `schedule`, `blocked` and `priority` are parameters or `/kanban` subcommands, not actions.

`add` and `edit` take an optional `project` slug (`[A-Za-z0-9._-]`, case kept, cut to 24 chars) that tags a card. Slugs match case-insensitively (`Repos/App` and `repos/app` are one project), so the spelling you first wrote is the one on the board. An empty value clears it; anything else unnormalizable is rejected. To relabel a card, use `edit` with `project`, or `/api/schedule?project=`. `/api/upload` only reads `project` when it creates a card; uploading to an existing `id` leaves that card's label alone. A card project is only a label — the auto-pick loop never reads it.

`/api/add` also takes the board-metadata trio: `due=YYYY-MM-DD` (a date, never a time), `estimate=<integer >= 0>` (points), and `blocks=<id,id,...>` (cards this one blocks). Invalid values are a 400, never silently dropped. Dependencies are stored in their own `card_dep` table and rewritten with the board on every write; a self-reference or a cycle (`a blocks b blocks a`) is a 400.

Deliverables are not cards (#82). A card has three phases, `todo`/`doing`/`done`, and nothing else: `counts` therefore has three keys, a project's `total`/`done`/`progress`/`overdue` count cards only, and the loop never sees a deliverable (`nextTodo` reads TODO only, `doingHeadOf`/`tickCardFor` read DOING only). Deliverables live in their own table, `deliv`, keyed by board (`scope`,`sid`) and numbered per board from `deliv_next_id` — `max(id)+1` would re-issue the id of a removed row and silently overwrite the next one. Three routes write them and nothing else does: `GET /api/deliv/add?p=&text=`, `GET /api/deliv/edit?p=&id=&text=` and `GET /api/deliv/remove?p=&id=` (empty `text` is `400 text required`, an unknown `id` is `404`); remove moves the attachments to `.trash` first. The project payload carries `deliverables: Deliv[]` (`{id,text,img?,at}`), `/api/dashboard`'s `global.deliverables` carries the same rows with `sid`, and `deliverableCount` is that length. `/api/move` refuses `col=deliverable` (`400 deliverable is not a phase`) and `/api/add` no longer accepts it, so no new legacy row can be created; rows that still hold `col=deliverable` stay readable and can be moved out to todo/doing/done. The 「成果物」 band (`#deliverables`) at the bottom of the page is the only place deliverables appear: the band's `+` posts to `/api/deliv/add`, its heading opens the deliverable modal (no phase, priority, schedule or dependency fields; the header click and Esc behave as on a card), and the band and the modal keep their ids apart from the card's (`deliv #3` and `card #3` are different rows).

The model has a second tool for them (#92): `deliverable` (`add`/`list`/`edit`/`remove`/`img`/`ref`) posts the output a user should see — a screenshot, a report, a video — so it never has to become a TODO card. `kanban` stays for work you owe, and its `img`/`ref` attach to a card only. Both tools' ids are separate spaces: `deliverable`'s `#3` and card `#3` are different rows.

`project` and `decision` are global tables keyed by slug (a card's `project` is that slug). A decision keeps `why`, because a decision log without the reason is just a diary. Deleting a project takes its decisions with it in one transaction. Milestones and phases are not tables: a milestone is a card with a `due`, and a phase is a label that #7 decides how to attach.

`/api/projects` returns every project at once — declared, or merely named by a card nobody has declared — with progress **derived from the cards on every read**: done/total, points from `estimate`, an overdue count, milestones (its dated cards), blockers (its `blocked` cards) and its decision log. No percentage is stored, so moving a card is enough to move the number. `/api/project?project=<slug>&name=<name>` declares a project or renames one (no `name` means the slug); `/api/decision?project=<slug>&text=<what>&why=<why>` appends to the log and `/api/decision?action=delete&id=<n>` drops an entry — `id` only, a `project` sent with it is ignored. A decision with no project is returned in the payload's top-level `decisions` — the board-wide log that no per-project list can hold. `/api/projects` is a read; `/api/project` and `/api/decision` are writes.

### Dashboard

The extension starts an HTTP server on port 8789 the first time a session begins. Open `http://<host>:8789/` for the dashboard — it is the only view.

The dashboard has four tabs: ボード, プロジェクト, 週次 and 設定. The board tab is two rows, not a list of sessions — the board of this project (the server's cwd), and GLOBAL below it, which aggregates every project board and is read-only. Each row carries its own `loops` (the count used on that board) and `halted` flag, read from the session that owns the board (#110: a halt rides the session, not the board file), which is what 「残り N / 上限」 and the 再開 button read, so a stopped loop is visible on the row it belongs to and 再開 queues on that session instead of on whichever session happens to be the driver. That reach stops at the process: 再開 and 一時停止 only reach sessions of the pi process serving the dashboard, so if the board's owner runs in another process the request lands on the driver's board instead — queueing `queued:false` (nothing at all) when no driver is pinned. Inline card editing (double-click the body; `Shift+Enter` inserts a newline) is on the project board only: GLOBAL is read-only, so every write control on that row is disabled and the server answers a global write with 400. The project selector beside the search box filters the cards by `card.project` (including `(unassigned)`), and a card created while a project is selected inherits it. The totals in the header follow the filter, so "TODO 1/3" while a project is selected means one card of that project out of the three on the board.

The 検索 box (`/` focuses, `Esc` clears) looks at these and nothing else: 本文・#番号 (an exact `7` or `#7`, never a substring)・project・sid・session・commit・blocked・label. Internal fields (`img`, `estimate`, `col`, `blocks`, `priority`, `movedBy`) are deliberately left out: a value you cannot see on the card only produces hits you cannot explain. The placeholder in the HTML names the same vocabulary, and `tests/kanban-search-vocabulary.test.mjs` fails if `cardHit` grows a field that the wording does not cover.

### 週次

The 週次 tab is the weekly summary — nothing is asked of a model. When `poll()` notices the ISO week changed it writes one row for that week: the cards that finished (moved to DONE), the cards that went stale, and the cards that are `blocked`, grouped by project slug. `STALE_DAY_MS` decides stale, and the day count in the row is that same number, not a second opinion. The same sweep runs hourly, so a card moved after the last tick of a week is still counted in that week, and the week that just ended is finalized within the hour of the week change rather than at the boundary itself. `/api/weekly` returns the current week computed on the spot (so the tab never waits for a tick) plus the weeks that are stored; `/api/weekly?week=2026-W30` returns one stored week, and a value that is not a real ISO week (`2026-W54`) is a 400. A week with no stored row says so — it is not the same thing as a week with no cards.

### 添付（カードのファイル）

A card carries its own files (`card.img`, a comma-separated list of names under `~/.pi/kanban/media/`). Nothing is published by path any more: attach the file to the card it belongs to and it is fetched over the same server through `/api/media/<name>`.

```
/kanban img <id> <path>    attach a local file to card <id>
```

The dashboard upload button posts to `/api/upload` (`?id=<card>&ext=<ext>`, or `?deliv=<id>&ext=<ext>` for a deliverable — `deliv=` with an unknown id is a `404`, it does not fall back to creating a card); each upload **adds** to the row instead of replacing what is already there, so one card or deliverable can hold several images, videos and `.html` pages. Hover a tile in the 成果物 band and click the `×` to drop **one** entry: `/api/attach/del?p=<board>&deliv=<id>&n=<index>` (`id=<card>` for a card) removes that csv entry only. A referenced file (`file:<abs>`) stays where it is; a media name is moved to `.trash` unless another card **or deliverable** still shows the same file. Removing the last entry clears `img`, so the tile loses its preview (the row itself stays in the band, now without an attachment). Media is trashed wholesale when the row itself is deleted (`/api/remove` for a card, `/api/deliv/remove` for a deliverable, 7-day grace period, see below).

Accepted extensions are `png jpg gif webp avif mp4 webm mov html`. The per-file cap is 8MB (`KANBAN_MEDIA_MAX_BYTES` overrides it, videos get 64MB), and the whole `media/` directory has a 1GiB budget; over either limit `/api/upload` answers `413` and leaves the card untouched.

**Paste is the second way in.** Copy an image (⌘/Ctrl+C on a screenshot), then paste it anywhere on the dashboard: it lands on the card whose menu is open, otherwise on the arrow-key selected card, otherwise on a fresh TODO card named 「ペースト画像」. A clipboard `File` has no body to POST, so the image rides the query as a base64 dataURL — `GET /api/upload2?p=<board>&id=<card>&data=<dataURL>` (`deliv=<id>` for a deliverable) — which caps the payload at 128KB of dataURL (`413`), answers `415` for a MIME outside the list above or an `ext` that disagrees with it, and `404` for an unknown card. The dashboard HTML is generated at startup, so restart pi once after upgrading to get the paste handler.

An `.html` attachment opens in the dashboard's lightbox as an iframe preview. The server serves it with `Content-Security-Policy: sandbox allow-scripts allow-forms` and no `X-Frame-Options`, and the iframe itself carries `sandbox="allow-scripts allow-forms"` — no `allow-same-origin`, so the page cannot reach the dashboard's cookie or its origin. Inside that sandbox a three.js page loads its modules from a CDN the normal way, and `allow-forms` lets an interactive page (a questionnaire) submit **inside the frame**. Images and videos keep the thumbnail/video treatment they had.

A **referenced** attachment (`file:<abs>`) can also be a document, which keeps `mov` in the same video group and shows the rest in the same lightbox:

| extension | `/api/ref` returns | how the lightbox shows it |
|---|---|---|
| `html` | `text/html` + `Content-Security-Policy: sandbox allow-scripts allow-forms` | sandboxed iframe |
| `pdf` | `application/pdf` | iframe, no `sandbox` (a PDF viewer does not paint under it) |
| `md` `markdown` `txt` `log` `csv` `json` | `text/plain; charset=utf-8` | iframe, no `sandbox` |
| anything else | `application/octet-stream` | thumbnail and lightbox treat it as an image, so it may not render |

`.md` is served as `text/plain` rather than `text/markdown` because Chrome has no viewer for the latter and would download it; the inline `Content-Disposition` on every line of the table is what keeps the browser showing the file instead of saving it. Only `file:` entries can be documents — `.pdf`/`.md` are not in the upload allowlist, so `/api/media` never serves them.

### serve-allow.json

`~/.pi/kanban/serve-allow.json` decides what `/api/ref` and the `ref` tool may read, and where a served entry's inbox may write. Missing or `{}` means the default and the default is narrow: `~/workspace`, nothing else. `roots` **replaces** it wholesale (the default is not merged in), each entry is an absolute path (`~` is not expanded, a relative path resolves against pi's cwd), and an empty array is ignored rather than read as “everything”:

```json
{
  "roots": [
    "C:/Users/Owner/workspace",
    "D:/Code"
  ]
}
```

Forward slashes keep the JSON readable; a backslash path works too but has to be doubled (`"C:\\Users\\Owner\\workspace"`). The request path and the roots both go through `realpath` before the containment check, so a symlink inside a root is not a way out of it. The file is read on every request — an edit takes effect without a restart.

The optional `baseUrl` pins the host in emitted `/serve` links. `KANBAN_BASE_URL` wins over it, and the port comes from the server, so leave the port off:

```json
{ "baseUrl": "http://nas.local" }
```

### 双方向の添付（アンケート）

An attachment can talk back. `/api/ehr` is the only route that answers without the token, because the sandboxed iframe has an opaque origin and therefore no cookie. The old name `/api/quiz` stays as an alias to the same handler, so a page already attached under it keeps working (new rows land under `ehr:<card>`; answers written to `quiz:<card>` before the rename are still read):

```
GET  /api/ehr?id=<card>[&key=<name>]                  -> [{"at":..,"key":..,"value":..}, ...]
POST /api/ehr?id=<card>&key=<name>&value=<text>      -> {"ok":true,"count":N}
```

`value` is capped at 128KB (#63: a paint demo posts `canvas.toDataURL('image/png')` here, and a 640x360 png is 10-30KB base64 — 4KB could not carry a drawing), the card keeps the newest 50 answers (older ones drop), and both routes return `Access-Control-Allow-Origin: *` so the iframe can call them. The value travels in the query string, so the server raises node's 16KB request-line default to 4x the cap; a value over the cap is a `413`, and anything past that line budget is a `431` from node itself. The agent reads the answers with the same GET (`curl` with the token or without — this route only needs the host to be right).

Write the page so its `fetch` names the card, attach it by reference, and the dashboard shows it:

```html
<script>
document.getElementById('f').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  await fetch('/api/ehr?id=42&key=q1&value=' + encodeURIComponent(JSON.stringify({ q1: this.q1.value })),
              { method: 'POST' });
  document.getElementById('ok').textContent = '送信済み ✓';
});
</script>
```

```
/kanban ref 42 ~/workspace/quiz.html    attach the page (nothing is copied)
```

After a `pi-web` restart, open the dashboard, click the tile (the lightbox carries the same sandbox), fill the form and submit: the answers are then visible through `GET /api/ehr?id=42`.

Two worked examples live in `~/workspace/kanban-demo/` (not in this repo): `wizard.html` keeps its three steps in page state and sends one `JSON` under `key=wizard`, and `paint.html` draws on a 640x360 canvas and posts the png dataURL under `key=paint`. An agent turns that answer back into a file with `curl '.../api/ehr?id=66&key=paint' | jq -r '.[-1].value' | sed 's/^data:image\/png;base64,//' | base64 -d > /tmp/paint.png`.

**The restart is what matters**: the running `pi-web` keeps the code it started with, so a payload bigger than the *old* limits still fails with `431`/`413` until `pi-web` is restarted. Restart it, wait for `GET /api/ehr?id=<card>` to answer `200` again (that route needs no token), then submit from the tile — not before, or you are testing the previous build.

`/serve/<id>/...` still answers for entries already in `serve.json` (old links keep working, expiry and `410 Gone` included), but the `serve` tool that registered them is gone: cards are the only way to show a file now.

## Where state lives

```
~/.pi/kanban/
├── boards.sqlite        every board, card and deliverable (WAL; one write lock per change,
│                        so several pi processes can share a board)
├── modes.json           per-board loop/pick/interval settings
├── serve.json           legacy served paths (no registration path since #53)
├── serve-allow.json     path allowlist for /api/ref
├── serve-host.json      the host the last serve used
├── media/               files attached to cards and deliverables
├── token                the secret every HTTP route requires (0600)
├── server.log           HTTP server log
└── dashboard.html       generated dashboard
```

Everything except the database and `media/` is plain JSON on disk. Nothing leaves the machine.

Since #17 there is no per-session board: a pi session ID is only an *actor* (it is what `movedBy` and the move log record), never a board key. On startup the extension runs the scope reset once, which deletes every non-project board row and keeps the project ones — `boards.sqlite.pre-scope-reset` holds the copy taken first, so the old rows can be recovered from it. Project boards survive the reset untouched.

## Debugging the loop

The autonomous loop decides once every 1.5s whether to wake the agent. Set `KANBAN_DEBUG=1` to get one `kanban: poll ... => fire|skip:<reason>` line per tick on stderr; unset, the loop stays silent. `~/.pi/kanban/server.log` keeps the HTTP side (bind, reuse, API down); a rejected wake shows up there as `wake rejected: ...`.

The interval is measured from **the last injection** (the last poll wake, or the last continuation the settle chain pushed), not from the last board revision: a board nobody touches still gets its continuation every interval, and a `nextFireAt` wake that pi rejected does not count as injected, so the schedule stays armed. With auto-pick on, keep the interval comfortably above one turn — the poll cannot tell "my own continuation is still being processed" from "the user is idle", so a very short interval stacks a wake behind the turn you are already running (the wake re-fires once pi is idle again).

#94: a TODO added with the dashboard's 「+」 (one line or several) does not wait for that interval — the next poll of that board wakes once with `forced` (`KANBAN_DEBUG` trace: `=> fire:forced`). Only the interval and quiet gates open: a halted or switched-off loop still stays down, and a busy agent is still not interrupted. The cue is kept until it fires, so a busy turn, an open dialog or a halt only delays the wake; after five minutes the cue expires and the normal interval takes over.

## Security notes

The HTTP server binds `0.0.0.0`, so every data route (`/api/*`, `/serve/*`) requires a token: 64 hex chars in `~/.pi/kanban/token`, generated on first start with mode `0600` in a `0700` dir. Mutating endpoints are `GET`-reachable so the board works from a plain browser tab, so the token — not the verb — is what guards them.

Get the URL with `/kanban url` (or the `kanban` tool's `url` action) and open it once: `GET /?token=<t>` sets an `HttpOnly` `kb_auth` cookie and redirects to the bare `/`, so the secret stays out of the page and out of your history after that. `/` itself is always served — opening it without the cookie shows the board, whose fetch gets a 401 and puts up a banner telling you where to get the URL. Scripts can pass `?token=<t>` on any `/api/*` call.

The `Sec-Fetch-Site` / `Origin` checks from #68 are still there as a second layer: a cross-origin page is refused with 403 even when it somehow has the token. Do not port-forward 8789 to the internet.

The verb is a layer too (#80-⑥): the sixteen `GET`-reachable write routes (`/api/add`, `/api/move`, `/api/remove`, `/api/rename`, `/api/deliv/add`, `/api/deliv/edit`, `/api/deliv/remove`, `/api/modes`, `/api/interval`, `/api/stuck`, `/api/maxloops`, `/api/resume`, `/api/priority`, `/api/schedule`, `/api/project`, `/api/decision`) plus `/api/serve`, `/api/upload`, `/api/upload2`, `/api/host` and `/api/selftest` answer `405 {"ok":false,"error":"method not allowed"}` to a `GET` whose `Sec-Fetch-Site` is present and not `same-origin` — that is a pasted URL, a bookmark (`none`), a link in another site (`cross-site`/`same-site`), i.e. exactly the prefetch that a chat unfurl or a URL scanner makes. The dashboard's own clicks (`same-origin`) are unaffected. **Provisional:** a request with no `Sec-Fetch-Site` at all still goes through, because curl, older browsers and a sibling pi send none; that gap closes when `Sec-Fetch-*` is universal.

The first layer is a **Host allowlist** (#80-⑨), checked before the token: a request whose `Host` is not `localhost`, `127.0.0.1`, `::1`, this machine's hostname, one of its interface addresses, or a name listed in `KANBAN_HOSTS` (comma-separated) gets `403 {"ok":false,"error":"host not allowed"}`. This is what stops DNS rebinding — the browser sends the attacker's domain as `Host`, so the cookie is never even read. Reaching the board under a name no interface carries (a MagicDNS name, a reverse-proxy host, a name in someone's `/etc/hosts`) needs `KANBAN_HOSTS=<name>,<name>`; the interfaces are read per request, so a new VPN or container address needs no restart, only the env var does.

## Nothing here is a service

There is no daemon. The HTTP server lives inside the pi process, so board state is available exactly as long as pi is running. The generated HTML is written once at startup. Its source is `web/dash/` - see below.

## Working on the code

The dashboard used to be a 1,500-line template literal inside the extension. It is now split:

```
web/dash/_head.html     the page shell (markup)
web/dash/_a|_b|_c.css   the styles, in cascade order
web/dash/_app.js        the dashboard script
web/md.js               card-body markdown renderer, inlined into the page
web/memory.js           column scroll / open-card memory, inlined into the page
web/dashboard.html      build artifact: dash/ assembled - committed, never edited by hand
scripts/build-web.mjs   assembles the above into web/dashboard.html and extensions/dashboard.generated.ts
```

npm run build assembles `web/dash/` into `web/dashboard.html` and then regenerates extensions/dashboard.generated.ts. prepack runs it; pretest only checks it (--check) and fails when the file is stale. The generated file is committed because the published package ships only extensions/ and pi loads extensions/kanban.ts straight off disk - it cannot build at install time. Edit web/, never the generated file.

npm test runs the whole suite with no dependencies beyond Node itself.

## License

MIT
