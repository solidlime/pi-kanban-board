// One file per dialog: v1's lightbox (web/dash/_app.js:1248 showLb, keys at :1880-1882) rebuilt on
// the pair the server already serves — /file for the bytes, /view for the readable page.
// detail.ts imports this module; this module imports nothing from detail.ts (the cycle would be real).
import type { Attachment, Deliverable } from '../../src/shared/dto.js';
import { attachmentSrc, attachmentViewSrc, deliverableFileSrc, deliverableViewSrc } from './api.js';

export interface ViewerItem {
  /** The caption. */
  title: string;
  /** The basename the /view wrapper is chosen from; the extension is all a deliverable tells us. */
  name: string;
  /** Raw bytes: the <img>, the <video>, the download link. */
  fileSrc: string;
  /** The readable page: markdown, html, pdf. */
  viewSrc: string;
  /** Attachments are sniffed on upload, so their stored mime beats the name. */
  mime?: string;
}

export type ViewerKind = 'image' | 'video' | 'pdf' | 'markdown' | 'html' | 'other';

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO = /\.(mp4|webm|mov)$/i;
// sendFileView (src/api/routes.ts:634) renders text/* and application/json as a markdown article.
const DOC = /\.(md|markdown|txt|csv|json|log|ya?ml)$/i;

/** Same table as the server's EXT_MIME, in the same order (html before the generic text branch). */
export function kindOf(name: string, mime?: string): ViewerKind {
  // An attachment's mime arrives with its charset (`text/html; charset=utf-8`).
  const m = (mime ?? '').split(';')[0]?.trim() ?? '';
  if (m.startsWith('image/') || IMAGE.test(name)) return 'image';
  if (m.startsWith('video/') || VIDEO.test(name)) return 'video';
  if (m === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (m === 'text/html' || /\.html?$/i.test(name)) return 'html';
  if (m.startsWith('text/') || m === 'application/json' || DOC.test(name)) return 'markdown';
  return 'other';
}

/** `ref` is a path on the server's disk; the extension is the only kind a deliverable carries. */
export function deliverableItems(list: readonly Deliverable[]): ViewerItem[] {
  return list.map(d => ({
    title: d.title,
    name: d.ref.split(/[\\/]/).pop() || d.ref,
    fileSrc: deliverableFileSrc(d.projectId, d.id),
    viewSrc: deliverableViewSrc(d.projectId, d.id),
  }));
}

export function attachmentItems(projectId: string, list: readonly Attachment[]): ViewerItem[] {
  return list.map(a => ({
    title: a.name, name: a.name, mime: a.mime,
    fileSrc: attachmentSrc(projectId, a.id),
    viewSrc: attachmentViewSrc(projectId, a.id),
  }));
}

export interface ViewerView {
  /** `index` is the position in `list`: ←/→ walk that list, not the whole board. */
  open(list: readonly ViewerItem[], index: number): void;
  close(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  return n;
}

export function mountViewer(root: HTMLElement): ViewerView {
  const dlg = el('dialog', 'viewer');
  // The dialog itself takes focus when it holds no form control (an image has none), which is what
  // the keydown handler below needs to see every key.
  dlg.tabIndex = -1;

  const head = el('div', 'v-h');
  const cap = el('span', 'v-cap');
  const count = el('span', 'v-count');
  const closeBtn = el('button', 'ic');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.title = '閉じる';
  head.append(cap, count, closeBtn);
  const body = el('div', 'v-body');
  dlg.append(head, body);
  root.append(dlg);

  let list: readonly ViewerItem[] = [];
  let at = 0;

  /** The one box this kind gets. Nothing else stays in the DOM, so nothing else keeps loading. */
  function box(item: ViewerItem): HTMLElement {
    const kind = kindOf(item.name, item.mime);
    if (kind === 'image') {
      const img = el('img', 'v-img');
      img.src = item.fileSrc;
      img.alt = item.title;
      return img;
    }
    if (kind === 'video') {
      // /file answers Range, so a seek works without downloading the whole clip first.
      const vid = el('video', 'v-media');
      vid.controls = true;
      vid.autoplay = true;
      vid.src = item.fileSrc;
      return vid;
    }
    if (kind === 'other') {
      const a = el('a', 'v-dl');
      a.href = item.fileSrc;
      a.download = item.name;
      a.textContent = `${item.name} をダウンロード`;
      return a;
    }
    const fr = el('iframe', 'v-frame');
    fr.src = item.viewSrc;
    // No allow-same-origin: an uploaded page must not reach this origin's cookie. The server sends
    // the same sandbox as a CSP header; this half keeps it true even for a doctored response.
    if (kind === 'html') fr.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
    // A pdf keeps none: its viewer does not paint inside a sandboxed frame (v1 #91).
    if (kind === 'markdown') fr.setAttribute('sandbox', '');
    return fr;
  }

  function show(i: number) {
    if (!list.length) return;
    at = (i + list.length) % list.length;
    const item = list[at] as ViewerItem;
    // replaceChildren, not a hidden box: a detached <video> stops, a hidden one keeps playing.
    body.replaceChildren(box(item));
    cap.textContent = item.title;
    cap.title = item.title;
    count.textContent = list.length > 1 ? `${at + 1} / ${list.length}` : '';
    count.hidden = list.length <= 1;
  }

  function reset() {
    list = [];
    body.replaceChildren();
    cap.textContent = '';
    count.textContent = '';
  }

  function close() {
    reset();
    if (dlg.open) dlg.close();
  }

  function open(items: readonly ViewerItem[], index: number) {
    if (!items.length) return;
    list = items;
    show(index);
    if (!dlg.open) dlg.showModal();
    dlg.focus();
  }

  closeBtn.addEventListener('click', close);
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); close(); });
  dlg.addEventListener('close', reset);
  // A click lands on the dialog element itself only for the backdrop (and its own padding).
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) close(); });
  dlg.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); show(at - 1); return; }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); show(at + 1); return; }
    // keys.ts listens on document. A modal owns every key while it is up, as v1's lightbox did —
    // and keys.ts already skips a defaultPrevented event, so this needs no change on their side.
    ev.stopPropagation();
  });

  return { open, close };
}
