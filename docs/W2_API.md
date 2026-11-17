# W2 — phase-0 HTTP API

The v2 server is `src/api/**`: token gate → `/api/*` (JSON envelope) → static `web/dist`.
It never initializes or destroys a home; `start.ts` opens an existing v2 DB once and migrates
pending steps, and refuses to open anything else (the v1 layout is not touched).

## Run

```sh
node src/api/serve.ts            # Node >= 22.5, no build step (KANBAN_PORT / KANBAN_HOME honoured)
npm run serve:v2                 # same thing
node -e "…"                      # or: startServer({ home, port: 0 }) from src/api/start.ts
```

Binds `HOST_DEFAULT` (`0.0.0.0`) on `PORT_DEFAULT` (`8789`). `PORT=0` picks a free port (tests).

## A fresh home (no ceremony)

`startServer` initializes a home that is not v2 yet — missing, empty, or still holding a v1/partial
layout — and carries on. Nothing is deleted: the old home is **moved** to `<home>.v1.bak-<stamp>`
first, so the previous board is one `cp` away, and only *board data* counts as v1 (a home holding
just `token`/`server.log`, which v2 writes too, is simply empty). `startServer({ init: false })`
keeps the old behaviour: meta/selftest answer, every write is `503 INTERNAL` naming init. The CLI
`kanban init` remains for an explicit re-init.

## Auth

**Off by default.** The gate exists for the case where the board is reachable by something other than
the machine it runs on; on a tailnet-only box it cost more than it bought (a 64-hex token in the URL
of every bookmark). `KANBAN_AUTH=on` — or `startServer({ auth: true })` — turns it back on, and
`/api/meta` reports which way it is set as `data.auth: "off" | "token"`.

When on: token = `<kanbanHome>/token`. Accepted as cookie `kb_auth`, `Authorization: Bearer <t>`, or
`?token=<t>` — the query form only on `GET /` / `GET /index.html`, where it is exchanged for the
cookie (`HttpOnly; SameSite=Lax; Path=/; Max-Age=30d`). Every path, the UI shell included, is behind
the token: a missing/invalid one is `401 {"ok":false,"error":{"code":"UNAUTHORIZED"}}`.

Bootstrap path: `GET /?token=<t>` (documented above) is the only unauthenticated carrier.
Exception: when the home has **no token file** (not initialized), `GET /api/meta` and
`GET /api/selftest` answer anyway so the UI can say "run init"; every other request is 401 with a
message naming init and its confirmation requirement.

Writes additionally require a same-origin `Origin` when one is present (or `Sec-Fetch-Site` ≠
`cross-site`); a bare `curl` without `Origin` is allowed. Bodies are capped at 1 MiB.

## Routes

| method | path | notes |
| --- | --- | --- |
| GET | `/api/meta` | `version`, `buildHash` (web/dist/meta.json, else version+deps hash), `schemaVersion`, `capabilities` |
| GET | `/api/selftest` | `ok`, `db.ok/db.error`, `home{path,status,initialized}`, schema |
| GET | `/api/projects` | `{projects:[{projectId,slug,name}]}` |
| POST | `/api/projects` | `{slug?,name?}` → 201 `{project,columns}`; slug derived from name when absent; dup → 409 |
| DELETE | `/api/projects/:slug` | ボードを丸ごと削除（cards/columns/deliverables/attachments/views/templates/loop/locks は全行消える）。timeline は残る。200 `{deleted:{projectId,slug}}` / 404。削除後に同じ slug を作り直せるが、card id は 1 から振り直す |
| GET | `/api/board?project=` | `BoardSnapshot` (slug or id), 404 when unknown |
| GET | `/api/timeline?project=&limit=&since=` | `{events}` |
| POST | `/api/cards` | `{project,title,body?,columnId?,priority?,labels?,owner?,due?,estimate?,blockedReason?,ref?}` → 201 `{card}` |
| PATCH | `/api/cards/:project/:id` | `{version,...patch}` — stale version → 409 `STALE_VERSION`. Patches: `title,body,priority,labels,owner,due,estimate,blockedReason,ref,commit`. `lastActor` is read-only and is rejected as 422. |
| POST | `/api/cards/:project/:id/move` | `{columnId,version}` → `{card}` |
| DELETE | `/api/cards/:project/:id` | `{version?}` (or `?version=`) → `{deleted:{projectId,id}}` |
| PATCH | `/api/columns/:project/:id` | `{name?,wipLimit?,ord?}` → `{column}`. Lowering a limit under existing cards is allowed — over-WIP is an alert, not a delete. |
| GET | `/api/views?project=` | `{views:[{id,name,query,createdAt,updatedAt}]}` |
| POST | `/api/views` | `{project,name,query}` → 201 `{view}`; same name in one board → 409 |
| PATCH | `/api/views/:project/:id` | `{name?,query?}` → `{view}` |
| DELETE | `/api/views/:project/:id` | → `{deleted:{id}}` |
| GET | `/api/templates?project=` | `{templates}` |
| POST | `/api/templates` | `{project,name,title?,body?,columnId?,priority?,labels?,level?}` → 201 `{template}` |
| POST | `/api/templates/:project/:id` | `{columnId?}` → 201 `{card}` (instantiate) |
| DELETE | `/api/templates/:project/:id` | → `{deleted:{id}}` |
| GET | `/api/attachments?project=&cardId=|deliverableId=` | `{attachments}` |
| POST | `/api/attachments?project=&cardId=|deliverableId=&name=` | **raw request body** = file bytes. Images only (PNG/JPEG/GIF/WebP, magic-byte sniffed, ≤ 8 MiB); anything else → 422. Blobs are content-addressed in `<home>/media/att/`. |
| GET | `/api/attachments/:project/:id` | the bytes, `Content-Type` from the row, `nosniff`, `Content-Disposition: inline` |
| DELETE | `/api/attachments/:project/:id` | → `{deleted:{id}}`; the blob file is kept |
| GET | `/api/search?q=&project=&limit=` | `{hits:[{kind:'card'\|'deliverable',projectId,id,title,snippet}]}`; `#123` matches an id. `project` is **optional**: omitted means every board, and `limit` (default 50) is one budget over the merged, sorted set — boards are not cut to the limit before the merge. An explicit unknown `project` is still 404. |
| GET | `/api/notifications?project=` | `{notifications:[{level,kind,projectId,cardId?,columnId?,title,detail}],sink?}` — overdue / blocked / deps / wip / acceptance / stale / loop, worst level first. With `KANBAN_NOTIFY_SINK=file:<path>` the same items are appended as JSON Lines and `sink:{path,written,skipped}` says what happened; without it the `sink` key is absent entirely. A setting that is neither `off` nor `file:<path>` is 422. |
| GET | `/api/digest?project=&since=` | `{digest:{projectId,since,until,counts:{done,deliverables,commits},markdown}}` — one Markdown page for the window. `since` accepts `7d` / `36h` / `30m` or an ISO stamp; absent = `7d`; unparseable = 422. `done` counts `card.moved` events into a `done`-kind column inside the window, `deliverables` counts rows created inside it, `commits` counts cards carrying a commit hash whose `updatedAt` falls inside it. |
| GET | `/api/locks?project=` | `{locks:[{resource,owner,at,expiresAt}]}` — expired rows are reclaimed on read, so this never lists a dead lock |
| POST | `/api/locks` | `{project,resource,ttlSeconds?,owner?}` → 201 `{lock}`; held → 409 `CONFLICT` with `details.code = "LOCK_HELD"` (+ holder and expiry). `resource` is `[A-Za-z0-9._:-]` 1–64 chars, `ttlSeconds` 1..86400 (default 120), `owner` defaults to `ui`. |
| DELETE | `/api/locks/:resource?project=` | → `{released:boolean}`. Idempotent on purpose: a holder that retries release must not hit a 404 wall. |
| GET | `/api/graph?project=` | `{nodes,layer,edges}` — longest-path layering over the blocker chain |
| GET | `/api/overview` | `{projects:[{projectId,name,loop,columns:[{id,name,kind,count,wipLimit}],counts:{total,open,done,ready,blocked,overdue,wipOver}}]}` for every board |
| GET | `/api/loop?project=` | `{loop:{status:'idle'\|'running'\|'halted',haltReason,lastTickAt,ticks}}` |
| POST | `/api/loop/start` | `/stop` | `/tick` | `tick` → `{loop,ready?,card?}`; `start` resumes, `stop` halts. Timeline: `loop.resumed` / `loop.tick` / `loop.halted`. |

Statuses: 400 malformed body, 401 auth, 403 traversal/cross-origin write, 404 unknown project/card,
409 conflict/stale/WIP, 422 validation (bad slug, unknown column, bad priority, missing `version`, …).
`PATCH`/`move`/`DELETE` on a card require `version` (optimistic lock).
WIP limits are enforced on add and move with `core.wipError` (`409 WIP_LIMIT`); the default columns
ship with no limit.

## Static

`web/dist` only, resolved path must stay inside it, index fallback only for `/`. HTML is `no-store`,
assets `no-cache`. `HEAD` is served as `GET` without a body (API paths do not answer HEAD).

## Tests

`tests/integration/api-server.test.mjs` — real server on `port: 0` against a temp home: auth + cookie
bootstrap, meta/selftest, the full card slice with timeline and stale-version conflicts, WIP, static
+ traversal, and the uninitialized home.
`tests/integration/api-extras.test.mjs` — the management layer: columns, saved views, templates,
attachments (round-trip + nosniff + content hashing), card ref, search, notifications, graph, overview,
and the loop state machine. `node --test tests/integration/*.test.mjs`.
`tests/integration/api-search-actor.test.mjs` — cross-board search (one limit for the whole answer)
and the read-only `lastActor` projection. `tests/integration/api-digest.test.mjs` — the digest
window, its empty sections and its 422. `tests/integration/api-locks-sink.test.mjs` — the lock
endpoints and the notification sink (off by default, JSON Lines, 24h throttle).
`tests/integration/persistence-locks.test.mjs` — migration 3 in place on a filled v2 database,
plus one-holder-per-resource and expiry reclaim.

## Attachments and media

`src/media.ts` owns the blob store: `<home>/media/att/<sha256[0:32]>.<png|jpg|gif|webp>`.
Writes are deduplicated by content hash. `POST /api/attachments` reads the raw body (not multipart),
sniffs the magic bytes, and refuses anything that is not an image — an HTML file served from the same
origin as the app would be stored XSS. `GET` answers with `X-Content-Type-Options: nosniff`.

The agent adapter (`kanban img` / `deliverable img`) goes through the same store. Paths are resolved
against the project cwd, not the server's.

Attachment blobs live at `<home>/media/att/<sha256>.<ext>` and are **never garbage
collected**: deleting an attachment row leaves the blob behind (content-addressed, so a re-upload
of the same bytes reuses it). Prune `<home>/media/att` by hand if the directory matters.

## Loop

`loop_state` is one row per project (`PRIMARY KEY (project_id)`), so a halt on one board cannot
stop another. `POST /api/loop/tick` names the next ready card, or halts the board with
`ready なカードが無い`.

The **supervisor** (`src/supervisor.ts`) is the cross-board heartbeat: every
`SUPERVISOR_INTERVAL_MS` (15s) it ticks each project whose loop is `running` and leaves the rest
alone. `node src/api/serve.ts` turns it on with `KANBAN_LOOP_MS` (`0` disables); `startServer` only
starts one when asked (`{ loop: { intervalMs } }`), so tests stay quiet.

A tick that finds a ready card moves it to DOING and wakes its session: pi-web first
(`POST /api/agent/new` for a card with no session yet — pi-web mints the id and answers with it —
and `POST /api/agent/<id>` for a card that has one, which also reaches a session pi-web is already
running). Only when pi-web is unreachable — a refused connection or a 5xx — does the board spawn a
`pi -p` of its own. A 4xx, a timeout, and a 2xx that carries `success:false` all claim nothing and
start no process. That path is gated so two writers
never append to one JSONL: a lock file (`src/agent/session-lock.ts`) plus pi-web's
`runningSessionIds`, and — when either says nobody is there — a JSONL written in the last 120s,
the only sign a `pi` started outside pi-web leaves behind.

The tick also keeps the per-board "last tick / next card / why it stopped" that the UI's loop band
and the timeline (`loop.tick` / `loop.resumed` / `loop.halted`) read.

`POST /api/cards/:id/move` into a `doing` column wakes the card the same way. That wake is
fire-and-forget: a slow session start must not delay the drop, and a failed wake is logged rather
than turning the move into an error.

The prompt both paths send is the card's own text (`buildCardPrompt` in `src/agent/driver.ts`),
led by a `[kanban <slug>#<id>]` line. It rides in the user message, not a system header: a header
that changes every turn would miss the prompt cache each time. The tag is what lets the session
tell a card — which any session or the UI can write — from the human speaking now.

`tests/integration/loop-supervisor.test.mjs` pins the part that matters: a drained board halts
without stopping its neighbour, and `stop()` really stops the timer.

## Digest, sink, locks (tier A)

`src/core/digest.ts` is a pure renderer: rows in, Markdown out, `now` passed in. It reads the
board snapshot plus the `card.moved` events of the window, so a card that was finished and then
reopened still shows up once (the newest move wins) and a card that never moved does not appear
at all. `GET /api/digest` and `/kanban digest` share it, so the CLI and the HTTP answer cannot
drift.

`src/core/notify-sink.ts` is a side effect on a read: `GET /api/notifications` mirrors what it
just computed. Off by default (no `sink` key, no file). A slot is `project|kind|cardId|columnId`,
not the message text — renaming a card must not re-send the same overdue alert, and a genuinely
new card must get through immediately. Dedupe state lives in the sink file itself, so there is no
second source of truth and a restart does not forget.

`src/persistence/locks.ts` treats a lock as a row with an expiry, not a lease with a heartbeat:
whoever reads or takes a lock first deletes the expired ones. That keeps a crashed daemon from
wedging a board and needs no sweeper thread. The table arrives as migration 3
(`MIGRATIONS` in `src/persistence/migrations.ts`); a filled v2 database upgrades in place.
