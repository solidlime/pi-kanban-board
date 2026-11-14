// A3 — time view. A read-only projection: `due` / `movedAt` / `closedAt` in, bars out.
// Nothing here writes, and nothing is persisted: there is no drag handler to give a date a home,
// so the server stays the only owner of the dates (docs/PLAN_TIER_A.md: ガントの書き込みは B4 の後).
import type { Card, ColumnDef } from '../../src/shared/dto.js';

export type GanttScale = 'week' | 'month';

export interface GanttRow {
  card: Card;
  /** ms, UTC midnight where the input was a date-only string. */
  start: number;
  end: number;
  due: number | null;
  moved: number | null;
  closed: boolean;
  /** No due date and not closed: the bar ends at "today", drawn with a dashed edge. */
  openEnded: boolean;
}

export interface GanttTick { at: number; label: string; major: boolean }
export interface GanttAxis { from: number; to: number; ticks: GanttTick[] }

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** `2026-11-13` is a date, `2026-11-13T10:00:00Z` has a time: both are read as UTC. */
function ts(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(t) ? t : null;
}

function dayStart(t: number): number {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday 00:00 UTC of the week containing `t` (the axis always starts on a week boundary). */
export function weekStart(t: number): number {
  const d = dayStart(t);
  return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY;
}

export function monthStart(t: number): number {
  const d = new Date(dayStart(t));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function addMonths(t: number, n: number): number {
  const d = new Date(monthStart(t));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
}

const M = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const YM = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`;
};

/**
 * The bar of one card. `start` is the earliest thing we know about (created, or the last move
 * when a card was seeded without a creation time); `end` is the closure, else the due date,
 * else today. A due date in the past on an open card is a "late" bar, not a different shape.
 */
export function ganttRows(cards: readonly Card[], now: number): GanttRow[] {
  const out: GanttRow[] = [];
  for (const card of cards) {
    const created = ts(card.createdAt);
    const moved = ts(card.movedAt);
    const due = ts(card.due);
    const closedAt = ts(card.closedAt);
    const start = Math.min(created ?? moved ?? now, moved ?? created ?? now);
    const end = closedAt ?? due ?? now;
    out.push({
      card, start, end: Math.max(start, end), due, moved,
      closed: closedAt !== null, openEnded: closedAt === null && due === null,
    });
  }
  return out.sort((a, b) => a.start - b.start || a.card.id - b.card.id);
}

/**
 * Window + gridlines from the data itself: a week axis opens two weeks around the work,
 * a month axis one month around it, so an empty board still shows a readable frame.
 */
export function ganttAxis(rows: readonly GanttRow[], scale: GanttScale, now: number): GanttAxis {
  const lo = rows.length ? Math.min(...rows.map(r => r.start)) : now;
  const hi = rows.length ? Math.max(...rows.map(r => r.end)) : now;
  const from = scale === 'week' ? weekStart(Math.min(lo, now) - WEEK) : monthStart(Math.min(lo, now) - 2 * WEEK);
  const to = scale === 'week' ? weekStart(Math.max(hi, now) + WEEK) + WEEK : addMonths(hi, 2);
  const ticks: GanttTick[] = [];
  if (scale === 'week') {
    for (let t = from; t < to; t += DAY) ticks.push({ at: t, label: M(t), major: new Date(t).getUTCDay() === 1 });
  } else {
    for (let t = from; t < to; t += WEEK) {
      const major = new Date(monthStart(t)).getTime() === t; // a week can start on the 1st
      ticks.push({ at: t, label: major ? YM(t) : M(t), major });
    }
  }
  return { from, to, ticks };
}

// ---------------------------------------------------------------- rendering

export interface GanttOpts {
  projectId: string;
  scale: GanttScale;
  now: number;
  columns: Record<string, ColumnDef>;
  onScale(scale: GanttScale): void;
  onOpen(card: Card): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const pct = (t: number, axis: GanttAxis): number =>
  axis.to === axis.from ? 0 : Math.min(100, Math.max(0, ((t - axis.from) / (axis.to - axis.from)) * 100));

/**
 * Draws into `host` and keeps its own diff signature: the board polls every 5s, so rebuilding
 * 200 rows on every tick would drop focus and swallow clicks (same rule as renderView).
 */
export function renderGantt(host: HTMLElement, cards: readonly Card[], o: GanttOpts): void {
  const rows = ganttRows(cards, o.now);
  const axis = ganttAxis(rows, o.scale, o.now);
  const today = Math.floor(o.now / DAY);
  const sig = [
    o.projectId, o.scale, axis.from, axis.to, today,
    ...rows.map(r => `${r.card.id}:${r.start}:${r.end}:${r.card.title}:${r.card.columnId}`),
  ].join('|');
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.textContent = '';

  const head = el('div', 'ov-h');
  head.append(el('h2', undefined, '時間'), el('span', 'ov-n', `${rows.length} 件`));
  const seg = el('div', 'gseg');
  for (const scale of ['week', 'month'] as const) {
    const b = el('button', `toggle${o.scale === scale ? ' on' : ''}`, scale === 'week' ? '週' : '月');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(o.scale === scale));
    b.title = scale === 'week' ? '日刻みで4週前後' : '週刻みで数か月';
    b.addEventListener('click', () => o.onScale(scale));
    seg.append(b);
  }
  head.append(seg);
  host.append(head);
  host.append(el('div', 'ov-n', '読み取り専用（due・移動・完了から導出。ドラッグしても保存しない）'));

  if (!rows.length) { host.append(el('div', 'empty', 'カードが無い')); return; }

  const axisRow = el('div', 'gantt-row axis');
  axisRow.append(el('div', 'g-label'));
  const axisTrack = el('div', 'g-track');
  for (const t of axis.ticks) {
    const tick = el('span', `g-tick${t.major ? ' major' : ''}`, t.label);
    tick.style.left = `${pct(t.at, axis)}%`;
    axisTrack.append(tick);
  }
  axisRow.append(axisTrack);
  host.append(axisRow);

  const body = el('div', 'gantt-rows');
  for (const r of rows) {
    const row = el('div', 'gantt-row');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    const range = `${M(r.start)} → ${r.openEnded ? '未定' : M(r.end)}`;
    row.setAttribute('aria-label', `#${r.card.id} ${r.card.title} ${range}`);
    const label = el('div', 'g-label');
    label.append(el('span', 'cid', `#${r.card.id}`), el('span', undefined, r.card.title));
    const track = el('div', 'g-track');
    const bar = el('div', 'g-bar');
    const left = pct(r.start, axis);
    bar.style.left = `${left}%`;
    bar.style.width = `${Math.max(0, pct(r.end, axis) - left)}%`;
    bar.classList.toggle('closed', r.closed);
    bar.classList.toggle('late', !r.closed && r.due !== null && r.due < o.now);
    bar.classList.toggle('open', r.openEnded);
    const col = o.columns[r.card.columnId]?.name ?? r.card.columnId;
    bar.title = `#${r.card.id} ${r.card.title}\n${col} · ${range}${r.card.due ? ` · due ${r.card.due}` : ''}`;
    track.append(bar);
    // A due date outside the window would be pinned to the edge and read as a lie;
    // the red bar already says "overdue", so the marker is only drawn when it is really there.
    if (r.due !== null && r.due >= axis.from && r.due <= axis.to) {
      const mark = el('span', 'g-due');
      mark.style.left = `${pct(r.due, axis)}%`;
      mark.title = `due ${r.card.due}`;
      track.append(mark);
    }
    row.append(label, track);
    row.addEventListener('click', () => o.onOpen(r.card));
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); o.onOpen(r.card); }
    });
    body.append(row);
  }
  host.append(body);
  host.append(el('div', 'ov-n', '青=進行中 / 緑=完了 / 赤=期限超過。黄色の縦線が due'));
}
