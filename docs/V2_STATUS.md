# v2 Status (in progress)

## Done
- W0: plan/decisions/frozen shared contracts, repo scaffolds, build:v2 pipeline, no `~/.pi/kanban` mutation.
- W1: core/domain (pure transitions, WIP, deps/cycle, readiness, timeline factories) + persistence (SQLite node:sqlite, WAL/FK, migrations v1, repos with project-local seq, optimistic version, timeline same-tx, board snapshot, safety-gated init/detect/inspect/execute). Tests: 48 unit + 15 integration green.
- W2: API server (auth cookie/bearer/bootstrap, static web/dist, meta/selftest/projects/board/timeline/cards CRUD+move+delete, version/409, init-required 503 non-destructive) + UI shell (normalized composite-keyed store, keyed diff render, project picker, board/cards, add/move/edit/delete, optimistic+rollback, polling). Build: `node scripts/build-v2.mjs` -> `web/dist` (hash in meta). End-to-end smoke `scripts/smoke-v2.mjs` **OK** (temp home init confirmed+backup, startServer port 0, bearer auth, create project/card, move, board reflects).

## In flight (W3, parallel)
- #E (01a1daab-91a5): UI features + missing API (deps viz/focus/WIP+priority/blocked/owner/due/acceptance, deliverables-timeline basics, cross-project safety) in web/src + src/api + minimal persistence/core as needed.
- #F (01a1daab-9064): agent adapter compat `extensions/kanban-v2.ts` (tools `kanban`,`deliverable` in order, core actions/params/scope strict, `/kanban` basics, url/check, before_agent_start injection, lifecycle) backed by v2.
- #G (01a1daab-91be): e2e tests (temp home/port 0, init/auth/crud/version/wip/cycle/timeline), test scripts, typecheck:v2 + hygiene, selftest hardening.

## Remaining to reach "complete"
- Integrate W3, run full v2 test/build suite, fix issues.
- Finish feature map: full 依存関係可視化/フォーカス/成果物タイムライン紐づけ, 横断ビュー正しさ, 完了条件/担当/引継ぎ, 自走ループ可観測性, 保存ビュー/検索, テンプレート, 通知 (as feasible in v2), cutover docs.
- Only after explicit user confirmation: show init targets/backup plan and execute `~/.pi/kanban` initialization if requested.
