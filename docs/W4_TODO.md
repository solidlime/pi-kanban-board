# W4 (post-W3) expected gaps to close for "完成"

After W3 integration, verify and implement anything still missing:

## Feature completeness
- 依存関係の可視化: graph/list in UI, clear blocker chains, cross-card navigation (if W3E partial).
- フォーカスモード: "ready now" + priority/due ordering, quick toggle, empty-state clarity.
- 成果物タイムライン紐づけ: deliverables as first-class linked to project/card/timeline, shown in card detail and timeline.
- 横断ビュー操作の正しさ: global/cross-project read-only or explicit target; no bare-id/leading-match paths.
- WIP制限・優先度: enforced + visible everywhere; priority editing/sort controls.
- 完了条件・担当・引継ぎ: acceptance criteria CRUD/check, owner/assignee, handoff/session notes, readiness indicators.
- 自走ループ可観測性: loop/wake/halt/resume/next-fire state in v2 (if in scope) or clear status/timeline surfacing.
- 保存ビュー/検索: saved filters/views, text/field search (project/global).
- テンプレート: card/board/project templates (create from template).
- 通知: due/blocked/stale indicators in UI; hooks if feasible.

## Compat/cutover
- Agent: `kanban`/`deliverable` full core parity (list/add/move/remove/edit/check/url/resume/img/ref as feasible), `/kanban` essentials, before_agent_start injection, no wrong-board writes.
- Docs: architecture/API/runbook/cutover, init confirmation procedure.

## Verification
- `npm run build:v2` green, all v2 unit/integration/e2e green, smoke green.
- Manual-like API flow verification on temp home for each feature area.
- Prepare explicit-confirm init plan for real ~/.pi/kanban (do not execute without approval).
