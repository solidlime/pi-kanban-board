# v2 Feature Map / Completion Tracker

## Core (Phase 0-1, must work)
- [x] Clean architecture & contracts: shared/core/persistence/api/agent/ui separation, composite IDs, envelopes, versioning, build hash, timeline-in-tx。
- [x] Persistence v2: sqlite schema/migrations/repos, project-local seq, optimistic version, safety-gated init/detect。
- [x] HTTP API v2: auth, projects/board/cards CRUD+move, dependencies/deliverables, static web, meta/selftest/init-state, エンベロープ+version/409/422 正規化。
- [x] UI shell: normalized store, keyed diff render, project picker, board columns/cards, add/move/edit/delete, focus/panel/detail, deps/deliverables/timeline, 楽観更新/ロールバック, polling。
- [x] Agent adapter compat: `kanban`/`deliverable` tools (v1順序/主要パラメータ) + `/kanban` 主要コマンド + before_agent_start 注入 (cwd project, 非表示末尾メッセージ, トークン非露出) を v2 バックエンドに接続。scope/project 厳密・(project,id) 解決・global 書込拒否。card img/ref・deliverable img は実装済み(画像は content-addressed ストアへ)、resume は loop を起動。nextFireAt は due(日付) へ縮退。(integration 13 tests)
- [x] Build/test pipeline: build:v2, typecheck:v2, test:v2 (unit/integration/e2e), smoke:v2, selftest 緑化。(`scripts/build-v2.mjs`, `scripts/smoke-v2.mjs`, `tests/{unit,integration,e2e}`)

## Project-wide management ("昇華") — API done, UI in progress
- [~] 依存関係の可視化: dependency data model/API + board/timeline UI showing blockers/blocked, cycle-safe ops. (W3E done: GET/POST/DELETE /api/dependencies, card badges, detail add/remove, CYCLE surfaced)
- [~] フォーカスモード: "今やるべきカード" view (ready/unblocked, by priority/due/column) and quick focus filter. (W3E done client-side from snapshot deps; column-limits endpoint missing)
- [~] 成果物をタイムラインに紐づけ: deliverables linked to cards/projects/timeline events, visible in card/detail/timeline. (W3E done: deliverable.cardId/kind/ref, panel + card dialog, project timeline)
- [~] 横断ビュー操作の正しさ: cross-project view is read-safe; mutations require explicit project target, no wrong-board writes. (W3E: per-key project guard on every mutation; global view read-only)

## Process quality
- [~] WIP制限・優先度: per-column WIP enforcement (domain done) surfaced in API/UI, priority field end-to-end and sorting/controls. (W3E: priority/over-WIP visible + WIP errors surfaced)
- [~] 完了条件・担当・引き継ぎ: acceptance criteria, owner/assignee, handoff/session metadata, readiness checks in UI/API. (W3E: owner/due/blockedReason/acceptance visible + editable, acceptance from body checkboxes)
- [x] 自走ループ可観測性: `loop_state`(板ごとに1行) + `GET /api/loop` + `POST /api/loop/{start,stop,tick}` + `loop.*` timeline + **横断スーパーバイザ**(`src/supervisor.ts`、15秒ごとに running の板だけ tick。板が halt しても他は止まらない)。tick は次の TODO を DOING へ移す(WIP=1)。モデルは起こさない(状態を記録するのが役割)。UI はループ帯 + 全体/依存マップ。
  - pi-web 内の adapter が既定15秒で supervisor を立てる(`KANBAN_LOOP_MS` で上書き、`0` で無効)。
  - `GET /api/loop` は `nextTickAt`(最終 tick + 間隔) を返し、UI はループ帯に残り秒を 1 秒ごとに出す。

## Scale / reuse
- [~] 保存ビュー/検索: `saved_view` CRUD API + `GET /api/search`(#id・全板横断) 実装済み。UI/UX は designer 待ち。
- [~] テンプレート: `card_template` CRUD + instantiate API 実装済み。UI は designer 待ち。
- [~] 通知: `GET /api/notifications`(overdue/blocked/deps/wip/acceptance、重大度順) 実装済み。外部フックは未着手。
- [~] 横断ボード可観測性: `GET /api/overview`(板ごとの ready/blocked/wip/overdue/done) と `GET /api/graph`(blocker 鎖の層) 実装済み。
- [~] 添付/画像: 画像のみ(PNG/JPEG/GIF/WebP をマジックバイト判定、≤8MiB)+ content-addressed ブロブ + `nosniff` 配信。同一オリジンからの HTML 配信は XSS になるため非画像は 422。

## Remaining (UI + polish)
- [ ] Web UI: 上記 API の画面(検索/ビュー/通知/テンプレート/添付/ループ/概要/グラフ/列 WIP 編集)。designer に委譲中。
- [ ] 実ブラウザ確認(全 120 テストは green だがクリックは未確認)。

## Delivery
- [ ] v2 runtime cutover path (extensions/kanban-v2 or switched entry) + docs.
- [ ] Temp-home E2E verification; explicit-confirm init of ~/.pi/kanban (only with user approval).
