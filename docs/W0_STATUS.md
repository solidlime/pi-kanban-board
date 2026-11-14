# W0 status (started)

Done (non-destructive):
- `docs/REWRITE_V2_PLAN.md` — Phase 0 IF freeze, schema/API sketch, waves, init procedure.
- `src/shared/` — ids (composite), errors/envelope, constants, events, dto, index.
- `src/core|persistence|api|agent` skeleton indexes.
- `src/persistence/init.ts` — init plan + safety stub (executeInit refuses; requires explicit confirmation).
- `tsconfig.v2.json` scaffold.

Not done yet (W0 remaining):
- Finalize tool/command compatibility details and UI tech choice.
- Wire new entry/build/test scripts without breaking package contract; define cutover from old monolith.
- Implement reviewed init execution path (backup-or-delete) **only after showing exact targets and receiving final user confirmation**.
- Freeze shared IF as importable contracts for W1 dolls (domain/persistence).

No changes made to `~/.pi/kanban`.
