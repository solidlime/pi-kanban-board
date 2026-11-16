// Keyed DOM rendering: nodes are created once per key and only moved/updated afterwards.
// The v1 regression this prevents: a full innerHTML wipe on every poll, which threw away focus,
// scroll position, and let stale nodes survive with the previous board's data.
import type {
  Attachment, Card, ColumnDef, Deliverable, GraphLayout, GraphNode, NotificationLevel, SearchHit,
} from '../../src/shared/dto.js';
import { attachmentSrc, attachmentViewSrc, deliverableFileSrc, deliverableViewSrc, type LoopInfo } from './api.js';
import {
  acceptanceProgress, blocksCards, cardKey, cardMatches, cardsInColumn, isBlocked, isClosed, isDoneColumn,
  lastActorOf, openBlockers, readyCards, type CardKey, type Store,
} from './store.js';
import { renderGantt, type GanttScale } from './gantt.js';

export interface Handlers {
  onProject(slug: string): void;
  onCreateProject(name: string): Promise<boolean>;
  /** Resolves true when the card was created (the input is cleared only then). */
  onAddCard(columnId: string, title: string): Promise<boolean>;
  onMove(key: CardKey, columnId: string): void;
  onDelete(key: CardKey): void;
  onEdit(key: CardKey): void;
  /** Open the full detail dialog (fields, dependencies, deliverables, history). */
  onOpen(key: CardKey): void;
  onToggleFocus(): void;
  onTogglePanel(which?: PanelKey): void;
  onAddDeliverable(title: string): Promise<boolean>;
  onDeleteDeliverable(projectId: string, id: number): void;
  /** Search box text (the caller debounces) and closing the results overlay. */
  onSearch(q: string): void;
  onCloseSearch(): void;
  /** Open a card by id on the current board (notification, loop next, graph node). */
  onOpenCard(id: number): void;
  /** Open a search hit, switching boards first when the hit lives on another one (A1). */
  onOpenHit(hit: SearchHit): void;
  /** Search every board instead of the current one. */
  onToggleSearchAll(): void;
  onToggleGantt(): void;
  onGanttScale(scale: GanttScale): void;
  onTogglePane(pane: 'templates' | 'views' | 'notifications'): void;
  onToggleOverview(): void;
  onToggleGraph(): void;
  /** Narrow the board to cards matching the search box (saved views with focus). */
  onToggleFocusQuery(on: boolean): void;
  /** Resolves the server's complaint (already formatted) or null when the patch was accepted. */
  onEditColumn(columnId: string, patch: { name?: string; wipLimit?: number | null }): Promise<string | null>;
  onUseTemplate(id: number): void;
  onDeleteTemplate(id: number): void;
  onApplyView(id: number): void;
  onSaveView(name: string): Promise<boolean>;
  onDeleteView(id: number): void;
  onLoop(action: 'start' | 'stop' | 'tick'): void;
}

interface ColView {
  el: HTMLElement;
  name: HTMLElement;
  count: HTMLElement;
  list: HTMLElement;
  editEl: HTMLElement;
  editName: HTMLInputElement;
  editWip: HTMLInputElement;
  editNote: HTMLElement;
}

/** The two independent right-panel surfaces. */
export type PanelKey = 'deliverables' | 'timeline';

export interface View {
  root: HTMLElement;
  /** The sticky header; its height offsets the fixed side panels. */
  top: HTMLElement;
  h: Handlers;
  select: HTMLSelectElement;
  newName: HTMLInputElement;
  status: HTMLElement;
  errBar: HTMLElement;
  empty: HTMLElement;
  board: HTMLElement;
  focus: HTMLElement;
  focusCount: HTMLElement;
  focusList: HTMLElement;
  focusEmpty: HTMLElement;
  /** The two panel views are independent toggles, so both can be open at once. */
  panelWrap: HTMLElement;
  panelDeliv: HTMLElement;
  panelDelivHead: HTMLElement;
  panelDelivBody: HTMLElement;
  panelDelivSig: string;
  panelHist: HTMLElement;
  panelHistHead: HTMLElement;
  panelHistBody: HTMLElement;
  panelHistSig: string;
  focusBtn: HTMLButtonElement;
  panelBtns: Record<PanelKey, HTMLButtonElement>;
  toast: HTMLElement;
  toastMsg: HTMLElement;
  toastUndo: HTMLButtonElement;
  cols: Map<string, ColView>;
  cards: Map<CardKey, HTMLElement>;
  focusRows: Map<CardKey, HTMLElement>;
  projectSig: string;
  focusSig: string;
  // ---- v2 surfaces
  q: HTMLInputElement;
  qres: HTMLElement;
  searchAllBtn: HTMLButtonElement;
  notifBtn: HTMLButtonElement;
  notifCounts: { danger: HTMLElement; warn: HTMLElement; info: HTMLElement };
  overviewBtn: HTMLButtonElement;
  graphBtn: HTMLButtonElement;
  ganttBtn: HTMLButtonElement;
  viewsBtn: HTMLButtonElement;
  templatesBtn: HTMLButtonElement;
  loopBar: HTMLElement;
  loopStatus: HTMLElement;
  loopText: HTMLElement;
  loopNext: HTMLButtonElement;
  loopStart: HTMLButtonElement;
  loopStop: HTMLButtonElement;
  loopTick: HTMLButtonElement;
  overview: HTMLElement;
  overviewSig: string;
  graph: HTMLElement;
  graphSig: string;
  gantt: HTMLElement;
  locks: HTMLElement;
  locksText: HTMLElement;
  locksSig: string;
  paneTemplates: HTMLElement;
  paneViews: HTMLElement;
  paneNotif: HTMLElement;
  paneSig: { templates: string; views: string; notif: string };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Reorders/removes only what changed; nodes not in `items` are dropped. */
export function keyedDiff(container: HTMLElement, items: HTMLElement[]): void {
  const keep = new Set<Element>(items);
  for (const node of Array.from(container.children)) if (!keep.has(node)) node.remove();
  let ref: ChildNode | null = container.firstChild;
  for (const item of items) {
    if (item === ref) { ref = (ref as ChildNode).nextSibling; continue; }
    container.insertBefore(item, ref);
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Shows `message`. With `undo` the toast stays up long enough to press it. */
export function showToast(view: View, message: string, undo?: () => void, urgent = false): void {
  // An undo on screen is a live offer; a passing notification must not take it away.
  // Failures pass urgent: they are the one thing a live undo must not swallow.
  if (!undo && !urgent && !view.toast.hidden && !view.toastUndo.hidden) return;
  view.toastMsg.textContent = message;
  view.toastUndo.hidden = !undo;
  view.toastUndo.onclick = undo ? () => { view.toast.hidden = true; undo(); } : null;
  view.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  // A delete commits at 6s (UNDO_MS in app.ts); hiding the button a shade earlier keeps a
  // button that is visible from being a button that no longer does anything.
  toastTimer = setTimeout(() => { view.toast.hidden = true; }, undo ? 5500 : 5000);
}

export function mount(root: HTMLElement, h: Handlers): View {
  const top = el('div', 'top');
  const brand = el('div', 'brand', 'Kanban v2');

  const pick = el('label', 'pick');
  const select = el('select');
  select.setAttribute('aria-label', 'project');
  select.addEventListener('change', () => h.onProject(select.value));
  pick.append(el('span', 'lbl', 'project'), select);

  const newForm = el('form', 'newproj');
  const newName = el('input');
  newName.placeholder = 'new project name';
  newName.setAttribute('aria-label', 'new project name');
  const newBtn = el('button', undefined, '作成');
  newBtn.type = 'submit';
  newForm.append(newName, newBtn);
  newForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = newName.value.trim();
    if (!name) return;
    void h.onCreateProject(name).then(ok => { if (ok) newName.value = ''; });
  });

  const focusBtn = el('button', 'toggle', 'フォーカス');
  focusBtn.type = 'button';
  focusBtn.title = 'いま着手できるカードだけを表示';
  focusBtn.addEventListener('click', () => h.onToggleFocus());
  // Two buttons, not one: either surface opens without the other.
  const panelBtns: Record<PanelKey, HTMLButtonElement> = {
    deliverables: el('button', 'toggle', '成果物'),
    timeline: el('button', 'toggle', '履歴'),
  };
  for (const [id, btn] of Object.entries(panelBtns) as [PanelKey, HTMLButtonElement][]) {
    btn.type = 'button';
    btn.title = id === 'deliverables' ? '成果物を開く' : '最近の出来事を開く';
    btn.addEventListener('click', () => h.onTogglePanel(id));
  }

  // ---- search
  const searchWrap = el('div', 'search');
  const q = el('input', 'q');
  q.type = 'search';
  q.placeholder = '検索…';
  q.setAttribute('aria-label', 'カード・成果物を検索');
  q.addEventListener('input', () => h.onSearch(q.value));
  q.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { h.onCloseSearch(); q.blur(); } });
  const qres = el('div', 'qres');
  qres.hidden = true;
  qres.setAttribute('role', 'listbox');
  // 全板: the box sends no project, the server answers for every board and each hit carries its own.
  const searchAllBtn = el('button', 'toggle searchall', '全板');
  searchAllBtn.type = 'button';
  searchAllBtn.title = '全プロジェクトをまとめて検索';
  searchAllBtn.addEventListener('click', () => h.onToggleSearchAll());
  searchWrap.append(q, searchAllBtn, qres);

  // ---- view switches
  const overviewBtn = el('button', 'toggle', '全体');
  overviewBtn.type = 'button';
  overviewBtn.title = '全プロジェクトを一画面で（総合管理）';
  overviewBtn.addEventListener('click', () => h.onToggleOverview());
  const graphBtn = el('button', 'toggle', '依存マップ');
  graphBtn.type = 'button';
  graphBtn.title = '依存関係をレイヤで表示';
  graphBtn.addEventListener('click', () => h.onToggleGraph());
  const ganttBtn = el('button', 'toggle', '時間');
  ganttBtn.type = 'button';
  ganttBtn.title = 'due・移動・完了から時間の棒を出す（読み取り専用）';
  ganttBtn.addEventListener('click', () => h.onToggleGantt());
  const viewsBtn = el('button', 'toggle', 'ビュー');
  viewsBtn.type = 'button';
  viewsBtn.title = '保存した検索ビュー';
  viewsBtn.addEventListener('click', () => h.onTogglePane('views'));
  const templatesBtn = el('button', 'toggle', 'テンプレート');
  templatesBtn.type = 'button';
  templatesBtn.title = 'カードの雛形';
  templatesBtn.addEventListener('click', () => h.onTogglePane('templates'));

  // ---- notifications: per-level counts on the button itself
  const notifBtn = el('button', 'toggle notif', '通知');
  notifBtn.type = 'button';
  notifBtn.title = '警告・通知を開く';
  const notifCounts = { danger: el('span', 'nb danger'), warn: el('span', 'nb warn'), info: el('span', 'nb info') };
  notifBtn.append(notifCounts.danger, notifCounts.warn, notifCounts.info);
  notifBtn.addEventListener('click', () => h.onTogglePane('notifications'));

  const status = el('div', 'status');
  // Theme and density live on <html> as attributes, not in the store: they are presentation only,
  // so a change must not go through a render pass. The keys are v1's on purpose — the two
  // dashboards share an origin, and someone who picks light in one means it in the other.
  const themeBtn = el('button', 'toggle theme');
  const densityBtn = el('button', 'toggle density');
  themeBtn.type = 'button';
  themeBtn.title = 'ライト/ダークを切り替え（記憶する）';
  densityBtn.type = 'button';
  densityBtn.title = 'カードの詰まりを切り替え（記憶する）';
  const applyTheme = (light: boolean): void => {
    document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
    themeBtn.textContent = light ? 'テーマ: 明' : 'テーマ: 暗';
  };
  const applyDensity = (compact: boolean): void => {
    document.documentElement.setAttribute('data-density', compact ? 'compact' : 'normal');
    densityBtn.textContent = compact ? '密度: コンパクト' : '密度: 標準';
  };
  themeBtn.addEventListener('click', () => {
    const light = document.documentElement.getAttribute('data-theme') !== 'light';
    applyTheme(light);
    try { localStorage.setItem('kb-theme', light ? 'light' : 'dark'); } catch { /* private mode: the choice lasts the session */ }
  });
  densityBtn.addEventListener('click', () => {
    const compact = document.documentElement.getAttribute('data-density') !== 'compact';
    applyDensity(compact);
    try { localStorage.setItem('kb-density', compact ? 'compact' : 'normal'); } catch { /* private mode: the choice lasts the session */ }
  });
  try {
    applyTheme(localStorage.getItem('kb-theme') === 'light');
    applyDensity(localStorage.getItem('kb-density') === 'compact');
  } catch { applyTheme(false); applyDensity(false); }

  top.append(brand, pick, newForm, searchWrap, focusBtn, panelBtns.deliverables, panelBtns.timeline, overviewBtn, graphBtn, ganttBtn, viewsBtn, templatesBtn, notifBtn, themeBtn, densityBtn, el('div', 'grow'), status);

  const errBar = el('div', 'err');
  errBar.hidden = true;

  // ---- loop status strip
  const loopBar = el('section', 'loop');
  loopBar.hidden = true;
  const loopStatus = el('span', 'loop-st');
  const loopText = el('span', 'loop-txt');
  const loopNext = el('button', 'link next');
  loopNext.type = 'button';
  loopNext.hidden = true;
  const loopStart = el('button', undefined, '開始');
  loopStart.type = 'button';
  const loopStop = el('button', undefined, '停止');
  loopStop.type = 'button';
  const loopTick = el('button', 'primary', '次を引く');
  loopTick.type = 'button';
  loopStart.addEventListener('click', () => h.onLoop('start'));
  loopStop.addEventListener('click', () => h.onLoop('stop'));
  loopTick.addEventListener('click', () => h.onLoop('tick'));
  loopNext.addEventListener('click', () => {
    const id = Number(loopNext.dataset.id ?? '');
    if (Number.isFinite(id) && id > 0) h.onOpenCard(id);
  });
  loopBar.append(loopStatus, loopText, loopNext, el('div', 'grow'), loopStart, loopStop, loopTick);

  // ---- A6: who holds this board. Display only: the UI never takes or releases a lock.
  const locksBar = el('section', 'locks');
  locksBar.hidden = true;
  locksBar.setAttribute('role', 'status');
  const locksText = el('span', 'loop-txt');
  locksBar.append(el('span', 'lock-ic', '🔒'), locksText);

  const empty = el('div', 'empty');
  empty.hidden = true;
  empty.setAttribute('role', 'status');
  const board = el('div', 'board');

  const focus = el('section', 'focus');
  focus.hidden = true;
  const focusHead = el('div', 'focus-h');
  const focusTitle = el('h2', undefined, 'いまやる');
  const focusCount = el('span', 'focus-n');
  focusHead.append(focusTitle, focusCount);
  const focusList = el('div', 'focus-list');
  const focusEmpty = el('div', 'focus-empty', '着手できるカードはない（全部ブロック中か完了）');
  focusEmpty.hidden = true;
  focus.append(focusHead, focusList, focusEmpty);

  // One <aside> per surface: they sit side by side, each with its own close button.
  const panelWrap = el('div', 'panels');
  const mkSidePanel = (id: PanelKey, title: string) => {
    const aside = el('aside', 'panel');
    aside.hidden = true;
    const head = el('div', 'panel-h');
    const h2 = el('h2', undefined, title);
    const close = el('button', 'ic', '×');
    close.type = 'button';
    close.title = '閉じる';
    close.addEventListener('click', () => h.onTogglePanel(id));
    head.append(h2, close);
    const body = el('div', 'panel-body');
    aside.append(head, body);
    panelWrap.append(aside);
    return { aside, head: h2, body };
  };
  const delivPanel = mkSidePanel('deliverables', '成果物');
  const histPanel = mkSidePanel('timeline', '履歴');

  // Outside click / Escape close the search overlay (the box keeps its text).
  document.addEventListener('pointerdown', (ev) => {
    const target = ev.target as Node | null;
    if (qres.hidden || !target || searchWrap.contains(target)) return;
    h.onCloseSearch();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !qres.hidden) h.onCloseSearch();
  });

  const toast = el('div', 'toast');
  const toastMsg = el('span', 'toast-msg');
  const toastUndo = el('button', 'toast-undo', '取り消す');
  toastUndo.hidden = true;
  toast.append(toastMsg, toastUndo);
  toast.hidden = true;

  // ---- overview (総合管理) and graph replace the board while on
  const overview = el('section', 'ov');
  overview.hidden = true;
  const graph = el('section', 'graph');
  graph.hidden = true;
  const gantt = el('section', 'gantt');
  gantt.hidden = true;

  // ---- right-hand panes (same look as the deliverables panel, one at a time)
  const mkPane = (title: string, onClose: () => void) => {
    const aside = el('aside', 'panel pane');
    aside.hidden = true;
    const head = el('div', 'panel-h');
    const close = el('button', 'ic', '×');
    close.type = 'button';
    close.title = '閉じる';
    close.addEventListener('click', onClose);
    head.append(el('h2', undefined, title), close);
    const body = el('div', 'panel-body');
    aside.append(head, body);
    return { aside, body };
  };
  const tplPane = mkPane('テンプレート', () => h.onTogglePane('templates'));
  const viewPane = mkPane('ビュー', () => h.onTogglePane('views'));
  const notifPane = mkPane('通知', () => h.onTogglePane('notifications'));

  root.append(top, errBar, loopBar, locksBar, empty, board, overview, graph, gantt, focus, panelWrap,
    tplPane.aside, viewPane.aside, notifPane.aside, toast);
  return {
    root, top, h, select, newName, status, errBar, empty, board,
    focus, focusCount, focusList, focusEmpty, focusBtn, panelBtns, toast, toastMsg, toastUndo,
    panelWrap,
    panelDeliv: delivPanel.aside, panelDelivHead: delivPanel.head, panelDelivBody: delivPanel.body, panelDelivSig: '',
    panelHist: histPanel.aside, panelHistHead: histPanel.head, panelHistBody: histPanel.body, panelHistSig: '',
    q, qres, searchAllBtn, notifBtn, notifCounts, overviewBtn, graphBtn, ganttBtn, viewsBtn, templatesBtn,
    loopBar, loopStatus, loopText, loopNext, loopStart, loopStop, loopTick,
    overview, overviewSig: '', graph, graphSig: '', gantt, locks: locksBar, locksText, locksSig: '',
    paneTemplates: tplPane.aside, paneViews: viewPane.aside, paneNotif: notifPane.aside,
    paneSig: { templates: '', views: '', notif: '' },
    cols: new Map(), cards: new Map(), focusRows: new Map(), projectSig: '', focusSig: '',
  };
}

function makeColumn(id: string, h: Handlers): ColView {
  const section = el('section', 'col');
  section.dataset.col = id;
  const head = el('div', 'col-h');
  const name = el('h2', 'col-name');
  const count = el('span', 'col-count');
  const editBtn = el('button', 'ic', '⚙');
  editBtn.type = 'button';
  editBtn.title = '列名と WIP 上限を編集';
  head.append(name, count, editBtn);

  // Inline column editor: empty WIP input means "no limit" (null on the wire).
  const editEl = el('form', 'col-edit');
  editEl.hidden = true;
  const editName = el('input', 'ce-name');
  editName.placeholder = '列名';
  editName.setAttribute('aria-label', 'column name');
  const editWip = el('input', 'ce-wip');
  editWip.type = 'number';
  editWip.min = '0';
  editWip.step = '1';
  editWip.placeholder = 'WIP上限（空=無制限）';
  editWip.setAttribute('aria-label', 'wip limit');
  const editSave = el('button', 'primary', '保存');
  editSave.type = 'submit';
  const editCancel = el('button', 'ghost', '×');
  editCancel.type = 'button';
  const editNote = el('div', 'ce-err');
  editNote.hidden = true;
  editEl.append(editName, editWip, editSave, editCancel, editNote);

  editBtn.addEventListener('click', () => {
    editEl.hidden = !editEl.hidden;
    editNote.hidden = true;
    if (editEl.hidden) return;
    // Seed from the rendered column so a rename does not silently reset the WIP limit.
    editName.value = name.textContent ?? '';
    editWip.value = section.dataset.wip ?? '';
    editName.focus();
  });
  editCancel.addEventListener('click', () => { editEl.hidden = true; editNote.hidden = true; });
  editEl.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const patch: { name?: string; wipLimit?: number | null } = { wipLimit: null };
    const nm = editName.value.trim();
    if (nm) patch.name = nm;
    const wip = editWip.value.trim();
    if (wip !== '') {
      const n = Number(wip);
      if (!Number.isFinite(n) || n < 0) {
        editNote.textContent = 'WIP 上限は 0 以上の数値で入力する（空=無制限）';
        editNote.hidden = false;
        return;
      }
      patch.wipLimit = Math.trunc(n);
    }
    void h.onEditColumn(id, patch).then(err => {
      if (err) { editNote.textContent = err; editNote.hidden = false; return; }
      editNote.hidden = true;
      editEl.hidden = true;
    });
  });

  const list = el('div', 'cards');
  const add = el('form', 'addrow');
  const input = el('input');
  input.placeholder = 'タスクを追加';
  input.setAttribute('aria-label', 'add card');
  const btn = el('button', undefined, '追加');
  btn.type = 'submit';
  add.append(input, btn);
  add.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    void h.onAddCard(id, title).then(ok => { if (ok) input.value = ''; });
  });

  // Drop target only: the move itself stays onMove → moveCard. A same-column drop is a no-op
  // inside the repository, so it costs one round trip and changes nothing.
  const clearDrop = () => section.classList.remove('drop');
  section.addEventListener('dragover', (ev) => {
    ev.preventDefault(); // without this the browser refuses the drop
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    section.classList.add('drop');
  });
  // Entering a child fires dragleave on the section too; keep the highlight while still inside.
  section.addEventListener('dragleave', (ev) => {
    if (!section.contains(ev.relatedTarget as Node | null)) clearDrop();
  });
  section.addEventListener('drop', (ev) => {
    ev.preventDefault();
    clearDrop();
    const key = ev.dataTransfer?.getData('text/plain');
    if (key) h.onMove(key, id);
  });

  section.append(head, editEl, list, add);
  return { el: section, name, count, list, editEl, editName, editWip, editNote };
}

/** The buttons that move a card out of its column (shared by board cards and focus rows). */
function fillMoves(moves: HTMLElement, card: Card, s: Store, key: CardKey, h: Handlers): void {
  moves.textContent = '';
  for (const id of s.columnOrder) {
    const col: ColumnDef | undefined = s.columns[id];
    if (!col || id === card.columnId) continue;
    const b = el('button', 'mv', `→ ${col.name}`);
    b.type = 'button';
    b.dataset.col = id;
    moves.append(b);
  }
  moves.hidden = moves.childElementCount === 0;
  moves.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest('button[data-col]');
    if (b) h.onMove(key, (b as HTMLElement).dataset.col as string);
  };
}

function makeCardNode(key: CardKey, h: Handlers): HTMLElement {
  const node = el('div', 'card');
  node.dataset.key = key;
  // HTML5 DnD: the whole card is the handle, the key rides in text/plain for the column's drop.
  node.draggable = true;
  node.addEventListener('dragstart', (ev) => {
    node.classList.add('dragging');
    ev.dataTransfer?.setData('text/plain', key);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  });
  node.addEventListener('dragend', () => node.classList.remove('dragging'));
  const head = el('div', 'card-h');
  const prio = el('span', 'prio');
  const cid = el('span', 'cid');
  const due = el('span', 'due');
  const open = el('button', 'ic', '⤢');
  open.type = 'button';
  open.title = '詳細・依存・履歴';
  const edit = el('button', 'ic', '✎');
  edit.type = 'button';
  edit.title = 'タイトルを編集';
  const del = el('button', 'ic', '×');
  del.type = 'button';
  del.title = '削除';
  open.addEventListener('click', () => h.onOpen(node.dataset.key as CardKey));
  edit.addEventListener('click', () => h.onEdit(node.dataset.key as CardKey));
  del.addEventListener('click', () => h.onDelete(node.dataset.key as CardKey));
  head.append(prio, cid, due, open, edit, del);

  const title = el('div', 'title');
  const meta = el('div', 'meta');
  const body = el('div', 'body');
  const deps = el('div', 'deps');
  const moves = el('div', 'moves');

  node.addEventListener('dblclick', (ev) => {
    if ((ev.target as HTMLElement).closest('button, input, select, textarea')) return;
    h.onOpen(node.dataset.key as CardKey);
  });

  node.append(head, title, meta, body, deps, moves);
  return node;
}

function emptyText(s: Store): string {
  // With no project selected the only useful distinction is "the list itself failed" vs "there is none".
  if (!s.projectId) {
    return s.error
      ? 'サーバからプロジェクト一覧を取得できません。上部のエラーを確認してください。'
      : 'プロジェクトがありません。右上の欄で作成してください。';
  }
  if (s.error) return 'ボードを表示できません。';
  return 'ボードを読み込み中…';
}

/** Everything on a card that is not the title/body: priority, owner, due, blocked, acceptance, actor. */
function cardSig(card: Card): string {
  return [card.title, card.body ?? '', card.priority, card.version, card.columnId,
    card.blockedReason ?? '', card.owner ?? '', card.due ?? '', card.closedAt ?? '',
    lastActorOf(card) ?? ''].join('\u0001');
}

function depsSig(s: Store, card: Card): string {
  return [
    ...openBlockers(s, card.id).map(c => `b${c.id}`),
    ...blocksCards(s, card.id).map(c => `o${c.id}`),
  ].join(',');
}

function updateCard(node: HTMLElement, card: Card, s: Store, h: Handlers): void {
  const blockers = openBlockers(s, card.id);
  const blocked = isBlocked(s, card);
  const progress = acceptanceProgress(card.body);

  if (node.dataset.sig !== cardSig(card)) {
    node.dataset.sig = cardSig(card);
    const q = (c: string) => node.querySelector(c) as HTMLElement;
    q('.title').textContent = card.title;
    const body = q('.body');
    body.textContent = card.body ?? '';
    body.hidden = !card.body;
    const prio = q('.prio');
    prio.textContent = `p${card.priority}`;
    prio.classList.toggle('hot', card.priority > 0);

    const cid = q('.cid');
    cid.textContent = `#${card.id}`;

    const due = q('.due');
    const today = new Date().toISOString().slice(0, 10);
    due.textContent = card.due ? card.due : '';
    due.hidden = !card.due;
    due.classList.toggle('overdue', Boolean(card.due && card.due < today && !isClosed(card)));

    const meta = q('.meta');
    meta.textContent = '';
    if (card.owner) meta.append(el('span', 'chip owner', `@${card.owner}`));
    // A2: who last touched it. Null/undefined means "nobody we can name", so nothing is drawn.
    const actor = lastActorOf(card);
    if (actor) {
      const chip = el('span', 'chip actor', `↻ ${actor}`);
      chip.title = `最終更新者: ${actor}`;
      meta.append(chip);
    }
    if (progress.total > 0) {
      const chip = el('span', 'chip acc', `☑ ${progress.done}/${progress.total}`);
      chip.classList.toggle('acc-done', progress.done === progress.total);
      meta.append(chip);
    }
    if (card.blockedReason) meta.append(el('span', 'chip blocked-chip', `⛔ ${card.blockedReason}`));
    meta.hidden = meta.childElementCount === 0;

    node.classList.toggle('blocked', blocked);
    node.classList.toggle('closed', isClosed(card) || isDoneColumn(s, card.columnId));
    const hints = [
      card.blockedReason ? `blocked: ${card.blockedReason}` : null,
      blockers.length ? `blocked by: ${blockers.map(c => `#${c.id} ${c.title}`).join(' / ')}` : null,
      ...(progress.total ? [`acceptance: ${progress.done}/${progress.total}`] : []),
    ].filter(Boolean);
    if (hints.length) node.title = hints.join('\n');
    else node.removeAttribute('title');
  }

  if (node.dataset.depsig !== depsSig(s, card)) {
    node.dataset.depsig = depsSig(s, card);
    const deps = node.querySelector('.deps') as HTMLElement;
    deps.textContent = '';
    for (const b of blockers) {
      const chip = el('span', 'chip dep', `⛔ #${b.id}`);
      chip.title = b.title;
      deps.append(chip);
    }
    for (const o of blocksCards(s, card.id)) {
      const chip = el('span', 'chip dep-out', `→ #${o.id}`);
      chip.title = o.title;
      deps.append(chip);
    }
    deps.hidden = deps.childElementCount === 0;
  }

  // Move targets depend on the column set, not on the card: rebuild only when that changes.
  const colsig = `${s.projectId}|${s.columnOrder.join(',')}|${card.columnId}`;
  if (node.dataset.colsig !== colsig) {
    node.dataset.colsig = colsig;
    fillMoves(node.querySelector('.moves') as HTMLElement, card, s, node.dataset.key as CardKey, h);
  }

  node.classList.toggle('pending', s.pending.has(node.dataset.key as CardKey));
}

function focusRow(key: CardKey, h: Handlers): HTMLElement {
  const row = el('div', 'focus-row');
  row.dataset.key = key;
  const head = el('div', 'fr-h');
  const prio = el('span', 'prio');
  const cid = el('span', 'cid');
  const open = el('button', 'ic', '⤢');
  open.type = 'button';
  open.title = '詳細';
  open.addEventListener('click', () => h.onOpen(row.dataset.key as CardKey));
  head.append(prio, cid, el('div', 'grow'), open);
  const title = el('div', 'title');
  const meta = el('div', 'meta');
  const moves = el('div', 'moves');
  row.append(head, title, meta, moves);
  return row;
}

function delivPanelSig(s: Store): string {
  return [
    s.projectId,
    ...s.deliverables.map(d => `${d.id}:${d.title}:${d.kind}:${d.cardId ?? ''}`),
  ].join('\u0001');
}

function histPanelSig(s: Store): string {
  return [
    s.projectId,
    ...s.timeline.slice(-40).map(e => `${e.seq}:${e.kind}:${e.entityId}`),
  ].join('\u0001');
}

function eventLabel(kind: string): string {
  const map: Record<string, string> = {
    'project.created': '作成', 'project.updated': '更新',
    'card.created': 'カード追加', 'card.updated': 'カード更新',
    'card.moved': '移動', 'card.deleted': '削除',
    'dependency.added': '依存追加', 'dependency.removed': '依存解除',
    'deliverable.created': '成果物追加', 'deliverable.updated': '成果物更新', 'deliverable.deleted': '成果物削除',
  };
  return map[kind] ?? kind;
}

function renderDelivPanel(view: View, s: Store): void {
  const sig = delivPanelSig(s);
  if (view.panelDelivSig === sig) return;
  view.panelDelivSig = sig;
  view.panelDelivHead.textContent = `成果物 (${s.deliverables.length})`;
  view.panelDelivBody.textContent = '';

  const delSec = el('section', 'p-sec');
  const addForm = el('form', 'p-add');
  const addInput = el('input');
  addInput.placeholder = '成果物を追加';
  addInput.setAttribute('aria-label', 'add deliverable');
  const addBtn = el('button', undefined, '追加');
  addBtn.type = 'submit';
  addForm.append(addInput, addBtn);
  addForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const title = addInput.value.trim();
    if (!title) return;
    void view.h.onAddDeliverable(title).then(ok => { if (ok) addInput.value = ''; });
  });
  delSec.append(addForm);

  const list = el('div', 'p-list');
  if (!s.deliverables.length) list.append(el('div', 'p-empty', '成果物はまだない'));
  for (const d of s.deliverables) {
    const row = el('div', 'p-row');
    const main = el('div', 'p-main');
    const t = el('div', 'p-title', d.title);
    t.title = d.title;
    main.append(t);
    const sub = el('div', 'p-sub');
    sub.append(el('span', 'chip kind', d.kind));
    if (d.ref) sub.append(refLink(d));
    if (d.cardId !== null && d.cardId !== undefined) {
      const link = el('button', 'link', `#${d.cardId}`);
      link.type = 'button';
      link.addEventListener('click', () => {
        const key = cardKey(s.projectId as string, d.cardId as number);
        if (s.cards[key]) view.h.onOpen(key);
        else showToast(view, `カード #${d.cardId} はもう無い`);
      });
      sub.append(link);
    }
    main.append(sub);
    const shot = refImageThumb(d);
    if (shot) main.append(shot);
    const thumbs = thumbStrip(s.attachments.filter(a => a.deliverableId === d.id), d.projectId);
    if (thumbs) main.append(thumbs);
    const rm = el('button', 'ic', '×');
    rm.type = 'button';
    rm.title = '成果物を削除';
    rm.addEventListener('click', () => view.h.onDeleteDeliverable(d.projectId, d.id));
    row.append(main, rm);
    list.append(row);
  }
  delSec.append(list);
  view.panelDelivBody.append(delSec);
}

function renderHistPanel(view: View, s: Store): void {
  const sig = histPanelSig(s);
  if (view.panelHistSig === sig) return;
  view.panelHistSig = sig;
  view.panelHistBody.textContent = '';

  const tlSec = el('section', 'p-sec');
  const tl = el('div', 'p-list tl');
  if (!s.timeline.length) tl.append(el('div', 'p-empty', '出来事はまだない'));
  for (const e of s.timeline.slice(-40).reverse()) {
    const row = el('div', 'tl-row');
    const at = el('span', 'tl-at', e.at.slice(5, 16).replace('T', ' '));
    const what = el('span', 'tl-kind', eventLabel(e.kind));
    row.append(at, what);
    const target = e.entityType === 'card' || e.entityType === 'deliverable' ? e.entityId : '';
    if (target) {
      row.append(el('span', 'tl-id', target.slice(target.indexOf('#') + 1)));
      // A card event opens the card it happened to (composite id: project#id).
      if (e.entityType === 'card') {
        const key = e.entityId as CardKey;
        if (s.cards[key]) {
          row.classList.add('clickable');
          row.addEventListener('click', () => view.h.onOpen(key));
        }
      }
    }
    tl.append(row);
  }
  tlSec.append(tl);
  view.panelHistBody.append(tlSec);
}

function renderFocus(view: View, s: Store): void {
  view.focus.hidden = !s.focus || !s.projectId;
  if (!view.focus.hidden) {
    const ready = readyCards(s);
    const sig = [s.projectId, ...ready.map(c => `${c.id}:${c.version}:${c.title}:${c.priority}:${c.owner ?? ''}:${c.due ?? ''}`)].join('|');
    view.focusCount.textContent = String(ready.length);
    if (view.focusSig !== sig) {
      view.focusSig = sig;
      const els: HTMLElement[] = [];
      for (const card of ready) {
        const key = cardKey(card.projectId, card.id);
        let row = view.focusRows.get(key);
        if (!row) { row = focusRow(key, view.h); view.focusRows.set(key, row); }
        (row.querySelector('.prio') as HTMLElement).textContent = `p${card.priority}`;
        (row.querySelector('.cid') as HTMLElement).textContent = `#${card.id}`;
        (row.querySelector('.title') as HTMLElement).textContent = card.title;
        const meta = row.querySelector('.meta') as HTMLElement;
        meta.textContent = '';
        meta.append(el('span', 'chip', s.columns[card.columnId]?.name ?? card.columnId));
        if (card.owner) meta.append(el('span', 'chip owner', `@${card.owner}`));
        if (card.due) meta.append(el('span', 'chip', `due ${card.due}`));
        const progress = acceptanceProgress(card.body);
        if (progress.total) meta.append(el('span', 'chip acc', `☑ ${progress.done}/${progress.total}`));
        fillMoves(row.querySelector('.moves') as HTMLElement, card, s, key, view.h);
        row.classList.toggle('pending', s.pending.has(key));
        els.push(row);
      }
      keyedDiff(view.focusList, els);
    }
    view.focusEmpty.hidden = ready.length > 0;
  }
  const staleRows: CardKey[] = [];
  const live = new Set(s.focus && s.projectId ? readyCards(s).map(c => cardKey(c.projectId, c.id)) : []);
  for (const key of view.focusRows.keys()) if (!live.has(key)) staleRows.push(key);
  for (const key of staleRows) {
    view.focusRows.get(key)?.remove();
    view.focusRows.delete(key);
  }
}

const REF_IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** `ref` is a full path: the chip shows the file name and keeps the path in the tooltip. */
const refName = (ref: string): string => ref.split(/[\\/]/).pop() || ref;

/** The chip opens the readable view of the ref in a new tab. */
function refLink(d: Deliverable): HTMLElement {
  const link = el('a', 'chip', refName(d.ref));
  link.href = deliverableViewSrc(d.projectId, d.id);
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = d.ref;
  return link;
}

/** An image ref gets a thumbnail too; its `src` is the raw bytes, the click opens the view. */
function refImageThumb(d: Deliverable): HTMLElement | null {
  if (!REF_IMAGE.test(d.ref)) return null;
  const a = el('a', 'thumbs');
  a.href = deliverableViewSrc(d.projectId, d.id);
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = d.ref;
  const img = el('img', 'thumb');
  img.src = deliverableFileSrc(d.projectId, d.id);
  img.alt = refName(d.ref);
  img.loading = 'lazy';
  a.append(img);
  return a;
}

export function thumbStrip(list: Attachment[], projectId: string): HTMLElement | null {
  if (!list.length) return null;
  const wrap = el('div', 'thumbs');
  for (const a of list) {
    if (a.mime.startsWith('image/')) {
      const img = el('img', 'thumb');
      img.loading = 'lazy';
      img.src = attachmentSrc(projectId, a.id);
      img.alt = a.name;
      img.title = a.name;
      wrap.append(img);
    } else {
      // Same split as the detail strip: only images paint, everything else opens through /view.
      const doc = el('a', 'thumb doc');
      doc.href = attachmentViewSrc(projectId, a.id);
      doc.target = '_blank';
      doc.rel = 'noopener';
      doc.textContent = docLabel(a.mime);
      doc.title = a.name;
      wrap.append(doc);
    }
  }
  return wrap;
}

function docLabel(mime: string): string {
  if (mime === 'application/pdf') return 'PDF';
  if (mime.startsWith('video/')) return '動画';
  if (mime.startsWith('audio/')) return '音声';
  if (mime.includes('zip')) return 'ZIP';
  return '文書';
}

// ---------------------------------------------------------------- v2 surfaces

function renderSearch(view: View, s: Store): void {
  const hits = s.hits;
  view.qres.hidden = hits === null;
  if (hits === null) return;
  const sig = `${s.searchAll}|${hits.map(h => `${h.projectId}:${h.type}:${h.id}:${h.title}`).join('\u0001')}`;
  if (view.qres.dataset.sig === sig) return;
  view.qres.dataset.sig = sig;
  view.qres.textContent = '';
  if (!hits.length) {
    view.qres.append(el('div', 'p-empty', '該当なし'));
    return;
  }
  for (const hit of hits) {
    const row = el(hit.type === 'card' ? 'button' : 'div', 'q-hit');
    row.setAttribute('role', 'option');
    if (row instanceof HTMLButtonElement) {
      row.type = 'button';
      row.addEventListener('click', () => view.h.onOpenHit(hit));
    }
    const top = el('div', 'q-h');
    top.append(el('span', 'q-type', hit.type === 'card' ? 'カード' : '成果物'), el('span', 'cid', `#${hit.id}`));
    // 全板: the hit's board is the only thing that tells two #12s apart, so name it.
    if (s.searchAll) {
      const name = s.projects.find(x => x.slug === hit.projectId)?.name ?? hit.projectId;
      const onBoard = hit.projectId === s.projectId;
      top.append(el('span', onBoard ? 'chip' : 'chip other-board', name));
    }
    if (hit.columnId && hit.projectId === s.projectId) {
      top.append(el('span', 'chip', s.columns[hit.columnId]?.name ?? hit.columnId));
    }
    const title = el('div', 'q-title', hit.title);
    row.append(top, title);
    if (hit.snippet && hit.snippet !== hit.title) row.append(el('div', 'q-snip', hit.snippet));
    view.qres.append(row);
  }
}

const LEVEL_LABEL: Record<NotificationLevel, string> = { danger: '危険', warn: '警告', info: '情報' };
const LEVELS: NotificationLevel[] = ['danger', 'warn', 'info'];

// The toolbar button carries the per-level counts, so the numbers are readable without opening it.
function renderNotifBadges(view: View, s: Store): void {
  const counts = LEVELS.map(level => s.notifications.filter(n => n.level === level).length);
  LEVELS.forEach((level, i) => {
    const badge = view.notifCounts[level];
    badge.textContent = counts[i] ? String(counts[i]) : '';
    badge.hidden = counts[i] === 0;
    badge.title = `${LEVEL_LABEL[level]} ${counts[i]} 件`;
  });
  view.notifBtn.setAttribute('aria-label', `通知 危険 ${counts[0]} 警告 ${counts[1]} 情報 ${counts[2]}`);
}

/** `tick 3 · 次 12s` — the countdown is redrawn every second, so the text lives in one function. */
export function loopBarText(loop: LoopInfo, now: number = Date.now()): string {
  const bits = [`tick ${loop.ticks}`];
  if (loop.nextTickAt) {
    const left = Math.ceil((Date.parse(loop.nextTickAt) - now) / 1000);
    bits.push(left > 0 ? `次 ${left}s` : 'まもなく');
  }
  if (loop.haltReason) bits.push(`理由: ${loop.haltReason}`);
  return bits.join(' · ');
}

function renderLoop(view: View, s: Store): void {
  const loop = s.loop;
  view.loopBar.hidden = !s.projectId || !loop;
  if (!s.projectId || !loop) return;
  view.loopStatus.textContent = loop.status === 'running' ? '稼働中' : loop.status === 'halted' ? '停止' : '待機';
  view.loopStatus.className = `loop-st ${loop.status}`;
  view.loopText.dataset.nextTickAt = loop.nextTickAt ?? '';
  view.loopText.textContent = loopBarText(loop);
  view.loopText.title = loop.haltReason ?? '';
  view.loopNext.hidden = loop.nextCardId === null;
  if (loop.nextCardId !== null) {
    view.loopNext.dataset.id = String(loop.nextCardId);
    view.loopNext.textContent = `次: #${loop.nextCardId}`;
  }
  view.loopStart.disabled = loop.status === 'running';
  view.loopStop.disabled = loop.status !== 'running';
  view.loopTick.disabled = loop.status !== 'running';
}

function paneBody(aside: HTMLElement): HTMLElement {
  const body = aside.querySelector('.panel-body');
  return body instanceof HTMLElement ? body : aside;
}

function renderNotifications(view: View, s: Store): void {
  if (view.paneNotif.hidden) { view.paneSig.notif = ''; return; }
  const sig = [
    s.projectId,
    ...s.notifications.map(n => `${n.level}:${n.kind}:${n.cardId ?? ''}:${n.title}:${n.detail}`),
  ].join('\u0001');
  if (view.paneSig.notif === sig) return;
  view.paneSig.notif = sig;
  const body = paneBody(view.paneNotif);
  body.textContent = '';
  if (!s.notifications.length) {
    body.append(el('div', 'p-empty', '通知はない'));
    return;
  }
  for (const level of LEVELS) {
    const group = s.notifications.filter(n => n.level === level);
    if (!group.length) continue;
    const sec = el('section', 'p-sec');
    sec.append(el('h3', `p-h lv-${level}`, `${LEVEL_LABEL[level]} (${group.length})`));
    const list = el('div', 'p-list');
    for (const n of group) {
      const row = el('div', 'p-row');
      const main = el('div', 'p-main');
      const title = el('div', 'p-title', n.title);
      title.title = n.title;
      main.append(title);
      const sub = el('div', 'p-sub');
      sub.append(el('span', 'chip kind', n.kind));
      if (n.cardId != null) sub.append(el('span', 'cid', `#${n.cardId}`));
      if (n.detail) sub.append(el('span', 'p-note', n.detail));
      main.append(sub);
      row.append(main);
      if (n.cardId != null) {
        row.classList.add('clickable');
        row.addEventListener('click', () => view.h.onOpenCard(n.cardId as number));
      }
      list.append(row);
    }
    sec.append(list);
    body.append(sec);
  }
}

function renderTemplates(view: View, s: Store): void {
  if (view.paneTemplates.hidden) { view.paneSig.templates = ''; return; }
  const sig = [s.projectId, ...s.templates.map(t => `${t.id}:${t.name}:${t.title}:${t.columnId ?? ''}`)].join('\u0001');
  if (view.paneSig.templates === sig) return;
  view.paneSig.templates = sig;
  const body = paneBody(view.paneTemplates);
  body.textContent = '';
  if (!s.templates.length) {
    body.append(el('div', 'p-empty', 'テンプレートはまだない（カードを開いて「テンプレート化」）'));
    return;
  }
  const list = el('div', 'p-list');
  for (const t of s.templates) {
    const row = el('div', 'p-row');
    const main = el('div', 'p-main');
    const title = el('div', 'p-title', t.name);
    title.title = t.name;
    main.append(title);
    const sub = el('div', 'p-sub');
    sub.append(el('span', 'chip', t.title));
    sub.append(el('span', 'chip', `p${t.priority}`));
    if (t.columnId) sub.append(el('span', 'chip', s.columns[t.columnId]?.name ?? t.columnId));
    main.append(sub);
    const use = el('button', 'link', '使う');
    use.type = 'button';
    use.title = 'このテンプレートからカードを作る';
    use.addEventListener('click', () => view.h.onUseTemplate(t.id));
    const rm = el('button', 'ic', '×');
    rm.type = 'button';
    rm.title = 'テンプレートを削除';
    rm.addEventListener('click', () => view.h.onDeleteTemplate(t.id));
    row.append(main, use, rm);
    list.append(row);
  }
  body.append(list);
}

function renderViews(view: View, s: Store): void {
  if (view.paneViews.hidden) { view.paneSig.views = ''; return; }
  // The form and the focus checkbox are built once: rebuilding them on every keystroke would
  // eat what the user is typing into the name field. Only the list is signature-guarded.
  let body = paneBody(view.paneViews);
  if (body.dataset.built !== '1') {
    body.dataset.built = '1';
    body.textContent = '';
    const form = el('form', 'p-add');
    const nameInput = el('input');
    nameInput.setAttribute('aria-label', 'view name');
    const save = el('button', undefined, '保存');
    save.type = 'submit';
    form.append(nameInput, save);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      void view.h.onSaveView(name).then(ok => { if (ok) nameInput.value = ''; });
    });
    const focus = el('label', 'ce-focus');
    const box = el('input');
    box.type = 'checkbox';
    box.addEventListener('change', () => view.h.onToggleFocusQuery(box.checked));
    focus.append(box, el('span', undefined, 'ボードもこの条件で絞り込む'));
    body.append(form, focus, el('div', 'p-list'));
  }

  const nameInput = body.querySelector('.p-add input');
  if (nameInput instanceof HTMLInputElement) nameInput.placeholder = s.q ? `「${s.q}」をビューとして保存` : 'ビュー名';
  const focusLabel = body.querySelector('.ce-focus');
  if (focusLabel instanceof HTMLElement) {
    focusLabel.hidden = !s.q;
    const box = focusLabel.querySelector('input');
    if (box instanceof HTMLInputElement) box.checked = s.qFocus;
  }

  const sig = [s.projectId, ...s.views.map(v => `${v.id}:${v.name}:${v.query.q ?? ''}:${v.query.focus ? 1 : 0}`)].join('\u0001');
  if (view.paneSig.views === sig) return;
  view.paneSig.views = sig;
  const list = body.querySelector('.p-list');
  if (!(list instanceof HTMLElement)) return;
  list.textContent = '';

  if (!s.views.length) list.append(el('div', 'p-empty', 'ビューはまだない'));
  for (const v of s.views) {
    const row = el('div', 'p-row');
    const main = el('div', 'p-main');
    const title = el('div', 'p-title', v.name);
    title.title = v.name;
    main.append(title);
    const sub = el('div', 'p-sub');
    sub.append(el('span', 'chip', v.query.q ? `q: ${v.query.q}` : '条件なし'));
    if (v.query.focus) sub.append(el('span', 'chip', '絞り込み'));
    main.append(sub);
    const apply = el('button', 'link', '適用');
    apply.type = 'button';
    apply.addEventListener('click', () => view.h.onApplyView(v.id));
    const rm = el('button', 'ic', '×');
    rm.type = 'button';
    rm.title = 'ビューを削除';
    rm.addEventListener('click', () => view.h.onDeleteView(v.id));
    row.append(main, apply, rm);
    list.append(row);
  }
}

function renderOverview(view: View, s: Store): void {
  view.overview.hidden = !s.overview;
  if (!s.overview) { view.overviewSig = ''; return; }
  const sig = s.overviewRows
    .map(r => `${r.projectId}:${r.loop}:${r.counts.total}:${r.counts.blocked}:${r.counts.wipOver}:${r.columns.map(c => `${c.id}=${c.count}/${c.wipLimit ?? '-'}`).join(',')}`)
    .join('|');
  if (view.overviewSig === sig) return;
  view.overviewSig = sig;
  view.overview.textContent = '';

  const head = el('div', 'ov-h');
  head.append(el('h2', undefined, '総合管理'), el('span', 'ov-n', `${s.overviewRows.length} プロジェクト`));
  view.overview.append(head);
  if (!s.overviewRows.length) {
    view.overview.append(el('div', 'empty', 'プロジェクトが無い'));
    return;
  }
  const rows = el('div', 'ov-rows');
  for (const row of s.overviewRows) {
    const slug = s.projects.find(p => p.projectId === row.projectId)?.slug ?? row.projectId;
    const b = el('button', 'ov-row');
    b.type = 'button';
    b.title = `${row.name} のボードを開く`;
    b.append(el('div', 'ov-name', row.name));
    if (row.loop !== 'idle') {
      const live = el('span', 'ov-loop', row.loop === 'running' ? '自走中' : '停止');
      live.classList.add(row.loop === 'running' ? 'on' : 'halt');
      b.append(live);
    }

    const cols = el('div', 'ov-cols');
    for (const c of row.columns) {
      const chip = el('span', 'ov-col');
      chip.append(el('span', 'ov-col-n', c.name));
      const over = c.wipLimit !== null && c.count > c.wipLimit;
      chip.append(el('span', 'ov-col-c', c.wipLimit !== null ? `${c.count}/${c.wipLimit}` : String(c.count)));
      if (over) chip.classList.add('over');
      if (c.kind === 'done') chip.classList.add('done');
      cols.append(chip);
    }
    b.append(cols);

    const counts = el('div', 'ov-counts');
    const stats: { label: string; value: number; hot: boolean }[] = [
      { label: '全体', value: row.counts.total, hot: false },
      { label: '未完了', value: row.counts.open, hot: false },
      { label: '着手可', value: row.counts.ready, hot: false },
      { label: 'ブロック', value: row.counts.blocked, hot: row.counts.blocked > 0 },
      { label: '期限切れ', value: row.counts.overdue, hot: row.counts.overdue > 0 },
      { label: 'WIP超', value: row.counts.wipOver, hot: row.counts.wipOver > 0 },
    ];
    for (const st of stats) {
      const cell = el('span', 'ov-c', `${st.label} ${st.value}`);
      if (st.hot) cell.classList.add('hot');
      counts.append(cell);
    }
    b.append(counts);

    b.addEventListener('click', () => view.h.onProject(slug));
    rows.append(b);
  }
  view.overview.append(rows);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, cls?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  if (cls) node.setAttribute('class', cls);
  return node;
}

function renderGraph(view: View, s: Store): void {
  const on = s.graph && !s.overview && Boolean(s.projectId);
  view.graph.hidden = !on;
  if (!on) { view.graphSig = ''; return; }
  const layout: GraphLayout | null = s.graphLayout;
  const sig = layout
    ? `${s.projectId}|${layout.layers}|${layout.nodes.map(n => `${n.id}:${n.layer}:${n.closed}:${n.blocked}`).join(',')}|${layout.edges.map(e => `${e.from}>${e.to}`).join(',')}`
    : `none:${s.projectId}`;
  if (view.graphSig === sig) return;
  view.graphSig = sig;
  view.graph.textContent = '';

  const head = el('div', 'ov-h');
  head.append(el('h2', undefined, '依存マップ'), el('span', 'ov-n', layout ? `${layout.nodes.length} ノード / ${layout.edges.length} 依存` : ''));
  view.graph.append(head);
  if (!layout) { view.graph.append(el('div', 'empty', '読み込み中…')); return; }
  if (!layout.nodes.length) { view.graph.append(el('div', 'empty', 'カードが無い')); return; }

  const NW = 190, NH = 34, GX = 70, GY = 46, PAD = 18;
  const byLayer = new Map<number, GraphNode[]>();
  for (const n of layout.nodes) {
    const list = byLayer.get(n.layer) ?? [];
    list.push(n);
    byLayer.set(n.layer, list);
  }
  const layers = Math.max(1, layout.layers, ...[...byLayer.keys()].map(k => k + 1));
  const deepest = Math.max(...[...byLayer.values()].map(v => v.length));
  const pos = new Map<number, { x: number; y: number }>();
  for (const [layer, list] of byLayer) {
    list.sort((a, b) => a.id - b.id);
    list.forEach((n, i) => pos.set(n.id, { x: PAD + layer * (NW + GX), y: PAD + i * (NH + GY) }));
  }

  const width = PAD * 2 + layers * NW + (layers - 1) * GX;
  const height = PAD * 2 + deepest * NH + Math.max(0, deepest - 1) * GY;
  const svg = svgEl('svg', 'gsvg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '依存マップ。ノードを押すとカードが開く');

  // One arrowhead reused by every edge: direction is the point of a dependency map.
  const defs = svgEl('defs');
  const marker = svgEl('marker');
  marker.setAttribute('id', 'garrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '7');
  marker.setAttribute('markerHeight', '7');
  marker.setAttribute('orient', 'auto');
  const tip = svgEl('path');
  tip.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  tip.setAttribute('class', 'garrow');
  marker.append(tip);
  defs.append(marker);
  svg.append(defs);

  for (const e of layout.edges) {
    const from = pos.get(e.from);
    const to = pos.get(e.to);
    if (!from || !to) continue;
    const x1 = from.x + NW, y1 = from.y + NH / 2;
    const x2 = to.x, y2 = to.y + NH / 2;
    const path = svgEl('path', 'gedge');
    const bend = Math.max(24, (x2 - x1) / 2);
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute('marker-end', 'url(#garrow)');
    const title = svgEl('title');
    title.textContent = `#${e.from} → #${e.to}`;
    path.append(title);
    svg.append(path);
  }

  for (const n of layout.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const g = svgEl('g', 'gnode');
    if (n.closed) g.classList.add('closed');
    if (n.blocked) g.classList.add('blocked');
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    const rect = svgEl('rect');
    rect.setAttribute('x', String(p.x));
    rect.setAttribute('y', String(p.y));
    rect.setAttribute('width', String(NW));
    rect.setAttribute('height', String(NH));
    rect.setAttribute('rx', '8');
    const idText = svgEl('text');
    idText.setAttribute('x', String(p.x + 10));
    idText.setAttribute('y', String(p.y + NH / 2 + 4));
    idText.setAttribute('class', 'gid');
    idText.textContent = `#${n.id}`;
    const titleText = svgEl('text');
    titleText.setAttribute('x', String(p.x + 48));
    titleText.setAttribute('y', String(p.y + NH / 2 + 4));
    titleText.setAttribute('class', 'gtitle');
    const short = n.title.length > 13 ? `${n.title.slice(0, 13)}…` : n.title;
    titleText.textContent = short;
    const tip = svgEl('title');
    tip.textContent = `#${n.id} ${n.title}`;
    g.append(rect, idText, titleText, tip);
    g.addEventListener('click', () => view.h.onOpenCard(n.id));
    g.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); view.h.onOpenCard(n.id); }
    });
    svg.append(g);
  }

  const scroll = el('div', 'gscroll');
  scroll.append(svg);
  view.graph.append(scroll);
  view.graph.append(el('div', 'ov-n', '閉じたカードは淡く、ブロック中は枠線付き'));
}

function renderLocks(view: View, s: Store): void {
  const locks = s.projectId ? s.locks : [];
  view.locks.hidden = locks.length === 0;
  if (!locks.length) { view.locksSig = ''; return; }
  const sig = locks.map(l => `${l.resource}:${l.owner}:${l.expiresAt}`).join('\u0001');
  if (view.locksSig === sig) return;
  view.locksSig = sig;
  view.locksText.textContent = locks
    .map(l => `板${s.projectName ? `「${s.projectName}」` : ''}を ${l.owner} が保持${l.expiresAt ? `（〜${l.expiresAt.slice(5, 16).replace('T', ' ')}）` : ''}`)
    .join(' · ');
}

export function renderView(view: View, s: Store): void {
  const projectSig = `${s.projects.map(p => `${p.slug}:${p.name}`).join('|')}#${s.projectId ?? ''}`;
  if (view.projectSig !== projectSig) {
    view.projectSig = projectSig;
    view.select.textContent = '';
    if (!s.projects.length) {
      const o = el('option', undefined, '(なし)');
      o.value = '';
      view.select.append(o);
    }
    for (const p of s.projects) {
      const o = el('option', undefined, p.name || p.slug);
      o.value = p.slug;
      view.select.append(o);
    }
    view.select.value = s.projectId ?? '';
  }

  view.focusBtn.classList.toggle('on', s.focus);
  view.focusBtn.setAttribute('aria-pressed', String(s.focus));
  for (const [id, btn] of Object.entries(view.panelBtns) as [PanelKey, HTMLButtonElement][]) {
    btn.classList.toggle('on', s.panels[id]);
    btn.setAttribute('aria-pressed', String(s.panels[id]));
  }
  view.panelDeliv.hidden = !s.panels.deliverables || !s.projectId;
  view.panelHist.hidden = !s.panels.timeline || !s.projectId;
  view.panelWrap.classList.toggle('both', !view.panelDeliv.hidden && !view.panelHist.hidden);
  if (view.panelDeliv.hidden) view.panelDelivSig = '';
  else renderDelivPanel(view, s);
  if (view.panelHist.hidden) view.panelHistSig = '';
  else renderHistPanel(view, s);

  // The panels are fixed; park them below the header instead of under it.
  view.root.style.setProperty('--top-h', `${view.top.offsetHeight}px`);

  view.status.textContent = [
    `build ${s.buildHash ?? '–'}`,
    s.version ? `v${s.version}` : null,
    `project ${s.projectId ?? '–'}`,
    s.generation ? `gen ${s.generation.slice(0, 12)}` : null,
    s.loading ? '…' : null,
  ].filter(Boolean).join(' · ');

  view.errBar.hidden = !s.error;
  if (s.error) view.errBar.textContent = s.error;

  // Columns: created once per id, then diffed into order.
  const colEls: HTMLElement[] = [];
  for (const id of s.columnOrder) {
    let cv = view.cols.get(id);
    if (!cv) { cv = makeColumn(id, view.h); view.cols.set(id, cv); }
    const col = s.columns[id];
    cv.name.textContent = col.name;
    cv.el.dataset.wip = col.wipLimit === null ? '' : String(col.wipLimit);
    const n = cardsInColumn(s, id).length;
    cv.count.textContent = col.wipLimit !== null ? `${n}/${col.wipLimit}` : String(n);
    const over = col.wipLimit !== null && n > col.wipLimit;
    const at = col.wipLimit !== null && n >= col.wipLimit;
    cv.el.classList.toggle('over-wip', over);
    cv.el.classList.toggle('at-wip', at && !over);
    cv.count.title = at
      ? (over ? `WIP上限超過 (${col.wipLimit})` : `WIP満杯 (${col.wipLimit}) — これ以上入れられない`)
      : '';
    colEls.push(cv.el);
  }
  const staleCols: string[] = [];
  for (const id of view.cols.keys()) if (!s.columnOrder.includes(id)) staleCols.push(id);
  for (const id of staleCols) {
    view.cols.get(id)?.el.remove();
    view.cols.delete(id);
  }
  keyedDiff(view.board, colEls);

  // Cards: per column, keyed by composite id.
  const live = new Set<CardKey>();
  for (const id of s.columnOrder) {
    const cv = view.cols.get(id);
    if (!cv) continue;
    const els: HTMLElement[] = [];
    for (const card of cardsInColumn(s, id)) {
      // A saved view with focus narrows the board; the column counts still show the whole truth.
      if (s.qFocus && s.q.trim() && !cardMatches(card, s.q)) continue;
      const key = cardKey(card.projectId, card.id);
      live.add(key);
      let node = view.cards.get(key);
      if (!node) { node = makeCardNode(key, view.h); view.cards.set(key, node); }
      updateCard(node, card, s, view.h);
      els.push(node);
    }
    keyedDiff(cv.list, els);
  }
  const staleCards: CardKey[] = [];
  for (const key of view.cards.keys()) if (!live.has(key)) staleCards.push(key);

  const isEmpty = !s.projectId || s.columnOrder.length === 0;
  view.empty.hidden = !isEmpty;
  if (isEmpty) {
    view.empty.textContent = emptyText(s);
    view.board.hidden = true;
    view.focus.hidden = true;
  } else {
    view.board.hidden = s.focus;
  }
  renderNotifBadges(view, s);
  renderLoop(view, s);
  renderLocks(view, s);
  renderSearch(view, s);
  renderOverview(view, s);
  renderGraph(view, s);

  // A3: the time view owns its own DOM diff (see renderGantt) — it is rebuilt only when the
  // bars, the axis or the scale actually change, so the 5s poll never steals focus.
  const ganttOn = s.gantt && !s.overview && !s.graph && Boolean(s.projectId);
  view.gantt.hidden = !ganttOn;
  if (ganttOn) {
    renderGantt(view.gantt, Object.values(s.cards), {
      projectId: s.projectId as string, scale: s.ganttScale, now: Date.now(), columns: s.columns,
      onScale: scale => view.h.onGanttScale(scale),
      onOpen: card => view.h.onOpen(cardKey(card.projectId, card.id)),
    });
  }
  view.paneTemplates.hidden = s.pane !== 'templates' || !s.projectId;
  view.paneViews.hidden = s.pane !== 'views' || !s.projectId;
  view.paneNotif.hidden = s.pane !== 'notifications' || !s.projectId;
  renderNotifications(view, s);
  renderTemplates(view, s);
  renderViews(view, s);
  renderFocus(view, s);
  if (s.focus || s.graph || s.overview || s.gantt) view.board.hidden = true;
  if (s.graph || s.overview || s.gantt) view.focus.hidden = true;
  const toggle = (b: HTMLButtonElement, on: boolean): void => {
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  };
  toggle(view.overviewBtn, s.overview);
  toggle(view.graphBtn, s.graph && !s.overview);
  toggle(view.ganttBtn, s.gantt && !s.overview && !s.graph);
  toggle(view.searchAllBtn, s.searchAll);
  toggle(view.viewsBtn, s.pane === 'views');
  toggle(view.templatesBtn, s.pane === 'templates');
  toggle(view.notifBtn, s.pane === 'notifications');
  if (view.q.value !== s.q) view.q.value = s.q;
  const levels: Record<NotificationLevel, number> = { danger: 0, warn: 0, info: 0 };
  for (const n of s.notifications) levels[n.level] += 1;
  for (const level of LEVELS) {
    const node = view.notifCounts[level];
    node.textContent = levels[level] ? String(levels[level]) : '';
    node.hidden = levels[level] === 0;
  }
  view.notifBtn.title = s.notifications.length
    ? `通知 ${s.notifications.length} 件（危険 ${levels.danger} / 警告 ${levels.warn} / 情報 ${levels.info}）`
    : '通知はない';
}
