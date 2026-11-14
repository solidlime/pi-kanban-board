// App wiring: one store, one view, no framework. Reads are GET + poll; every mutation is
// POST/PATCH/DELETE and the response card replaces the local copy.
import './styles.css';
import {
  ApiError, getMeta, getProjects, getBoard, createProject, createCard, moveCard, patchCard, deleteCard,
  getDeliverables, getTimeline, createDeliverable, deleteDeliverable, addDependency, removeDependency,
  patchColumn, getViews, createView, deleteView, getTemplates, createTemplate, useTemplate, deleteTemplate,
  getAttachments, uploadAttachment, deleteAttachment, searchBoard, getLocks, getNotifications, getGraph, getOverview,
  getLoop, startLoop, stopLoop, tickLoop,
} from './api.js';
import {
  createStore, applySnapshot, upsertCard, removeCard, resetBoard, setProjects, setMeta,
  applyLocalMove, parseKey, cardKey, type CardKey, type Store, type SearchHit,
} from './store.js';
import { mount, renderView, showToast, type View } from './render.js';
import { mountDetail, type DetailView } from './detail.js';
import type { DependencyType, PatchCardReq } from '../../src/shared/api.js';
import type { Card, LoopState } from '../../src/shared/dto.js';

const PROJECT_KEY = 'kb.v2.project';
const POLL_MS = 5000;

const store: Store = createStore();
const root = document.getElementById('app');
if (!root) throw new Error('#app not found');
root.textContent = '';

function describe(e: unknown): string {
  if (e instanceof ApiError) {
    const code = e.status ? `${e.code} ${e.status}` : e.code;
    return `${e.message} [${code}]`;
  }
  return e instanceof Error ? e.message : String(e);
}

function readSavedProject(): string | null {
  try { return localStorage.getItem(PROJECT_KEY); } catch { return null; }
}
function saveProject(slug: string | null): void {
  try {
    if (slug) localStorage.setItem(PROJECT_KEY, slug);
    else localStorage.removeItem(PROJECT_KEY);
  } catch { /* private mode: selection just won't persist */ }
}

// ---------------------------------------------------------------- loading

let boardSeq = 0;

async function loadMeta(): Promise<void> {
  try {
    setMeta(store, await getMeta());
  } catch (e) {
    store.error = `meta: ${describe(e)}`;
  }
  render();
}

async function loadBoard(): Promise<void> {
  const project = store.projectId;
  if (!project) return;
  const seq = ++boardSeq;
  store.loading = true;
  render();
  try {
    // Board + deliverables + history travel together: the side panel and the card badges must
    // describe the same snapshot, so they are fetched under one sequence guard.
    const [snap, del, tl] = await Promise.all([
      getBoard(project),
      getDeliverables(project).catch(() => null),
      getTimeline(project).catch(() => null),
    ]);
    if (seq !== boardSeq || store.projectId !== project) return; // stale response, wrong board
    if (!applySnapshot(store, project, snap)) {
      store.error = `ボードの応答が別プロジェクトでした (${snap?.project?.slug ?? '?'})`;
      return;
    }
    if (del) store.deliverables = del.deliverables;
    if (tl) store.timeline = tl.events;
    await loadExtras(project, seq);
    store.error = null;
    if (store.graph) await loadGraph();
    if (store.overview) await loadOverview();
  } catch (e) {
    if (seq !== boardSeq) return;
    store.error = describe(e);
  } finally {
    if (seq === boardSeq) { store.loading = false; render(); }
  }
}

// ---------------------------------------------------------------- extras (v2 surfaces)
// Notifications, attachments and the loop state describe the same board snapshot, so they are
// fetched alongside it. One failing surface must not hide the board: the rest still applies.

let extrasSeq = 0;

async function loadExtras(project: string, boardToken: number): Promise<void> {
  const seq = ++extrasSeq;
  const [att, nt, lp, lk] = await Promise.allSettled([
    getAttachments(project), getNotifications(project), getLoop(project), getLocks(project),
  ]);
  if (seq !== extrasSeq || boardToken !== boardSeq || store.projectId !== project) return;
  const failed: unknown[] = [];
  if (att.status === 'fulfilled') store.attachments = att.value.attachments; else failed.push(att.reason);
  if (nt.status === 'fulfilled') store.notifications = nt.value.notifications; else failed.push(nt.reason);
  if (lp.status === 'fulfilled') store.loop = lp.value.loop; else failed.push(lp.reason);
  // A6 is decoration: a board without locks (or a server without the route) says nothing, quietly.
  store.locks = lk.status === 'fulfilled' ? lk.value.locks ?? [] : [];
  if (failed.length) {
    const message = describe(failed[0]);
    store.error = message;
    showToast(view, message);
  }
}

async function selectProject(slug: string | null): Promise<void> {
  if (store.projectId === slug) return;
  boardSeq++; // invalidate anything in flight for the previous board
  resetBoard(store, slug);
  saveProject(slug);
  render();
  if (slug) await loadBoard();
}

async function loadProjects(): Promise<void> {
  try {
    const { projects } = await getProjects();
    setProjects(store, projects);
    const wanted = store.projectId ?? readSavedProject();
    const pick = projects.find(x => x.slug === wanted)?.slug ?? projects[0]?.slug ?? null;
    if (store.projectId !== pick) await selectProject(pick);
    else render();
  } catch (e) {
    store.error = `projects: ${describe(e)}`;
    render();
  }
}

// ---------------------------------------------------------------- mutations

/** Runs one card-scoped mutation and reports whether the server accepted it. */
async function withPending(key: CardKey, task: () => Promise<void>): Promise<boolean> {
  store.pending.add(key);
  render();
  try {
    await task();
    store.error = null;
    return true;
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    await loadBoard(); // server state wins; the optimistic edit was a guess
    return false;
  } finally {
    store.pending.delete(key);
    render();
  }
}

/** Guard every mutation: a card from another project is never sent under the current slug. */
function cardOf(key: CardKey) {
  const card = store.cards[key];
  if (!card) return null;
  const { projectId, id } = parseKey(key);
  if (projectId !== store.projectId || card.projectId !== store.projectId) return null;
  return { card, projectId, id };
}

async function doAddCard(columnId: string, title: string): Promise<boolean> {
  const project = store.projectId;
  if (!project) { showToast(view, 'プロジェクトを選んでください'); return false; }
  try {
    const { card } = await createCard({ project, title, columnId });
    if (upsertCard(store, card)) { store.error = null; render(); } else await loadBoard();
    return true;
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    render();
    return false;
  }
}

async function doMove(key: CardKey, columnId: string): Promise<void> {
  const cur = cardOf(key);
  if (!cur) { showToast(view, '別プロジェクトのカードです。再読み込みします。'); await loadBoard(); return; }
  const { card, projectId, id } = cur;
  applyLocalMove(store, key, columnId); // optimistic; rollback happens via loadBoard on failure
  await withPending(key, async () => {
    const { card: saved } = await moveCard(projectId, id, { columnId, version: card.version });
    upsertCard(store, saved);
  });
}

async function doEdit(key: CardKey): Promise<void> {
  const cur = cardOf(key);
  if (!cur) { showToast(view, '別プロジェクトのカードです。再読み込みします。'); await loadBoard(); return; }
  const { card, projectId, id } = cur;
  const next = window.prompt('タイトル', card.title);
  if (next === null) return;
  const title = next.trim();
  if (!title || title === card.title) return;
  await withPending(key, async () => {
    const { card: saved } = await patchCard(projectId, id, { title, version: card.version });
    upsertCard(store, saved);
  });
}

async function doDelete(key: CardKey): Promise<void> {
  const cur = cardOf(key);
  if (!cur) { showToast(view, '別プロジェクトのカードです。再読み込みします。'); await loadBoard(); return; }
  const { card, projectId, id } = cur;
  if (!window.confirm(`カード #${id}「${card.title}」を削除する？`)) return;
  removeCard(store, key);
  await withPending(key, async () => {
    await deleteCard(projectId, id, { version: card.version });
  });
  await loadBoard(); // dependencies/timeline changed too, not just the card
}

async function doSave(key: CardKey, patch: Omit<PatchCardReq, 'version'>): Promise<boolean> {
  const cur = cardOf(key);
  if (!cur) { showToast(view, '別プロジェクトのカードです。再読み込みします。'); await loadBoard(); return false; }
  const { card, projectId, id } = cur;
  let ok = false;
  await withPending(key, async () => {
    // Version comes from the live store copy, not from the dialog's snapshot: a poll that
    // landed while the dialog was open must not turn a good save into a STALE_VERSION.
    const { card: saved } = await patchCard(projectId, id, { ...patch, version: card.version });
    upsertCard(store, saved);
    ok = true;
  });
  if (ok) await loadBoard(); // the patch may have emitted timeline events
  return ok;
}

async function doAddDep(key: CardKey, toCard: number, type: DependencyType): Promise<boolean> {
  const cur = cardOf(key);
  if (!cur) { showToast(view, '別プロジェクトのカードです。再読み込みします。'); await loadBoard(); return false; }
  const { projectId, id } = cur;
  if (!store.cards[`${projectId}#${toCard}`]) { showToast(view, '対象カードが同じプロジェクトに見つかりません'); await loadBoard(); return false; }
  try {
    await addDependency({ project: projectId, fromCard: id, toCard, type });
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e)); // CYCLE / VALIDATION come back here, in the server's words
    return false;
  }
  await loadBoard();
  return true;
}

async function doRemoveDep(projectId: string, from: number, to: number, type: DependencyType): Promise<boolean> {
  if (projectId !== store.projectId) { await loadBoard(); return false; }
  try {
    await removeDependency(projectId, from, to, type);
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    return false;
  }
  await loadBoard();
  return true;
}

async function doAddDeliverable(title: string, cardId: number | null): Promise<boolean> {
  const project = store.projectId;
  if (!project) { showToast(view, 'プロジェクトを選んでください'); return false; }
  if (cardId !== null && !store.cards[`${project}#${cardId}`]) {
    showToast(view, '対象カードが同じプロジェクトに見つかりません');
    return false;
  }
  try {
    await createDeliverable({ project, title, cardId });
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    return false;
  }
  await loadBoard();
  return true;
}

async function doDeleteDeliverable(projectId: string, id: number): Promise<boolean> {
  if (projectId !== store.projectId) { await loadBoard(); return false; }
  try {
    await deleteDeliverable(projectId, id);
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    return false;
  }
  await loadBoard();
  return true;
}

async function doCreateProject(name: string): Promise<boolean> {
  try {
    const { project } = await createProject({ name });
    const { projects } = await getProjects();
    setProjects(store, projects);
    const slug = project.slug ?? project.projectId;
    await selectProject(slug);
    return true;
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    render();
    return false;
  }
}

// ---------------------------------------------------------------- v2 surfaces

let searchSeq = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

async function runSearch(q: string): Promise<void> {
  const all = store.searchAll;
  const board = store.projectId;
  if (!all && !board) return;
  const seq = ++searchSeq;
  try {
    // 全板 sends no project: the hits then carry their own projectId (A1 contract).
    const { hits } = await searchBoard(all ? null : board, q, all ? 50 : 20);
    if (seq !== searchSeq || store.searchAll !== all || store.projectId !== board || store.q !== q) return; // stale
    store.hits = hits;
  } catch (e) {
    if (seq !== searchSeq) return;
    store.hits = null;
    store.error = describe(e);
    showToast(view, describe(e));
  }
  render();
}

function onSearchInput(q: string): void {
  store.q = q;
  if (searchTimer) clearTimeout(searchTimer);
  if (!q.trim()) { store.hits = null; searchSeq++; render(); return; }
  searchTimer = setTimeout(() => { void runSearch(q); }, 200);
}

function onCloseSearch(): void {
  searchSeq++; // a late response must not reopen the overlay
  store.hits = null;
  render();
}

function openCardId(projectId: string | null, id: number): void {
  const key = projectId ? cardKey(projectId, id) : null;
  if (!key || !store.cards[key]) { showToast(view, `カード #${id} はこのボードに無い`); return; }
  detail.open(key);
}

/** A1: a hit can live on another board. Switch first, then open — the board must be loaded. */
async function openHit(hit: SearchHit): Promise<void> {
  if (hit.projectId !== store.projectId) await selectProject(hit.projectId);
  store.hits = null;
  render();
  if (hit.type === 'card') openCardId(hit.projectId, hit.id);
}

/** The query is board-scoped by default; 全板 keeps the same text and re-runs it. */
function onToggleSearchAll(): void {
  store.searchAll = !store.searchAll;
  if (store.q.trim()) void runSearch(store.q);
  else render();
}

async function loadOverview(): Promise<void> {
  try {
    store.overviewRows = (await getOverview()).projects;
    store.error = null;
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
  }
  render();
}

async function loadGraph(): Promise<void> {
  const project = store.projectId;
  if (!project) return;
  try {
    const layout = await getGraph(project);
    if (store.projectId !== project) return;
    store.graphLayout = layout;
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
  }
  render();
}

async function loadTemplates(): Promise<void> {
  const project = store.projectId;
  if (!project) return;
  try {
    const { templates } = await getTemplates(project);
    if (store.projectId !== project) return;
    store.templates = templates;
    store.error = null;
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
  }
  render();
}

async function loadViews(): Promise<void> {
  const project = store.projectId;
  if (!project) return;
  try {
    const { views } = await getViews(project);
    if (store.projectId !== project) return;
    store.views = views;
    store.error = null;
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
  }
  render();
}

/** One pane at a time: the deliverables panel and the overlay panes share the right edge. */
function openPane(pane: Store['pane']): void {
  store.pane = store.pane === pane ? 'none' : pane;
  if (store.pane !== 'none') store.panel = false;
  render();
  if (store.pane === 'templates') void loadTemplates();
  else if (store.pane === 'views') void loadViews();
}

async function doEditColumn(columnId: string, patch: { name?: string; wipLimit?: number | null }): Promise<string | null> {
  const project = store.projectId;
  if (!project) { showToast(view, 'プロジェクトを選んでください'); return 'プロジェクト未選択'; }
  try {
    const { column } = await patchColumn(project, columnId, patch);
    if (store.projectId === project) {
      store.columns[column.id] = column;
      store.error = null;
      render();
    }
    return null;
  } catch (e) {
    const message = describe(e); // WIP_LIMIT / VALIDATION come back in the server's words
    store.error = message;
    showToast(view, message);
    render();
    return message;
  }
}

async function doUseTemplate(id: number): Promise<void> {
  const project = store.projectId;
  if (!project) return;
  try {
    const { card } = await useTemplate(project, id);
    upsertCard(store, card);
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    render();
    return;
  }
  await loadBoard();
  showToast(view, 'テンプレートからカードを作成した');
}

async function doDeleteTemplate(id: number): Promise<void> {
  const project = store.projectId;
  if (!project) return;
  try {
    await deleteTemplate(project, id);
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    render();
    return;
  }
  await loadTemplates();
}

async function doSaveTemplate(key: CardKey): Promise<boolean> {
  const cur = cardOf(key);
  if (!cur) { showToast(view, '別プロジェクトのカードです。再読み込みします。'); await loadBoard(); return false; }
  const { card, projectId } = cur;
  const asked = window.prompt('テンプレート名', card.title);
  if (asked === null) return false;
  const name = asked.trim();
  if (!name) { showToast(view, 'テンプレート名は空にできない'); return false; }
  try {
    await createTemplate({
      project: projectId, name, title: card.title, body: card.body ?? '',
      columnId: card.columnId, priority: card.priority,
      ...(card.labels && card.labels.length ? { labels: card.labels } : {}),
    });
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    render();
    return false;
  }
  store.panel = false;
  store.pane = 'templates';
  await loadTemplates();
  showToast(view, 'テンプレートに保存した');
  return true;
}

async function doSaveView(name: string): Promise<boolean> {
  const project = store.projectId;
  if (!project) { showToast(view, 'プロジェクトを選んでください'); return false; }
  try {
    await createView({
      project, name,
      query: { ...(store.q.trim() ? { q: store.q.trim() } : {}), ...(store.qFocus ? { focus: true } : {}) },
    });
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    render();
    return false;
  }
  await loadViews();
  return true;
}

async function doDeleteView(id: number): Promise<void> {
  const project = store.projectId;
  if (!project) return;
  try {
    await deleteView(project, id);
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    render();
    return;
  }
  await loadViews();
}

function doApplyView(id: number): void {
  const view_ = store.views.find(v => v.id === id);
  if (!view_) return;
  store.q = view_.query.q ?? '';
  store.qFocus = Boolean(view_.query.focus);
  store.hits = null;
  // The pane stays open on purpose: it holds the "ボードもこの条件で絞り込む" toggle for this view.
  if (store.q) void runSearch(store.q);
  else render();
  showToast(view, store.qFocus ? 'ビューを適用（ボードを絞り込み）' : 'ビューを適用');
}

async function doLoop(action: 'start' | 'stop' | 'tick'): Promise<void> {
  const project = store.projectId;
  if (!project) return;
  let loop: LoopState;
  let next: Card | null = null;
  try {
    if (action === 'start') loop = (await startLoop(project)).loop;
    else if (action === 'stop') loop = (await stopLoop(project)).loop;
    else { const res = await tickLoop(project); loop = res.loop; next = res.nextCard; }
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    render();
    return;
  }
  if (store.projectId !== project) return;
  store.loop = loop;
  store.error = null;
  if (next) upsertCard(store, next);
  if (action === 'tick') showToast(view, next ? `次は #${next.id} ${next.title}` : (loop.haltReason ?? 'ready なカードが無し'));
  render();
  if (action === 'tick') await loadBoard();
}

async function doUpload(key: CardKey, file: File): Promise<boolean> {
  const cur = cardOf(key);
  if (!cur) { showToast(view, '別プロジェクトのカードです。再読み込みします。'); await loadBoard(); return false; }
  try {
    await uploadAttachment(cur.projectId, { cardId: cur.id }, file.name, file);
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    return false;
  }
  await loadBoard();
  return true;
}

async function doUploadDeliverable(deliverableId: number, file: File): Promise<boolean> {
  const project = store.projectId;
  if (!project) { showToast(view, 'プロジェクトを選んでください'); return false; }
  try {
    await uploadAttachment(project, { deliverableId }, file.name, file);
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    return false;
  }
  await loadBoard();
  return true;
}

async function doDeleteAttachment(projectId: string, id: number): Promise<boolean> {
  if (projectId !== store.projectId) { await loadBoard(); return false; }
  try {
    await deleteAttachment(projectId, id);
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    return false;
  }
  await loadBoard();
  return true;
}

// ---------------------------------------------------------------- boot

const view: View = mount(root, {
  onProject: (slug) => { store.overview = false; void selectProject(slug || null); },
  onCreateProject: doCreateProject,
  onAddCard: doAddCard,
  onMove: (key, columnId) => { void doMove(key, columnId); },
  onEdit: (key) => { void doEdit(key); },
  onDelete: (key) => { void doDelete(key); },
  onOpen: key => detail.open(key),
  onToggleFocus: () => { store.focus = !store.focus; render(); },
  onTogglePanel: () => {
    store.panel = !store.panel;
    if (store.panel) store.pane = 'none'; // one right-hand surface at a time
    render();
  },
  onAddDeliverable: title => doAddDeliverable(title, null),
  onDeleteDeliverable: (projectId, id) => { void doDeleteDeliverable(projectId, id); },
  onSearch: q => onSearchInput(q),
  onCloseSearch,
  onOpenCard: id => openCardId(store.projectId, id),
  onOpenHit: hit => { void openHit(hit); },
  onToggleSearchAll,
  onToggleGantt: () => {
    store.gantt = !store.gantt;
    if (store.gantt) { store.overview = false; store.graph = false; store.pane = 'none'; }
    render();
  },
  onGanttScale: scale => { store.ganttScale = scale; render(); },
  onTogglePane: pane => openPane(pane),
  onToggleOverview: () => {
    store.overview = !store.overview;
    if (store.overview) { store.pane = 'none'; store.gantt = false; void loadOverview(); } else render();
  },
  onToggleGraph: () => {
    store.graph = !store.graph;
    if (store.graph) store.gantt = false;
    render();
    if (store.graph) void loadGraph();
  },
  onEditColumn: (columnId, patch) => doEditColumn(columnId, patch),
  onUseTemplate: id => { void doUseTemplate(id); },
  onDeleteTemplate: id => { void doDeleteTemplate(id); },
  onApplyView: id => doApplyView(id),
  onSaveView: name => doSaveView(name),
  onDeleteView: id => { void doDeleteView(id); },
  onLoop: action => { void doLoop(action); },
  onToggleFocusQuery: on => { store.qFocus = on; render(); },
});

const detail: DetailView = mountDetail(root, {
  onSave: doSave,
  onAddDep: doAddDep,
  onRemoveDep: (projectId, from, to, type) => doRemoveDep(projectId, from, to, type),
  onAddDeliverable: doAddDeliverable,
  onDeleteDeliverable: doDeleteDeliverable,
  onMove: (key, columnId) => { void doMove(key, columnId); },
  onDelete: key => { void doDelete(key); },
  onUploadAttachment: (key, file) => doUpload(key, file),
  onDeleteAttachment: (projectId, id) => doDeleteAttachment(projectId, id),
  onUploadDeliverableAttachment: (deliverableId, file) => doUploadDeliverable(deliverableId, file),
  onTemplateFromCard: key => { void doSaveTemplate(key); },
  notify: message => showToast(view, message),
});

function render(): void {
  renderView(view, store);
  detail.render(store, store.projects);
}

async function boot(): Promise<void> {
  render();
  await Promise.allSettled([loadMeta(), loadProjects()]);
}

void boot();

setInterval(() => { if (!document.hidden) void loadBoard(); }, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  void loadBoard();
});
window.addEventListener('focus', () => { void loadBoard(); });
