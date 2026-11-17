# カード#25: プロジェクト削除

対象: pi-kanban-board カード #25「kanbanからプロジェクト削除機能追加」（body/受け入れ条件なし）
確定した選択（本人回答 2026-11-17）:
- 入口は **HTTP API + ダッシュボード UI**。kanban ツール（agent 側 action）は足さない
- 中身が残っていても **slug 打ち込み確認**が取れれば削除できる

## 0. 実測した事実（ここを読めば実装できる）

| 事実 | 場所 |
|---|---|
| スキーマは project 起点の `ON DELETE CASCADE` 全面。`PRAGMA foreign_keys=ON` | `src/persistence/migrations.ts:14-170` |
| **素の `DELETE FROM project WHERE project_id=?` で全部片付く**（card/dependency/deliverable/attachment/column/counters/saved_view/card_template/loop_state/card_lock が 0 行、RESTRICT は発火しない）。`:memory:` で実測済み | 本計画の前提 |
| `timeline_event` は FK 無し + append-only トリガー。削除後も行が残る（設計意図: 履歴を書き換えない） | `src/persistence/migrations.ts:118-134` |
| カード削除の型: `withTx` → 対象取得（無ければ NOT_FOUND）→ `appendTimeline` → `DELETE` | `src/persistence/repos.ts:377-395`（`deleteCard`） |
| 削除ルートの型: 取れなければ `projectOr404`、本体は 200 `{deleted:{...}}` | `src/api/routes.ts:405-416`（`deleteCardRoute`） |
| ルート表は末尾の `routes` 配列。`projects` は GET/POST の2本だけ | `src/api/routes.ts:1069-1070` |
| `CAPABILITIES` に `card.delete` がある。並びに `project.delete` を足す | `src/api/routes.ts:49-54` |
| クライアント関数は `web/src/api.ts`（`deleteCard` / `deleteDeliverable` が型） | `web/src/api.ts:118` 付近 |
| ヘッダのプロジェクト欄は `mount()` の `pick`（select のみ） | `web/src/render.ts:342-347` |
| ハンドラ型 `Handlers` に `onProject` / `onCreateProject` | `web/src/render.ts:22-24` |
| UI の確認は `window.confirm`、トーストは `showToast(view, msg)` | `web/src/app.ts:324,338`, `web/src/detail.ts:258` |
| プロジェクト作成後の流れ: `getProjects` → `setProjects` → `selectProject(slug)` | `web/src/app.ts:421-435` |
| 添付 blob は `deleteAttachment` でも消していない（DB 行だけ）。同じ方針で blob は残す | `src/api/routes.ts:842-848` |

## 1. repos.ts（`src/persistence/repos.ts`）

`updateProject` の直後に追加:

```ts
export function deleteProject(db: Db, projectId: ProjectId, actor = "system"): void {
  withTx(db, () => {
    const cur = one<ProjectRow>(db, "SELECT * FROM project WHERE project_id = ?", projectId);
    if (!cur) throw new DomainError("NOT_FOUND", `project ${projectId} not found`);
    // The timeline is append-only and has no FK to project: the row outlives the board,
    // so a later board with the same slug still shows what was deleted here.
    appendTimeline(db, {
      projectId, entityType: "project", entityId: projectId, kind: "project.deleted",
      actor, payload: { slug: cur.slug, name: cur.name }, at: nowIso(),
    });
    // 明示順で消す（末尾「決定の追記」を参照）。CASCADE の実行順に頼ると
    // card.column_id の RESTRICT と複合FKの SET NULL で 500 になる。
    run(db, "DELETE FROM attachment WHERE project_id = ?", projectId);
    run(db, "DELETE FROM deliverable WHERE project_id = ?", projectId);
    run(db, "DELETE FROM dependency WHERE project_id = ?", projectId);
    run(db, "DELETE FROM card WHERE project_id = ?", projectId);
    run(db, "DELETE FROM column_def WHERE project_id = ?", projectId);
    run(db, "DELETE FROM project WHERE project_id = ?", projectId);
  });
}
```

## 2. routes.ts（`src/api/routes.ts`）

- import に `deleteProject` を足す
- `CAPABILITIES` の `"card.delete"` の隣に `"project.delete"`
- `postProject` の後に:

```ts
function deleteProjectRoute(ctx: Ctx, m: RegExpExecArray): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  deleteProject(db, project.projectId, ACTOR);
  sendJson(ctx, 200, ok({ deleted: { projectId: project.projectId, slug: project.slug } }));
}
```

- ルート表の POST /api/projects の次に:
  `{ m: "DELETE", re: /^\/api\/projects\/([^/]+)$/, h: deleteProjectRoute },`

## 3. 型（`src/shared/api.ts`）

`CreateProjectRes` の下に:

```ts
export type DeleteProjectRes = ApiEnvelope<{ deleted: { projectId: string; slug: string } }>;
```

## 4. web/src/api.ts

`createProject` の下に:

```ts
export const deleteProject = (project: string) =>
  req<{ deleted: { projectId: string; slug: string } }>('DELETE', `/api/projects/${p(project)}`);
```

## 5. UI（`web/src/render.ts` + `web/src/app.ts`）

render.ts:
- `Handlers` に `onDeleteProject(slug: string): void;`（`onCreateProject` の隣）
- `mount()` の `pick` を組み立てているブロックで、`select` の右に削除ボタンを足す:
  ```ts
  const delProject = el('button', 'ic danger', '×');
  delProject.type = 'button';
  delProject.title = 'このプロジェクトを削除';
  delProject.addEventListener('click', () => {
    if (select.value) h.onDeleteProject(select.value);
  });
  pick.append(el('span', 'lbl', 'project'), select, delProject);
  ```
  （`view` には持たせない。ラベルは既存の `pick` の中に収める）

app.ts:
- import に `deleteProject` を足す（`createProject` の並び）
- `doCreateProject` の後に:

```ts
/**
 * 削除は取り消せない（timeline 以外は CASCADE で消える）。誤クリックで消えないよう、
 * slug の打ち込みを確認にする。空のボードでも同じ手順を踏ませる。
 */
async function doDeleteProject(slug: string): Promise<boolean> {
  const p = store.projects.find(x => x.slug === slug);
  const name = p?.name || slug;
  const cards = store.projectId === slug ? Object.keys(store.cards).length : null;
  const deliv = store.projectId === slug ? store.deliverables.length : null;
  const stuff = [
    cards === null ? null : `カード ${cards} 枚`,
    deliv === null ? null : `成果物 ${deliv} 件`,
  ].filter(Boolean).join('・');
  const typed = window.prompt(
    `プロジェクト「${name}」(${slug}) を削除する。${stuff ? `${stuff}も一緒に消える。` : ''}\n` +
    `元に戻せない。続けるには slug を入力して。`,
  );
  if (typed === null) return false;
  if (typed.trim() !== slug) { showToast(view, 'slug が一致しないので削除しなかった'); return false; }
  try {
    await deleteProject(slug);
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    render();
    return false;
  }
  try {
    const { projects } = await getProjects();
    setProjects(store, projects);
    await selectProject(projects[0]?.slug ?? null);
  } catch (e) {
    store.error = `projects: ${describe(e)}`;
    render();
  }
  return true;
}
```

- `h`（view の Handlers 実装）に `onDeleteProject: (slug) => { void doDeleteProject(slug); },` を追加

注意: `store.deliverables` の実体名は store.ts で確認（`deliverables` 配列 or Map）。件数は `Object.keys(store.cards).length` と `store.deliverables.length`。違えば store の形に合わせる。

## 6. ドキュメント（`docs/W2_API.md`）

`POST /api/projects` の行の下に:

```
| DELETE | `/api/projects/:slug` | ボードを丸ごと削除（cards/columns/deliverables/attachments/views/templates/loop/locks は CASCADE）。timeline は残る。200 `{deleted:{projectId,slug}}` / 404 |
```

## 7. テスト（`tests/integration/api-project-delete.test.mjs`）

`tests/integration/api-extras.test.mjs` の `server(t)` ハーネスと同じ形（temp home + `executeInit` + `startServer({port:0})` + Bearer）で:

1. 2ボード作り、片方にカード・成果物・依存・添付・ビューを入れて `DELETE /api/projects/<slug>` → 200、`GET /api/projects` から消える、`GET /api/board?project=<slug>` が 404
2. 消したボードのカードが `GET /api/board?project=other` の応答に混ざらない
3. 同じ DB で `SELECT COUNT(*)` 系は HTTP から見えないので、`startServer` が返す home の SQLite を直接開くなり、添付の `/api/attachments` が 404 になる等で間接確認する（DB を直接開くのは `openDb` + `home` でよい）
4. 未知 slug → 404 NOT_FOUND
5. 削除後に同じ slug を `POST /api/projects` で作り直せる（UNIQUE が残っていない）

## 8. 検証

- `npm run typecheck:v2`
- `node --test tests/integration/api-project-delete.test.mjs tests/integration/api-extras.test.mjs`
- `node scripts/build-web.mjs`（web/dist を再生成。`/` が新しい UI を配る）
- 実ブラウザでヘッダの × → prompt → 削除 → セレクタから消えることを確認（オーケストレーターが最後に）

## 決定の追記（ルアン・メェイのレビュー後に確定）

- `deleteProject` は CASCADE の実行順に頼らず明示順で消す（`attachment → deliverable → dependency → card → column_def → project`）。理由: `card.column_id` が `ON DELETE RESTRICT`、`(project_id, card_id)/(project_id, deliverable_id)` の複合FKが `SET NULL` で、`project_id` は NOT NULL。CASCADE が先に `column_def`/`deliverable` に届くと 500 になる。
- **slug の再利用は許可**（ユーザー判断 2026-11-17）。`project_id === slug` で `counters` は CASCADE で消えるため、同じ slug を作り直すと card id は 1 から振り直す。削除時に走っていた wake child（最大 `WAKE_CHILD_TTL_MS` = 1 時間）は、その prompt が「カード #N を done に」なので、新世代の同 id カードと区別できない。**この窓は受容する**（板の名前を焼き捨てない方を優先）。
- 同 slug の作り直し後、新世代の `GET /api/timeline` には前世代のイベントが混ざる（timeline は append-only・FK 無し）。履歴の見え方だけで、`lastActor` は新カードの `card.created` で自己修復する。
- 添付 blob（`<home>/media/att/`）は削除後も残り、参照も消えるので回収不能。将来 GC を入れるなら入口はここ。
- 走っている child は殺さない（`forgetCard` と同じ方針）。`running` の entry だけ落とし、プロセスは自分の kanban 呼び出しが NOT_FOUND で失敗するに任せる。
