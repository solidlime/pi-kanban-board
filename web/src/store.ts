// Normalized board store: cards keyed by composite identity (`projectId#id`), columns by id.
// Every mutation is a plain function over one object so a render can be diffed against the last one.
import type {
  BoardSnapshot, Card, ColumnDef, Deliverable, Dependency, Project,
  Attachment, CardTemplate, GraphLayout, LoopState, Notification, OverviewRow, SavedView, SearchHit,
} from '../../src/shared/dto.js';
import type { ProjectRef } from '../../src/shared/api.js';
import type { TimelineEvent } from '../../src/shared/events.js';

export type {
  BoardSnapshot, Card, ColumnDef, Deliverable, Dependency, Project, ProjectRef, TimelineEvent,
  Attachment, CardTemplate, GraphLayout, LoopState, Notification, OverviewRow, SavedView, SearchHit,
};

export type CardKey = string; // `${projectId}#${id}` — never a bare id

export function cardKey(projectId: string, id: number): CardKey { return `${projectId}#${id}`; }
export function keyOf(card: Card): CardKey { return cardKey(card.projectId, card.id); }

export function parseKey(key: CardKey): { projectId: string; id: number } {
  const i = key.lastIndexOf('#');
  return { projectId: key.slice(0, i), id: Number(key.slice(i + 1)) };
}

export interface Store {
  /** Slug of the board being shown. Null = nothing selected. */
  projectId: string | null;
  projectName: string | null;
  projects: ProjectRef[];
  columns: Record<string, ColumnDef>;
  columnOrder: string[];
  cards: Record<CardKey, Card>;
  /** Directed edges; `fromCard` blocks `toCard` when type === 'blocks'. */
  dependencies: Dependency[];
  deliverables: Deliverable[];
  timeline: TimelineEvent[];
  /** Focus mode: only "ready now" cards are shown. */
  focus: boolean;
  /** Side panel (deliverables + recent events) is open. */
  panel: boolean;
  /** Right-hand overlay pane; never two at once (opening one closes `panel`). */
  pane: Pane;
  /** Overview (総合管理) replaces the board while true. */
  overview: boolean;
  overviewRows: OverviewRow[];
  /** Dependency map replaces the board while true. */
  graph: boolean;
  graphLayout: GraphLayout | null;
  /** Search box text; `hits === null` means the results overlay is closed. */
  q: string;
  hits: SearchHit[] | null;
  /** A saved view with focus filters the board down to cards matching `q`. */
  qFocus: boolean;
  notifications: Notification[];
  attachments: Attachment[];
  loop: LoopState | null;
  templates: CardTemplate[];
  views: SavedView[];
  generation: string | null;
  buildHash: string | null;
  version: string | null;
  /** True once a snapshot for `projectId` has landed. */
  loaded: boolean;
  loading: boolean;
  /** Last failure, already formatted for the status bar. */
  error: string | null;
  /** Cards with a request in flight (render only; never persisted). */
  pending: Set<CardKey>;
}

export type Pane = 'none' | 'templates' | 'views' | 'notifications';

export function createStore(): Store {
  return {
    projectId: null, projectName: null, projects: [],
    columns: {}, columnOrder: [], cards: {},
    dependencies: [], deliverables: [], timeline: [], focus: false, panel: false,
    pane: 'none', overview: false, overviewRows: [], graph: false, graphLayout: null,
    q: '', hits: null, qFocus: false, notifications: [], attachments: [], loop: null,
    templates: [], views: [],
    generation: null, buildHash: null, version: null,
    loaded: false, loading: false, error: null, pending: new Set(),
  };
}

export function setMeta(s: Store, meta: { buildHash?: string; version?: string }): void {
  s.buildHash = meta.buildHash ?? s.buildHash;
  s.version = meta.version ?? s.version;
}

export function setProjects(s: Store, projects: ProjectRef[]): void {
  s.projects = projects;
}

/** Drops every board-shaped field. Called on project switch so no card can leak across boards. */
export function resetBoard(s: Store, projectId: string | null): void {
  s.projectId = projectId;
  s.projectName = projectId ? s.projects.find(x => x.slug === projectId)?.name ?? null : null;
  s.columns = {};
  s.columnOrder = [];
  s.cards = {};
  s.dependencies = [];
  s.deliverables = [];
  s.timeline = [];
  // Board-scoped extras: a stale hit/attachment from another project must never be clickable.
  s.hits = null;
  s.notifications = [];
  s.attachments = [];
  s.loop = null;
  s.templates = [];
  s.views = [];
  s.graphLayout = null;
  s.graph = false;
  // Overlay panes are board-scoped too: their contents were fetched for the old project.
  s.pane = 'none';
  s.qFocus = false;
  s.generation = null;
  s.loaded = false;
  s.error = null;
  s.pending = new Set();
}

/**
 * Applies a full snapshot. Returns false (and changes nothing) when the snapshot belongs to
 * another project — a late response must never repaint the wrong board.
 */
export function applySnapshot(s: Store, projectId: string, snap: BoardSnapshot): boolean {
  if (!snap || !snap.project) return false;
  const got = snap.project.slug ?? snap.project.projectId;
  if (got !== projectId) return false;

  s.projectId = projectId;
  s.projectName = snap.project.name ?? null;
  s.generation = snap.generation ?? null;
  s.columns = {};
  for (const c of snap.columns ?? []) s.columns[c.id] = c;
  s.columnOrder = [...(snap.columns ?? [])]
    .sort((a, b) => a.ord - b.ord || a.id.localeCompare(b.id))
    .map(c => c.id);
  s.cards = {};
  for (const c of snap.cards ?? []) s.cards[keyOf(c)] = c;
  // Only keep edges whose endpoints exist on this board — a half-applied snapshot must not
  // make a card look blocked by an id the UI cannot name.
  s.dependencies = (snap.dependencies ?? []).filter(d => s.cards[cardKey(d.projectId, d.fromCard)] && s.cards[cardKey(d.projectId, d.toCard)]);
  s.loaded = true;
  return true;
}

/** Server-authoritative card upsert (create/patch/move responses). */
export function upsertCard(s: Store, card: Card): boolean {
  if (!card || card.projectId !== s.projectId) return false;
  s.cards[keyOf(card)] = card;
  return true;
}

export function removeCard(s: Store, key: CardKey): void { delete s.cards[key]; }

/** Optimistic column change; the move response replaces the card with the server copy. */
export function applyLocalMove(s: Store, key: CardKey, columnId: string): void {
  const card = s.cards[key];
  if (card) s.cards[key] = { ...card, columnId };
}

/** Cards of one column in canonical order: priority desc, then id asc (same as core/card.ts). */
export function cardsInColumn(s: Store, columnId: string): Card[] {
  const out: Card[] = [];
  for (const c of Object.values(s.cards)) {
    if (c.columnId === columnId && c.projectId === s.projectId) out.push(c);
  }
  return out.sort((a, b) => b.priority - a.priority || a.id - b.id);
}

// ---------------------------------------------------------------- readiness
// Mirrors core/board.ts isReady/isBlocked over the loaded snapshot, so focus mode and the
// card badges agree with the domain without another round trip.

export function isClosed(card: Pick<Card, 'closedAt'>): boolean {
  return card.closedAt !== null && card.closedAt !== undefined;
}

export function isDoneColumn(s: Store, columnId: string): boolean {
  return s.columns[columnId]?.kind === 'done';
}

/** Open 'blocks' edges arriving at `cardId`: the blockers that have not closed yet. */
export function openBlockers(s: Store, cardId: number): Card[] {
  const out: Card[] = [];
  for (const d of s.dependencies) {
    if (d.type !== 'blocks' || d.toCard !== cardId) continue;
    const from = s.cards[cardKey(d.projectId, d.fromCard)];
    if (from && isClosed(from)) continue;
    if (from) out.push(from);
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Cards this one blocks (outgoing 'blocks' edges), closed or not. */
export function blocksCards(s: Store, cardId: number): Card[] {
  const out: Card[] = [];
  for (const d of s.dependencies) {
    if (d.type !== 'blocks' || d.fromCard !== cardId) continue;
    const to = s.cards[cardKey(d.projectId, d.toCard)];
    if (to) out.push(to);
  }
  return out.sort((a, b) => a.id - b.id);
}

/** All edges touching a card (both directions, every type) — the detail dialog's list. */
export function edgesOf(s: Store, cardId: number): Dependency[] {
  return s.dependencies.filter(d => d.fromCard === cardId || d.toCard === cardId);
}

export function isBlocked(s: Store, card: Card): boolean {
  if (card.blockedReason) return true;
  return openBlockers(s, card.id).length > 0;
}

/** Not closed, not in a done column, not manually/edge blocked. */
export function isReady(s: Store, card: Card): boolean {
  if (isClosed(card)) return false;
  if (isDoneColumn(s, card.columnId)) return false;
  return !isBlocked(s, card);
}

/** 'YYYY-MM-DD' or null-last, used as the focus-mode tiebreaker after priority. */
const dueRank = (c: Card): string => c.due ?? '9999-12-31';

export function readyCards(s: Store): Card[] {
  return Object.values(s.cards)
    .filter(c => c.projectId === s.projectId && isReady(s, c))
    .sort((a, b) => b.priority - a.priority || dueRank(a).localeCompare(dueRank(b)) || a.id - b.id);
}

/** Markdown checklist progress (`- [ ]` / `- [x]`), same grammar as core/acceptance.ts. */
export function acceptanceProgress(body: string | undefined | null): { total: number; done: number } {
  // Fence-aware: a checklist inside ``` is documentation, not criteria (core does the same).
  let fenced = false;
  let total = 0;
  let done = 0;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^\s{0,3}[-*]\s+\[([ xX])\]\s+(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    total += 1;
    if (m[1].toLowerCase() === 'x') done += 1;
  }
  return { total, done };
}

/** Board-side text filter used by saved views with `focus`: same fields the search reads. */
export function cardMatches(card: Card, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [card.title, card.body ?? '', card.owner ?? '', ...(card.labels ?? [])].join('\n').toLowerCase();
  return hay.includes(needle);
}
