// Card detail dialog: the fields the board card cannot fit (owner/due/priority/blocked reason),
// the dependency editor, linked deliverables, and this card's slice of the timeline.
// Everything here is project-scoped through the composite CardKey — a bare id never crosses the wire.
import type { Card, Dependency, Deliverable } from '../../src/shared/dto.js';
import type { ProjectRef } from '../../src/shared/api.js';
import type { TimelineEvent } from '../../src/shared/events.js';
import type { DependencyType, PatchCardReq, SessionRef } from '../../src/shared/api.js';
import {
  acceptanceProgress, cardKey, edgesOf, isClosed, keyOf, lastActorOf, parseKey, type CardKey, type Store,
} from './store.js';
import { attachmentSrc, attachmentViewSrc, deliverableViewSrc } from './api.js';

/** The server sniffs bytes anyway; this is only to fail fast with a friendlier sentence. */
const ATTACH_ACCEPT = 'image/*,application/pdf,video/*,audio/*,.md,.txt,.csv,.json,.log,.yaml,.yml,.zip';

export interface DetailHandlers {
  /** Resolves false when the API rejected the patch (details stay open). */
  onSave(key: CardKey, patch: Omit<PatchCardReq, 'version'>): Promise<boolean>;
  onAddDep(key: CardKey, toCard: number, type: DependencyType): Promise<boolean>;
  onRemoveDep(projectId: string, from: number, to: number, type: DependencyType): Promise<boolean>;
  onAddDeliverable(title: string, cardId: number | null): Promise<boolean>;
  onDeleteDeliverable(projectId: string, id: number): Promise<boolean>;
  onMove(key: CardKey, columnId: string): void;
  onDelete(key: CardKey): void;
  /** Resolves false when the upload was rejected; the picker is cleared either way. */
  onUploadAttachment(key: CardKey, file: File): Promise<boolean>;
  onDeleteAttachment(projectId: string, id: number): Promise<boolean>;
  onUploadDeliverableAttachment(deliverableId: number, file: File): Promise<boolean>;
  /** Snapshot this card's fields as a card template. */
  onTemplateFromCard(key: CardKey): void;
  /** The pi sessions of this board's cwd, for the session-name picker. */
  onSessions(projectId: string): Promise<SessionRef[]>;
  notify(message: string): void;
}

export interface DetailView {
  readonly openKey: CardKey | null;
  open(key: CardKey): void;
  close(): void;
  render(s: Store, projects: ProjectRef[]): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function field(label: string, input: HTMLElement): HTMLElement {
  const wrap = el('label', 'f');
  wrap.append(el('span', 'f-l', label), input);
  return wrap;
}

const SESSION_LIST_ID = 'kb-session-names';

/** What the picker shows: the session's own name when the id matches one, else the id's head. */
function sessionLabel(card: Card | null, list: SessionRef[]): string {
  const id = card?.sessionId ?? null;
  if (!id) return '';
  const hit = list.find(s => s.id === id);
  return hit ? hit.name : id.slice(0, 8);
}

/**
 * A known name maps to its id, an empty field clears the session, and an unknown name is a new
 * session: pi mints that id at wake, so the card keeps none (and the user is told).
 */
function sessionIdOfInput(value: string, card: Card | null, list: SessionRef[], unknown: () => void): string | null {
  const wanted = value.trim();
  if (wanted === '') return null;
  const hit = list.find(s => s.name === wanted);
  if (hit) return hit.id;
  if (wanted === sessionLabel(card, list)) return card?.sessionId ?? null;
  unknown();
  return null;
}

export function mountDetail(root: HTMLElement, h: DetailHandlers): DetailView {
  let key: CardKey | null = null;
  let snapshot: Card | null = null;
  // The card stores a session id; the picker shows names, so this is what a name resolves against.
  let sessions: SessionRef[] = [];

  const dlg = el('dialog', 'detail');
  const head = el('div', 'd-h');
  const heading = el('h2', 'd-title');
  // A2: the full actor, one size up from the card chip. Empty when the server has no name.
  const actorLine = el('div', 'd-actor');
  actorLine.hidden = true;
  const closeBtn = el('button', 'ic', '×');
  closeBtn.type = 'button';
  closeBtn.title = '閉じる';
  head.append(heading, actorLine, closeBtn);

  const title = el('input', 'f-title');
  title.placeholder = 'タイトル';
  title.required = true;
  const prio = el('input', 'f-prio');
  prio.type = 'number';
  prio.step = '1';
  const owner = el('input', 'f-owner');
  owner.placeholder = '未割当';
  const due = el('input', 'f-due');
  due.type = 'date';
  const blocked = el('input', 'f-blocked');
  blocked.placeholder = '理由があれば入力（空で解除）';
  const body = el('textarea', 'f-body');
  body.rows = 7;
  body.placeholder = 'メモ・受け入れ条件（- [ ] 項目）';
  const accHint = el('div', 'acc-hint');
  const sessionPick = el('input', 'f-session');
  sessionPick.placeholder = '空なら新規セッション';
  sessionPick.setAttribute('list', SESSION_LIST_ID);
  const sessionOpts = el('datalist');
  sessionOpts.id = SESSION_LIST_ID;

  const grid = el('div', 'd-grid');
  grid.append(
    field('タイトル', title),
    field('優先度', prio),
    field('担当', owner),
    field('期限', due),
    field('ブロック理由', blocked),
    field('セッション', sessionPick),
    field('本文', body),
  );
  grid.append(accHint, sessionOpts);

  // ---- dependencies
  const depSec = el('section', 'd-sec');
  depSec.append(el('h3', undefined, '依存関係'));
  const depList = el('div', 'd-deps');
  const depForm = el('form', 'd-depadd');
  const depTarget = el('select');
  depTarget.setAttribute('aria-label', 'dependency target');
  const depType = el('select');
  for (const [v, t] of [['blocks', 'ブロックする'], ['relates', '関連']] as const) {
    const o = el('option', undefined, t);
    o.value = v;
    depType.append(o);
  }
  const depAdd = el('button', undefined, '追加');
  depAdd.type = 'submit';
  depForm.append(el('span', 'f-l', '対象'), depTarget, depType, depAdd);
  depForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!key) return;
    const to = Number(depTarget.value);
    if (!Number.isFinite(to) || to <= 0) return;
    void h.onAddDep(key, to, depType.value as DependencyType).then(ok => { if (ok) h.notify('依存を追加した'); });
  });
  depSec.append(depList, depForm);

  // ---- deliverables
  const dvSec = el('section', 'd-sec');
  dvSec.append(el('h3', undefined, '成果物'));
  const dvList = el('div', 'd-dvs');
  const dvForm = el('form', 'd-dvadd');
  const dvTitle = el('input');
  dvTitle.placeholder = 'このカードに紐づく成果物';
  dvTitle.setAttribute('aria-label', 'add deliverable for card');
  const dvAdd = el('button', undefined, '追加');
  dvAdd.type = 'submit';
  dvForm.append(dvTitle, dvAdd);
  dvForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!key) return;
    const t = dvTitle.value.trim();
    if (!t) return;
    const id = parseKey(key).id;
    void h.onAddDeliverable(t, id).then(ok => { if (ok) dvTitle.value = ''; });
  });
  dvSec.append(dvList, dvForm);

  // ---- per-card history
  const tlSec = el('section', 'd-sec');
  tlSec.append(el('h3', undefined, 'このカードの履歴'));
  const tlList = el('div', 'd-tl');

  // ---- attachments (the server sniffs the bytes; this list just filters the file picker)
  const atSec = el('section', 'd-sec');
  atSec.append(el('h3', undefined, '添付ファイル'));
  const atList = el('div', 'd-atts');
  const atPick = el('input', 'd-file');
  atPick.type = 'file';
  atPick.accept = ATTACH_ACCEPT;
  atPick.setAttribute('aria-label', 'ファイルを添付');
  atPick.addEventListener('change', () => {
    const file = atPick.files?.[0];
    if (!file || !key) return;
    const k = key;
    void h.onUploadAttachment(k, file).then(ok => { atPick.value = ''; if (ok) h.notify('ファイルを添付した'); });
  });
  atSec.append(atList, atPick);

  // ---- footer
  const foot = el('div', 'd-foot');
  const moveSel = el('select');
  moveSel.setAttribute('aria-label', 'move to column');
  const delBtn = el('button', 'danger', '削除');
  delBtn.type = 'button';
  const tplBtn = el('button', 'ghost', 'テンプレート化');
  tplBtn.type = 'button';
  tplBtn.title = 'このカードの内容を雛形として保存';
  tplBtn.addEventListener('click', () => { if (key) h.onTemplateFromCard(key); });
  const cancelBtn = el('button', 'ghost', '閉じる');
  cancelBtn.type = 'button';
  const saveBtn = el('button', 'primary', '保存');
  saveBtn.type = 'button';
  foot.append(el('div', 'grow'), tplBtn, moveSel, delBtn, cancelBtn, saveBtn);

  dlg.append(head, grid, depSec, dvSec, atSec, tlSec, foot);
  root.append(dlg);

  const close = () => {
    key = null;
    snapshot = null;
    if (dlg.open) dlg.close();
  };
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); close(); });

  saveBtn.addEventListener('click', () => {
    if (!key) return;
    const t = title.value.trim();
    if (!t) { h.notify('タイトルは空にできない'); title.focus(); return; }
    const p = Number(prio.value);
    const patch: Omit<PatchCardReq, 'version'> = {
      title: t,
      priority: Number.isFinite(p) ? Math.trunc(p) : 0,
      owner: owner.value.trim() || null,
      due: due.value.trim() || null,
      blockedReason: blocked.value.trim() || null,
      sessionId: sessionIdOfInput(sessionPick.value, currentCard(key), sessions,
        () => h.notify('その名前のセッションは無い。新規セッションとして起動する')),
      body: body.value,
    };
    void h.onSave(key, patch).then(ok => { if (ok) { h.notify('保存した'); close(); } });
  });

  delBtn.addEventListener('click', () => {
    const k = key;
    if (!k) return;
    if (!window.confirm('このカードを削除する？')) return;
    h.onDelete(k);
    close();
  });

  moveSel.addEventListener('change', () => {
    if (!key || !moveSel.value) return;
    h.onMove(key, moveSel.value);
    moveSel.value = '';
  });

  const open = (k: CardKey) => {
    const parsed = parseKey(k);
    const card = currentCard(k);
    if (!card) { h.notify(`カード #${parsed.id} が見つからない`); return; }
    key = k;
    snapshot = card;
    heading.textContent = `#${card.id} ${card.title}`;
    title.value = card.title;
    prio.value = String(card.priority);
    owner.value = card.owner ?? '';
    due.value = card.due ?? '';
    blocked.value = card.blockedReason ?? '';
    body.value = card.body ?? '';
    // Until the list lands, an id with no name of its own shows as its 8-char prefix.
    sessionPick.value = sessionLabel(card, sessions);
    sessions = [];
    const openedAs = k;
    void h.onSessions(parsed.projectId).then(list => {
      sessions = list;
      sessionOpts.replaceChildren(...list.map(s => {
        const o = el('option');
        o.value = s.name;
        return o;
      }));
      // A slower response must not overwrite a card the user opened meanwhile.
      if (key === openedAs) sessionPick.value = sessionLabel(currentCard(openedAs), list);
    }).catch(() => { /* no list: the field stays free text */ });
    if (store) paint(store, card);
    if (!dlg.open) dlg.showModal();
    title.focus();
  };

  // The dialog reads the live store so a poll landing while it is open never shows dead data.
  let store: Store | null = null;
  function currentCard(k: CardKey): Card | null {
    return store?.cards[k] ?? snapshot;
  }

  function renderDeps(s: Store, card: Card) {
    const edges = edgesOf(s, card.id);
    depList.textContent = '';
    if (!edges.length) depList.append(el('div', 'd-empty', '依存なし'));
    for (const e of edges) {
      const outgoing = e.fromCard === card.id;
      const otherId = outgoing ? e.toCard : e.fromCard;
      const other = s.cards[cardKey(s.projectId as string, otherId)];
      const row = el('div', 'd-dep');
      const label = e.type === 'blocks'
        ? (outgoing ? 'ブロックする' : 'ブロックされている')
        : '関連';
      row.append(el('span', `chip kind${e.type === 'relates' ? ' rel' : ''}`, label));
      const name = el('span', 'd-dep-name', other ? `#${other.id} ${other.title}` : `#${otherId}（不在）`);
      name.title = name.textContent;
      row.append(name);
      if (e.type === 'blocks' && !outgoing && other && !isClosed(other)) row.append(el('span', 'chip warn', '未完了'));
      const rm = el('button', 'ic', '×');
      rm.type = 'button';
      rm.title = '依存を解除';
      rm.addEventListener('click', () => {
        void h.onRemoveDep(e.projectId, e.fromCard, e.toCard, e.type).then(ok => { if (ok) h.notify('依存を解除した'); });
      });
      row.append(rm);
      depList.append(row);
    }
  }

  function renderDepsPicker(s: Store, card: Card) {
    const prev = depTarget.value;
    depTarget.textContent = '';
    for (const id of s.columnOrder) {
      for (const c of Object.values(s.cards)) {
        if (c.columnId !== id || c.projectId !== s.projectId || c.id === card.id) continue;
        const o = el('option', undefined, `#${c.id} ${c.title}`);
        o.value = String(c.id);
        depTarget.append(o);
      }
    }
    if (prev && depTarget.querySelector(`option[value="${prev}"]`)) depTarget.value = prev;
  }

  const docLabel = (mime: string): string => {
    if (mime === 'application/pdf') return 'PDF';
    if (mime.startsWith('video/')) return '動画';
    if (mime.startsWith('audio/')) return '音声';
    if (mime.includes('zip')) return 'ZIP';
    return '文書';
  };

  function thumb(a: { id: number; name: string; mime: string; size: number }, projectId: string, onRemove?: () => Promise<boolean>): HTMLElement {
    const wrap = el('span', 'thumb-w');
    if (a.mime.startsWith('image/')) {
      const img = el('img', 'thumb');
      img.src = attachmentSrc(projectId, a.id);
      img.alt = a.name;
      img.title = a.name;
      wrap.append(img);
    } else {
      // Only images paint in the strip; everything else opens through the shared /view wrapper.
      const link = el('a', 'thumb doc');
      link.href = attachmentViewSrc(projectId, a.id);
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = docLabel(a.mime);
      link.title = `${a.name}（${Math.max(1, Math.round(a.size / 1024))} KB）`;
      wrap.append(link);
    }
    if (onRemove) {
      const rm = el('button', 'ic thumb-x', '×');
      rm.type = 'button';
      rm.title = `${a.name} を外す`;
      rm.addEventListener('click', () => {
        // Hide first: the <img> would otherwise re-request bytes the server already dropped (404 in console).
        wrap.classList.add('gone');
        void onRemove().then(ok => { if (!ok) wrap.classList.remove('gone'); });
      });
      wrap.append(rm);
    }
    return wrap;
  }

  // Signatures: paint() runs on every board poll, so rebuilding these lists unconditionally
  // dropped focus and swallowed clicks that were in flight (pointerdown → rebuild → no click).
  const sigs = { att: '', dv: '', tl: '' };

  function renderAttachments(s: Store, card: Card) {
    const mine = s.attachments.filter(a => a.cardId === card.id);
    const sig = `${card.id}|${mine.map(a => `${a.id}:${a.name}`).join(',')}`;
    if (sigs.att === sig) return;
    sigs.att = sig;
    atList.textContent = '';
    if (!mine.length) atList.append(el('div', 'd-empty', '添付なし'));
    for (const a of mine) {
      atList.append(thumb(a, card.projectId, () => h.onDeleteAttachment(card.projectId, a.id).then(ok => {
        if (ok) h.notify('添付を外した');
        return ok;
      })));
    }
  }

  function renderDeliverables(s: Store, card: Card) {
    const mine: Deliverable[] = s.deliverables.filter(d => d.cardId === card.id);
    const sig = `${card.id}|${mine.map(d => `${d.id}:${d.title}:${d.ref ?? ''}`).join(',')}|${s.attachments.filter(a => a.deliverableId !== null).map(a => `${a.id}:${a.deliverableId}`).join(',')}`;
    if (sigs.dv === sig) return;
    sigs.dv = sig;
    dvList.textContent = '';
    if (!mine.length) dvList.append(el('div', 'd-empty', '紐づく成果物なし'));
    for (const d of mine) {
      const row = el('div', 'd-dv');
      const t = el('span', 'd-dv-title', d.title);
      t.title = d.title;
      row.append(el('span', 'chip kind', d.kind), t);
      if (d.ref) {
        // Same regression as the panel: the ref has to open, not just print.
        const link = el('a', 'chip', d.ref.split(/[\\/]/).pop() || d.ref);
        link.href = deliverableViewSrc(d.projectId, d.id);
        link.target = '_blank';
        link.rel = 'noopener';
        link.title = d.ref;
        row.append(link);
      }
      const rm = el('button', 'ic', '×');
      rm.type = 'button';
      rm.title = '成果物を削除';
      rm.addEventListener('click', () => { void h.onDeleteDeliverable(d.projectId, d.id); });
      row.append(rm);
      dvList.append(row);

      // Images attached to the deliverable itself (keyed by deliverableId, not cardId).
      const atts = s.attachments.filter(a => a.deliverableId === d.id);
      const strip = el('div', 'd-dv-atts');
      for (const a of atts) {
        strip.append(thumb(a, d.projectId, () => h.onDeleteAttachment(d.projectId, a.id).then(ok => {
          if (ok) h.notify('添付を外した');
          return ok;
        })));
      }
      const pick = el('input', 'd-file sm');
      pick.type = 'file';
      pick.accept = ATTACH_ACCEPT;
      pick.setAttribute('aria-label', `${d.title} にファイルを添付`);
      pick.addEventListener('change', () => {
        const f = pick.files?.[0];
        if (!f) return;
        void h.onUploadDeliverableAttachment(d.id, f).then(ok => { pick.value = ''; if (ok) h.notify('ファイルを添付した'); });
      });
      strip.append(pick);
      dvList.append(strip);
    }
  }

  function renderTimeline(s: Store, card: Card) {
    const mine: TimelineEvent[] = s.timeline.filter(e => e.entityType === 'card' && e.entityId === keyOf(card));
    const shown = mine.slice(-10);
    const sig = shown.map(e => `${e.at}:${e.kind}:${e.actor ?? ''}`).join(',');
    if (sigs.tl === sig) return;
    sigs.tl = sig;
    tlList.textContent = '';
    if (!mine.length) tlList.append(el('div', 'd-empty', '履歴なし'));
    for (const e of shown.slice().reverse()) {
      const row = el('div', 'd-tl-row');
      row.append(el('span', 'tl-at', e.at.slice(5, 16).replace('T', ' ')), el('span', 'tl-kind', e.kind));
      if (e.actor) row.append(el('span', 'tl-actor', e.actor));
      tlList.append(row);
    }
  }

  return {
    get openKey() { return key; },
    open,
    close,
    render(s: Store, projects: ProjectRef[]) {
      store = s;
      if (!key) return;
      const card = s.cards[key];
      if (!card) { close(); return; }
      if (snapshot && snapshot.version !== card.version) {
        // Someone else edited it: adopt the new values only when the inputs are untouched,
        // otherwise the user's typing would be silently overwritten.
        const dirty = title.value !== snapshot.title || body.value !== (snapshot.body ?? '')
          || prio.value !== String(snapshot.priority) || owner.value !== (snapshot.owner ?? '')
          || due.value !== (snapshot.due ?? '') || blocked.value !== (snapshot.blockedReason ?? '');
        if (!dirty) {
          title.value = card.title;
          prio.value = String(card.priority);
          owner.value = card.owner ?? '';
          due.value = card.due ?? '';
          blocked.value = card.blockedReason ?? '';
          body.value = card.body ?? '';
        }
        snapshot = card;
        heading.textContent = `#${card.id} ${card.title}`;
      }
      paint(s, card);
      void projects;
    },
  };

  /** Everything below the input fields: criteria hint, edges, linked deliverables, history, move list. */
  function paint(s: Store, card: Card) {
    const actor = lastActorOf(card);
    actorLine.hidden = actor === null;
    actorLine.textContent = actor === null ? '' : `最終更新者: ${actor}`;

    const progress = acceptanceProgress(body.value);
    accHint.textContent = progress.total
      ? `受け入れ条件: ${progress.done}/${progress.total}${progress.done === progress.total ? ' ✓' : ''}`
      : '受け入れ条件: なし（- [ ] で追加できる）';

    renderDeps(s, card);
    renderDepsPicker(s, card);
    renderDeliverables(s, card);
    renderAttachments(s, card);
    renderTimeline(s, card);

    const prev = moveSel.value;
    moveSel.textContent = '';
    const ph = el('option', undefined, '→ 移動先');
    ph.value = '';
    moveSel.append(ph);
    for (const id of s.columnOrder) {
      if (id === card.columnId) continue;
      const o = el('option', undefined, s.columns[id]?.name ?? id);
      o.value = id;
      moveSel.append(o);
    }
    moveSel.value = prev && moveSel.querySelector(`option[value="${prev}"]`) ? prev : '';
  }
}

/** Re-exported for the app's dependency handlers: project-scoped card lookup. */
export type { Dependency };
