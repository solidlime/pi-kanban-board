# pi-kanban-board

A kanban board for [pi](https://github.com/earendil-works/pi) that the agent keeps in sync with its own work.

Long sessions lose the thread: the goal drifts, an earlier decision gets forgotten, and the model starts re-litigating things it already settled. A board fixes that by putting the plan somewhere both the human and the model read from — the agent updates it as work moves, and the board is injected back into the conversation every turn.

## What you get

- **A board the model maintains.** The `kanban` tool is the model's handle: add, move, remove, schedule, attach images, record why something is blocked.
- **A live dashboard.** An HTTP dashboard at `http://<host>:8789/` covering every session on the machine, with per-board loop and pick toggles.
- **An autonomous loop.** With the loop on, pi wakes itself when a card sits in DOING, continues the work, and moves the card when it is done. Optional auto-pick pulls the next TODO in when nothing is in flight.
- **Two layers.** A per-session board and a GLOBAL board shared by every session, so work handed between sessions survives.

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
/kanban add <text>         add a card to this session's TODO
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

`add` and `edit` take an optional `project` slug (lowercase `[a-z0-9._-]`, cut to 24 chars) that tags a card. An empty value clears it; anything else unnormalizable is rejected. To relabel a card, use `edit` with `project`, or `/api/schedule?project=`. `/api/upload` only reads `project` when it creates a card; uploading to an existing `id` leaves that card's label alone. A card project is only a label — the auto-pick loop never reads it.

### Dashboard

The extension starts an HTTP server on port 8789 the first time a session begins. Open `http://<host>:8789/` for the dashboard — it is the only view.

The dashboard shows sessions, agents, and served files in tabs, with per-board loop and pick toggles, live counters, and inline card editing (double-click the body; `Shift+Enter` inserts a newline). The project selector beside the search box filters every board by project (including `(unassigned)`), and a card created while a project is selected inherits it. The session totals in the header follow the filter, so "TODO 1/3" while a project is selected means one card of that project out of the three cards in that session.

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
├── global.json          shared board
├── sessions/<sid>.json  per-session board
├── modes.json           per-board loop/pick/interval settings
├── serve.json           published files
├── media/               images attached to cards
├── token                the secret every HTTP route requires (0600)
├── server.log           HTTP server log
└── dashboard.html       generated dashboard
```

State is plain JSON on disk. Nothing leaves the machine.

## Debugging the loop

The autonomous loop decides once every 1.5s whether to wake the agent. Set `KANBAN_DEBUG=1` to get one `kanban: poll ... => fire|skip:<reason>` line per tick on stderr; unset, the loop stays silent. `~/.pi/kanban/server.log` keeps the HTTP side (bind, reuse, API down); a rejected wake shows up there as `wake rejected: ...`.

## Security notes

The HTTP server binds `0.0.0.0`, so every data route (`/api/*`, `/serve/*`) requires a token: 64 hex chars in `~/.pi/kanban/token`, generated on first start with mode `0600` in a `0700` dir. Mutating endpoints are `GET`-reachable so the board works from a plain browser tab, so the token — not the verb — is what guards them.

Get the URL with `/kanban url` (or the `kanban` tool's `url` action) and open it once: `GET /?token=<t>` sets an `HttpOnly` `kb_auth` cookie and redirects to the bare `/`, so the secret stays out of the page and out of your history after that. `/` itself is always served — opening it without the cookie shows the board, whose fetch gets a 401 and puts up a banner telling you where to get the URL. Scripts can pass `?token=<t>` on any `/api/*` call.

The `Sec-Fetch-Site` / `Origin` checks from #68 are still there as a second layer: a cross-origin page is refused with 403 even when it somehow has the token. Do not port-forward 8789 to the internet.

The verb is a layer too (#80-⑥): the eleven `GET`-reachable write routes (`/api/add`, `/api/move`, `/api/remove`, `/api/rename`, `/api/modes`, `/api/interval`, `/api/stuck`, `/api/maxloops`, `/api/resume`, `/api/priority`, `/api/schedule`) plus `/api/serve`, `/api/upload`, `/api/host` and `/api/selftest` answer `405 {"ok":false,"error":"method not allowed"}` to a `GET` whose `Sec-Fetch-Site` is present and not `same-origin` — that is a pasted URL, a bookmark (`none`), a link in another site (`cross-site`/`same-site`), i.e. exactly the prefetch that a chat unfurl or a URL scanner makes. The dashboard's own clicks (`same-origin`) are unaffected. **Provisional:** a request with no `Sec-Fetch-Site` at all still goes through, because curl, older browsers and a sibling pi send none; that gap closes when `Sec-Fetch-*` is universal.

The first layer is a **Host allowlist** (#80-⑨), checked before the token: a request whose `Host` is not `localhost`, `127.0.0.1`, `::1`, this machine's hostname, one of its interface addresses, or a name listed in `KANBAN_HOSTS` (comma-separated) gets `403 {"ok":false,"error":"host not allowed"}`. This is what stops DNS rebinding — the browser sends the attacker's domain as `Host`, so the cookie is never even read. Reaching the board under a name no interface carries (`nas`, a MagicDNS name, a reverse-proxy host) needs `KANBAN_HOSTS=nas,...`; the interfaces are read per request, so a new tailscale/docker address needs no restart, only the env var does.

## Nothing here is a service

There is no daemon. The HTTP server lives inside the pi process, so board state is available exactly as long as pi is running. The generated HTML is rewritten on each render. Its source is `web/dashboard.html` - see below.

## Working on the code

The dashboard used to be a 1,500-line template literal inside the extension. It is now split:

```
web/dashboard.html      the page itself (markup, script, style)
web/md.js               card-body markdown renderer, inlined into the page
web/memory.js           column scroll / open-card memory, inlined into the page
scripts/build-web.mjs   inlines the three into extensions/dashboard.generated.ts
```

npm run build regenerates extensions/dashboard.generated.ts; pretest and prepack run it for you. The generated file is committed because the published package ships only extensions/ and pi loads extensions/kanban.ts straight off disk - it cannot build at install time. Edit web/, never the generated file.

npm test runs the whole suite (72 cases) with no dependencies beyond Node itself.

## License

MIT
