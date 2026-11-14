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

## Auth

Token = `<kanbanHome>/token`. Accepted as cookie `kb_auth`, `Authorization: Bearer <t>`, or
`?token=<t>` — the query form only on `GET /` / `GET /index.html`, where it is exchanged for the
cookie (`HttpOnly; SameSite=Lax; Path=/; Max-Age=30d`). Everything, the UI shell included, is behind
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
| GET | `/api/board?project=` | `BoardSnapshot` (slug or id), 404 when unknown |
| GET | `/api/timeline?project=&limit=&since=` | `{events}` |
| POST | `/api/cards` | `{project,title,body?,columnId?,priority?,labels?,owner?,due?,estimate?,blockedReason?,ref?}` → 201 `{card}` |
| PATCH | `/api/cards/:project/:id` | `{version,...patch}` — stale version → 409 `STALE_VERSION` |
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
| GET | `/api/search?q=&project=` | `{hits:[{kind:'card'\|'deliverable',projectId,id,title,snippet}]}`; `#123` matches an id, **`project` is required** — search is per board (404 `MISSING_PROJECT` without it) |
| GET | `/api/notifications?project=` | `{items:[{level,kind,projectId,id,title,detail}]}` — overdue / blocked / deps / wip / acceptance, worst level first |
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

It drives **state, not agents**: no model is woken. What it buys you is a per-board
"last tick / next card / why it stopped" that moves on its own, which is what the UI's loop band
and the timeline (`loop.tick` / `loop.resumed` / `loop.halted`) read. Wiring an actual agent wake
on top of a tick is a separate decision — the record is the interface.

`tests/integration/loop-supervisor.test.mjs` pins the part that matters: a drained board halts
without stopping its neighbour, and `stop()` really stops the timer.
