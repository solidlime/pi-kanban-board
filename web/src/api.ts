// Typed-ish client for the frozen v2 HTTP surface.
// Every call returns the envelope's `data`; failures throw ApiError so the UI has one shape to show.
import type {
  BoardSnapshot, Card, ColumnDef, Deliverable, Dependency, Project, SavedView, CardTemplate, Attachment,
  LoopState, Notification, SearchHit, GraphLayout, OverviewRow, ViewQuery,
} from '../../src/shared/dto.js';
import type { TimelineEvent } from '../../src/shared/events.js';
import type {
  Meta, ProjectRef, CreateCardReq, PatchCardReq, MoveCardReq, DeleteCardReq,
  AddDependencyReq, DependencyType, CreateDeliverableReq, SessionRef,
} from '../../src/shared/api.js';

export type {
  BoardSnapshot, Card, ColumnDef, Deliverable, Dependency, Project, Meta, ProjectRef, TimelineEvent,
  SavedView, CardTemplate, Attachment, LoopState, Notification, SearchHit, GraphLayout, OverviewRow, ViewQuery,
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

type Envelope = { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } };

const netError = (e: unknown): ApiError =>
  new ApiError('NETWORK', `サーバに接続できません (${e instanceof Error ? e.message : String(e)})`, 0);

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin', // token lives in an HttpOnly cookie: never drop it
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw netError(e);
  }
  return parse<T>(res);
}

/** Raw-body POST (attachment bytes): same envelope handling, no JSON encoding. */
async function postBlob<T>(path: string, body: Blob): Promise<T> {
  let res: Response;
  try {
    // No content-type header: the browser sets it from the Blob and the server sniffs the bytes anyway.
    res = await fetch(path, { method: 'POST', credentials: 'same-origin', body });
  } catch (e) {
    throw netError(e);
  }
  return parse<T>(res);
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let env: Envelope | null = null;
  try { env = text ? (JSON.parse(text) as Envelope) : null; } catch { env = null; }

  if (env && env.ok === false) {
    throw new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? `HTTP ${res.status}`, res.status);
  }
  if (!res.ok) {
    throw new ApiError(res.status === 401 ? 'UNAUTHORIZED' : 'HTTP', env?.error?.message ?? `HTTP ${res.status} ${res.statusText}`, res.status);
  }
  if (env === null) {
    // An HTML error page or a proxy response — say so instead of pretending it parsed.
    throw new ApiError('BAD_RESPONSE', `JSON ではない応答 (${res.status})`, res.status);
  }
  return (env.ok === true ? env.data : env) as T;
}

const p = encodeURIComponent;

export const getMeta = () => req<Meta>('GET', '/api/meta');
export const getProjects = () => req<{ projects: ProjectRef[] }>('GET', '/api/projects');
export const getBoard = (project: string) => req<BoardSnapshot>('GET', `/api/board?project=${p(project)}`);

export const createProject = (body: { slug?: string; name?: string }) =>
  req<{ project: Project; columns: ColumnDef[] }>('POST', '/api/projects', body);

export const createCard = (body: CreateCardReq) => req<{ card: Card }>('POST', '/api/cards', body);

const cardPath = (project: string, id: number) => `/api/cards/${p(project)}/${p(String(id))}`;

export const moveCard = (project: string, id: number, body: MoveCardReq) =>
  req<{ card: Card }>('POST', `${cardPath(project, id)}/move`, body);

export const patchCard = (project: string, id: number, body: PatchCardReq) =>
  req<{ card: Card }>('PATCH', cardPath(project, id), body);

/** The pi sessions of a board's cwd: the card's session picker shows these names. */
export const getSessions = (project: string) =>
  req<{ sessions: SessionRef[] }>('GET', `/api/sessions?project=${p(project)}`);

export const deleteCard = (project: string, id: number, body?: DeleteCardReq) =>
  req<{ deleted: { projectId: string; id: number } }>('DELETE', cardPath(project, id), body);

export const getTimeline = (project: string, limit = 200) =>
  req<{ events: TimelineEvent[] }>('GET', `/api/timeline?project=${p(project)}&limit=${p(String(limit))}`);

export const getDeliverables = (project: string) =>
  req<{ deliverables: Deliverable[] }>('GET', `/api/deliverables?project=${p(project)}`);

export const createDeliverable = (body: CreateDeliverableReq) =>
  req<{ deliverable: Deliverable }>('POST', '/api/deliverables', body);

export const deleteDeliverable = (project: string, id: number) =>
  req<{ deleted: { projectId: string; id: number } }>('DELETE', `/api/deliverables/${p(project)}/${p(String(id))}`);

export const addDependency = (body: AddDependencyReq) =>
  req<{ dependency: Dependency }>('POST', '/api/dependencies', body);

export const removeDependency = (project: string, fromCard: number, toCard: number, type: DependencyType = 'blocks') =>
  req<{ removed: Dependency }>(
    'DELETE',
    `/api/dependencies?project=${p(project)}&from=${p(String(fromCard))}&to=${p(String(toCard))}&type=${p(type)}`,
  );

// ---------------------------------------------------------------- v2 extras

export const patchColumn = (project: string, columnId: string, body: { name?: string; wipLimit?: number | null; ord?: number }) =>
  req<{ column: ColumnDef }>('PATCH', `/api/columns/${p(project)}/${p(columnId)}`, body);

const viewPath = (project: string, id: number) => `/api/views/${p(project)}/${p(String(id))}`;

export const getViews = (project: string) => req<{ views: SavedView[] }>('GET', `/api/views?project=${p(project)}`);

export const createView = (body: { project: string; name: string; query?: ViewQuery }) =>
  req<{ view: SavedView }>('POST', '/api/views', body);

export const patchView = (project: string, id: number, body: { name?: string; query?: ViewQuery }) =>
  req<{ view: SavedView }>('PATCH', viewPath(project, id), body);

export const deleteView = (project: string, id: number) =>
  req<{ deleted: { projectId: string; id: number } }>('DELETE', viewPath(project, id));

const templatePath = (project: string, id: number) => `/api/templates/${p(project)}/${p(String(id))}`;

export const getTemplates = (project: string) =>
  req<{ templates: CardTemplate[] }>('GET', `/api/templates?project=${p(project)}`);

export const createTemplate = (body: {
  project: string; name: string; title: string; body?: string;
  columnId?: string; priority?: number; labels?: string[];
}) => req<{ template: CardTemplate }>('POST', '/api/templates', body);

/** Instantiate a template: one POST yields a real card. */
export const useTemplate = (project: string, id: number, body: { columnId?: string } = {}) =>
  req<{ card: Card }>('POST', templatePath(project, id), body);

export const deleteTemplate = (project: string, id: number) =>
  req<{ deleted: { projectId: string; id: number } }>('DELETE', templatePath(project, id));

/** `target` picks the owner: an attachment belongs to exactly one card or deliverable. */
export type AttachmentTarget = { cardId: number } | { deliverableId: number };

const attachQuery = (project: string, target?: AttachmentTarget): string => {
  const base = `/api/attachments?project=${p(project)}`;
  if (!target) return base;
  return 'cardId' in target ? `${base}&cardId=${p(String(target.cardId))}` : `${base}&deliverableId=${p(String(target.deliverableId))}`;
};

export const getAttachments = (project: string, target?: AttachmentTarget) =>
  req<{ attachments: Attachment[] }>('GET', attachQuery(project, target));

/** Use straight as an `<img src>`: the bytes are served from the same origin. */
export const attachmentSrc = (project: string, id: number) => `/api/attachments/${p(project)}/${p(String(id))}`;
/** The readable page for an attachment: md→HTML, pdf/mp4 in a wrapper, everything else a download. */
export const attachmentViewSrc = (project: string, id: number) => `${attachmentSrc(project, id)}/view`;

export const uploadAttachment = (project: string, target: AttachmentTarget, name: string, file: Blob) =>
  postBlob<{ attachment: Attachment }>(`${attachQuery(project, target)}&name=${p(name)}`, file);

export const deleteAttachment = (project: string, id: number) =>
  req<{ deleted: { projectId: string; id: number } }>('DELETE', `/api/attachments/${p(project)}/${p(String(id))}`);

/** The raw bytes of a deliverable's `ref` (Range-capable: a video seeks with it). */
export const deliverableFileSrc = (project: string, id: number) =>
  `/api/deliverables/${p(project)}/${p(String(id))}/file`;

/** The readable page for the same bytes: md rendered, images/video/pdf wrapped. */
export const deliverableViewSrc = (project: string, id: number) =>
  `/api/deliverables/${p(project)}/${p(String(id))}/view`;

export const searchBoard = (project: string | null, q: string, limit = 20) =>
  req<{ hits: SearchHit[] }>(
    'GET',
    project
      ? `/api/search?project=${p(project)}&q=${p(q)}&limit=${p(String(limit))}`
      : `/api/search?q=${p(q)}&limit=${p(String(limit))}`, // no project = every board (A1)
  );

/**
 * A6: a daemon lock on one board, as the server reports it. The UI draws it and never takes it —
 * acquiring/releasing is the agent's job, so there is no POST/DELETE here on purpose.
 */
export interface BoardLock { resource: string; owner: string; at: string; expiresAt: string }

export const getLocks = (project: string) => req<{ locks: BoardLock[] }>('GET', `/api/locks?project=${p(project)}`);

/** Omit `project` for every board at once. */
export const getNotifications = (project?: string) =>
  req<{ notifications: Notification[] }>(
    'GET', project ? `/api/notifications?project=${p(project)}` : '/api/notifications',
  );

export const getGraph = (project: string) => req<GraphLayout>('GET', `/api/graph?project=${p(project)}`);

export const getOverview = () => req<{ projects: OverviewRow[] }>('GET', '/api/overview');

/** `/api/loop` also says when the supervisor ticks next; null when nothing is scheduled. */
export type LoopInfo = LoopState & { nextTickAt: string | null };

export const getLoop = (project: string) => req<{ loop: LoopInfo }>('GET', `/api/loop?project=${p(project)}`);

export const startLoop = (project: string) => req<{ loop: LoopState }>('POST', '/api/loop/start', { project });

export const stopLoop = (project: string, reason?: string) =>
  req<{ loop: LoopState }>('POST', '/api/loop/stop', reason === undefined ? { project } : { project, reason });

export const tickLoop = (project: string) =>
  req<{ loop: LoopState; nextCard: Card | null }>('POST', '/api/loop/tick', { project });
