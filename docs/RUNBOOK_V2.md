# v2 Runbook (dev)

## Build UI
```bash
npm run build:v2
```
Outputs `web/dist/{index.html,app.js,app.css,meta.json}` with buildHash.

## Smoke test (temp home, non-destructive)
```bash
node scripts/smoke-v2.mjs
```
Creates a temp `.pi/kanban` home, runs `executeInit(...,{confirmed:true,mode:"backup"})`, starts server on port 0, exercises meta/projects/board/cards/move, then cleans up.

## Dev server (against a throwaway home)
```bash
# initialize a throwaway home first (explicit confirmation required by API)
KANBAN_HOME=/path/to/.pi/kanban node src/api/serve.ts
```
Serves UI on `http://127.0.0.1:8789/` (or KANBAN_PORT). If home is not initialized, writes refuse and UI/meta report init required.

## Initialize real `~/.pi/kanban` (DESTRUCTIVE to v1)
**Requires explicit user confirmation.** Flow: `planInit/inspectInit` -> show targets + backup dir -> user confirms -> `executeInit(plan,{confirmed:true,mode:"backup"})` (or `delete`). Never auto-run.

## Tests
```bash
node --test tests/unit/*.test.mjs
node --test tests/integration/*.test.mjs
node scripts/smoke-v2.mjs
```
(e2e suite/scripts added by W3G when ready.)
