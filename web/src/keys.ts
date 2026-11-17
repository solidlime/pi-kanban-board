// v1's global key map (web/dash/_app.js:1862-1925), minus the keys v2 has no surface for.
// TODO: Ctrl/Cmd+K belongs to a search palette v2 does not draw yet — wire it when it exists.
import type { CardKey } from './store.js';

export interface KeyActions {
  /** The selection as the store holds it. keys.ts nudges it and never owns it. */
  selected(): readonly CardKey[];
  /** Writes the selection (an empty array clears it). */
  onSelect(keys: CardKey[]): void;
  /** Enter: the card's detail dialog. */
  onOpen(key: CardKey): void;
  /** `d`: first card of a doing-kind column, or null when there is none. */
  doingFirst(): CardKey | null;
}

/** Keys are dead inside a field; Esc is handled by the caller as "leave the field". */
export function isTyping(target: EventTarget | null): boolean {
  const n = target as HTMLElement | null;
  if (!n || typeof n.tagName !== 'string') return false;
  const tag = n.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || n.isContentEditable === true;
}

/**
 * One j/k step. v1 clamped at both ends (state.sel started at -1), so an empty or vanished
 * cursor lands on the first card instead of wrapping to the last.
 */
export function stepKey(keys: readonly CardKey[], selected: readonly CardKey[], delta: number): CardKey | null {
  if (!keys.length) return null;
  // A marquee selection of several has no order of its own: the last one picked is the cursor.
  const cursor = selected.at(-1);
  const at = cursor === undefined ? -1 : keys.indexOf(cursor);
  return keys[Math.max(0, Math.min(keys.length - 1, at + delta))] ?? null;
}

/** Cards in the order the eye reads them; the hidden surface keeps its nodes across renders. */
function rowKeys(): CardKey[] {
  const out: CardKey[] = [];
  for (const n of document.querySelectorAll<HTMLElement>('.card[data-key], .focus-row[data-key]')) {
    if (!n.closest('[hidden]')) out.push(n.dataset.key as CardKey);
  }
  return out;
}

function pick(actions: KeyActions, key: CardKey): void {
  actions.onSelect([key]);
  // v1 scrolled the cursor into view; without it a cursor below the fold is silent feedback.
  document.querySelector<HTMLElement>(`.card[data-key="${key}"], .focus-row[data-key="${key}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

/** The whole global map, as one listener: per-key listeners on document cannot be ordered. */
export function installKeys(actions: KeyActions): void {
  document.addEventListener('keydown', (ev) => {
    if (ev.repeat) return;
    // The card menu, the search box and the search overlay own their own Esc and mark it
    // handled; v1's Esc chain must stop at the first stage that fired.
    if (ev.defaultPrevented) return;

    const typing = isTyping(ev.target);
    if (ev.key === 'Escape') {
      if (typing) { (ev.target as HTMLElement).blur(); return; }
      // v1's modal stage: a <dialog> closes itself on Esc, so there is nothing left to do.
      if (document.querySelector('dialog[open]')) return;
      if (!actions.selected().length) return;
      ev.preventDefault();
      actions.onSelect([]);
      return;
    }
    if (typing) return;
    // Every other chord belongs to the browser or to a surface v2 does not have yet.
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

    // 1-9: a board tab in v1 is an <option> of v2's project picker; change is what the tab's
    // click did. 0 (全ボード) has no v2 target — v2 has no aggregate select.
    if (ev.key >= '1' && ev.key <= '9') {
      const sel = document.querySelector<HTMLSelectElement>('.pick select');
      const opt = sel?.options[Number(ev.key) - 1];
      if (!sel || !opt || !opt.value) return;
      ev.preventDefault();
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change'));
      return;
    }

    switch (ev.key) {
      case 'j':
      case 'k': {
        const next = stepKey(rowKeys(), actions.selected(), ev.key === 'j' ? 1 : -1);
        if (!next) return;
        ev.preventDefault();
        pick(actions, next);
        return;
      }
      case 'Enter': {
        const key = actions.selected().at(-1);
        if (key === undefined) return;
        ev.preventDefault();
        actions.onOpen(key);
        return;
      }
      case 'd': {
        const key = actions.doingFirst();
        if (!key) return;
        ev.preventDefault();
        pick(actions, key);
        return;
      }
      case '/': {
        const q = document.querySelector<HTMLInputElement>('input.q');
        if (!q) return;
        ev.preventDefault();
        q.focus();
        return;
      }
      case 'c': {
        // v1 focused the TODO column's row. A renamed column still answers to its kind's id;
        // the first column is the fallback when this project has no `todo`.
        const input = document.querySelector<HTMLInputElement>('.board .col[data-col="todo"] .addrow input')
          ?? document.querySelector<HTMLInputElement>('.board .col .addrow input');
        if (!input) return;
        ev.preventDefault();
        input.focus();
        return;
      }
      default:
        return;
    }
  });
}
