# pi-kanban-board

A kanban board for [pi](https://github.com/earendil-works/pi) that the agent keeps in sync with its own work.

Long sessions lose the thread: the goal drifts, an earlier decision gets forgotten, and the model starts re-litigating things it already settled. A board fixes that by putting the plan somewhere both the human and the model read from — the agent updates it as work moves, and the board is injected back into the conversation every turn.

## What you get

- **A board the model maintains.** The `kanban` tool is the model's handle: add, move, remove, schedule, attach images, record why something is blocked.
- **Two views.** A right-panel board for the session you are in, and an HTTP dashboard at `http://<host>:8789/` covering every session on the machine.
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
```

### The `kanban` tool

The model calls this directly. Actions include `list`, `add`, `move`, `remove`, `schedule`, `blocked`, `priority`, and `check` (a self-diagnosis of the board, serve registry, media directory, and mode files).

### Dashboard

The extension starts an HTTP server on port 8789 the first time a session begins. Open `http://<host>:8789/` for the dashboard, or `http://<host>:8789/api/kanban.html` for the single-board view.

The dashboard shows sessions, agents, and served files in tabs, with per-board loop and pick toggles, live counters, and inline card editing (double-click the body; `Shift+Enter` inserts a newline).

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
├── server.log           HTTP server log
├── kanban.html          generated right-panel view
└── dashboard.html       generated dashboard
```

State is plain JSON on disk. Nothing leaves the machine.

## Debugging the loop

The autonomous loop decides once every 1.5s whether to wake the agent. Set `KANBAN_DEBUG=1` to get one `kanban: poll ... => fire|skip:<reason>` line per tick on stderr; unset, the loop stays silent. `~/.pi/kanban/server.log` keeps the HTTP side (bind, reuse, API down); a rejected wake shows up there as `wake rejected: ...`.

## Security notes

The HTTP server binds `0.0.0.0` and sends `Access-Control-Allow-Origin: *`. Mutating endpoints are `GET`-reachable so the board works from a plain browser tab and from inside an `iframe srcdoc`. It is designed for a trusted LAN, not the public internet — do not expose port 8789.

## Nothing here is a service

There is no daemon. The HTTP server lives inside the pi process, so board state is available exactly as long as pi is running. The generated HTML is rewritten on each render; edit the `KANBAN_HTML` / `DASHBOARD_HTML` constants in `extensions/kanban.ts`, not the generated files.

## License

MIT
