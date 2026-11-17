// web/src/api.ts
var ApiError = class extends Error {
  code;
  status;
  constructor(code, message, status) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
};
var netError = (e) => new ApiError("NETWORK", `\u30B5\u30FC\u30D0\u306B\u63A5\u7D9A\u3067\u304D\u307E\u305B\u3093 (${e instanceof Error ? e.message : String(e)})`, 0);
async function req(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      // token lives in an HttpOnly cookie: never drop it
      headers: body === void 0 ? {} : { "content-type": "application/json" },
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
  } catch (e) {
    throw netError(e);
  }
  return parse(res);
}
async function postBlob(path, body) {
  let res;
  try {
    res = await fetch(path, { method: "POST", credentials: "same-origin", body });
  } catch (e) {
    throw netError(e);
  }
  return parse(res);
}
async function parse(res) {
  const text = await res.text();
  let env = null;
  try {
    env = text ? JSON.parse(text) : null;
  } catch {
    env = null;
  }
  if (env && env.ok === false) {
    throw new ApiError(env.error?.code ?? "INTERNAL", env.error?.message ?? `HTTP ${res.status}`, res.status);
  }
  if (!res.ok) {
    throw new ApiError(res.status === 401 ? "UNAUTHORIZED" : "HTTP", env?.error?.message ?? `HTTP ${res.status} ${res.statusText}`, res.status);
  }
  if (env === null) {
    throw new ApiError("BAD_RESPONSE", `JSON \u3067\u306F\u306A\u3044\u5FDC\u7B54 (${res.status})`, res.status);
  }
  return env.ok === true ? env.data : env;
}
var p = encodeURIComponent;
var getMeta = () => req("GET", "/api/meta");
var getProjects = () => req("GET", "/api/projects");
var getBoard = (project) => req("GET", `/api/board?project=${p(project)}`);
var createProject = (body) => req("POST", "/api/projects", body);
var createCard = (body) => req("POST", "/api/cards", body);
var cardPath = (project, id) => `/api/cards/${p(project)}/${p(String(id))}`;
var moveCard = (project, id, body) => req("POST", `${cardPath(project, id)}/move`, body);
var patchCard = (project, id, body) => req("PATCH", cardPath(project, id), body);
var getSessions = (project) => req("GET", `/api/sessions?project=${p(project)}`);
var deleteCard = (project, id, body) => req("DELETE", cardPath(project, id), body);
var getTimeline = (project, limit = 200) => req("GET", `/api/timeline?project=${p(project)}&limit=${p(String(limit))}`);
var getDeliverables = (project) => req("GET", `/api/deliverables?project=${p(project)}`);
var createDeliverable = (body) => req("POST", "/api/deliverables", body);
var deleteDeliverable = (project, id) => req("DELETE", `/api/deliverables/${p(project)}/${p(String(id))}`);
var addDependency = (body) => req("POST", "/api/dependencies", body);
var removeDependency = (project, fromCard, toCard, type = "blocks") => req(
  "DELETE",
  `/api/dependencies?project=${p(project)}&from=${p(String(fromCard))}&to=${p(String(toCard))}&type=${p(type)}`
);
var patchColumn = (project, columnId, body) => req("PATCH", `/api/columns/${p(project)}/${p(columnId)}`, body);
var viewPath = (project, id) => `/api/views/${p(project)}/${p(String(id))}`;
var getViews = (project) => req("GET", `/api/views?project=${p(project)}`);
var createView = (body) => req("POST", "/api/views", body);
var deleteView = (project, id) => req("DELETE", viewPath(project, id));
var templatePath = (project, id) => `/api/templates/${p(project)}/${p(String(id))}`;
var getTemplates = (project) => req("GET", `/api/templates?project=${p(project)}`);
var createTemplate = (body) => req("POST", "/api/templates", body);
var useTemplate = (project, id, body = {}) => req("POST", templatePath(project, id), body);
var deleteTemplate = (project, id) => req("DELETE", templatePath(project, id));
var attachQuery = (project, target) => {
  const base = `/api/attachments?project=${p(project)}`;
  if (!target) return base;
  return "cardId" in target ? `${base}&cardId=${p(String(target.cardId))}` : `${base}&deliverableId=${p(String(target.deliverableId))}`;
};
var getAttachments = (project, target) => req("GET", attachQuery(project, target));
var attachmentSrc = (project, id) => `/api/attachments/${p(project)}/${p(String(id))}`;
var attachmentViewSrc = (project, id) => `${attachmentSrc(project, id)}/view`;
var uploadAttachment = (project, target, name, file) => postBlob(`${attachQuery(project, target)}&name=${p(name)}`, file);
var deleteAttachment = (project, id) => req("DELETE", `/api/attachments/${p(project)}/${p(String(id))}`);
var deliverableFileSrc = (project, id) => `/api/deliverables/${p(project)}/${p(String(id))}/file`;
var deliverableViewSrc = (project, id) => `/api/deliverables/${p(project)}/${p(String(id))}/view`;
var searchBoard = (project, q, limit = 20) => req(
  "GET",
  project ? `/api/search?project=${p(project)}&q=${p(q)}&limit=${p(String(limit))}` : `/api/search?q=${p(q)}&limit=${p(String(limit))}`
  // no project = every board (A1)
);
var getLocks = (project) => req("GET", `/api/locks?project=${p(project)}`);
var getNotifications = (project) => req(
  "GET",
  project ? `/api/notifications?project=${p(project)}` : "/api/notifications"
);
var getGraph = (project) => req("GET", `/api/graph?project=${p(project)}`);
var getOverview = () => req("GET", "/api/overview");
var getLoop = (project) => req("GET", `/api/loop?project=${p(project)}`);
var startLoop = (project) => req("POST", "/api/loop/start", { project });
var stopLoop = (project, reason) => req("POST", "/api/loop/stop", reason === void 0 ? { project } : { project, reason });
var tickLoop = (project) => req("POST", "/api/loop/tick", { project });

// web/src/store.ts
var STALE_DAYS_DEFAULT = 7;
var DAY_MS = 864e5;
function cardKey(projectId, id) {
  return `${projectId}#${id}`;
}
function keyOf(card) {
  return cardKey(card.projectId, card.id);
}
function parseKey(key) {
  const i = key.lastIndexOf("#");
  return { projectId: key.slice(0, i), id: Number(key.slice(i + 1)) };
}
function createStore() {
  return {
    projectId: null,
    projectName: null,
    projects: [],
    columns: {},
    columnOrder: [],
    cards: {},
    dependencies: [],
    deliverables: [],
    timeline: [],
    focus: false,
    panels: { deliverables: false, timeline: false },
    pane: "none",
    overview: false,
    overviewRows: [],
    graph: false,
    graphLayout: null,
    doneOpen: false,
    staleDays: STALE_DAYS_DEFAULT,
    delSort: "new",
    gantt: false,
    ganttScale: "week",
    q: "",
    hits: null,
    searchAll: false,
    qFocus: false,
    notifications: [],
    attachments: [],
    locks: [],
    loop: null,
    templates: [],
    views: [],
    generation: null,
    buildHash: null,
    version: null,
    loaded: false,
    loading: false,
    error: null,
    pending: /* @__PURE__ */ new Set(),
    selection: /* @__PURE__ */ new Set(),
    vanishing: /* @__PURE__ */ new Set()
  };
}
function setMeta(s, meta) {
  s.buildHash = meta.buildHash ?? s.buildHash;
  s.version = meta.version ?? s.version;
}
function setProjects(s, projects) {
  s.projects = projects;
}
function resetBoard(s, projectId) {
  s.projectId = projectId;
  s.projectName = projectId ? s.projects.find((x) => x.slug === projectId)?.name ?? null : null;
  s.columns = {};
  s.columnOrder = [];
  s.cards = {};
  s.dependencies = [];
  s.deliverables = [];
  s.timeline = [];
  s.hits = null;
  s.notifications = [];
  s.attachments = [];
  s.locks = [];
  s.loop = null;
  s.templates = [];
  s.views = [];
  s.graphLayout = null;
  s.graph = false;
  s.gantt = false;
  s.pane = "none";
  s.qFocus = false;
  s.generation = null;
  s.loaded = false;
  s.error = null;
  s.pending = /* @__PURE__ */ new Set();
  s.selection = /* @__PURE__ */ new Set();
}
function applySnapshot(s, projectId, snap) {
  if (!snap || !snap.project) return false;
  const got = snap.project.slug ?? snap.project.projectId;
  if (got !== projectId) return false;
  s.projectId = projectId;
  s.projectName = snap.project.name ?? null;
  s.generation = snap.generation ?? null;
  s.columns = {};
  for (const c of snap.columns ?? []) s.columns[c.id] = c;
  s.columnOrder = [...snap.columns ?? []].sort((a, b) => a.ord - b.ord || a.id.localeCompare(b.id)).map((c) => c.id);
  s.cards = {};
  for (const c of snap.cards ?? []) {
    if (!s.vanishing.has(keyOf(c))) s.cards[keyOf(c)] = c;
  }
  s.dependencies = (snap.dependencies ?? []).filter((d) => s.cards[cardKey(d.projectId, d.fromCard)] && s.cards[cardKey(d.projectId, d.toCard)]);
  s.loaded = true;
  return true;
}
function upsertCard(s, card) {
  if (!card || card.projectId !== s.projectId) return false;
  if (s.vanishing.has(keyOf(card))) return false;
  s.cards[keyOf(card)] = card;
  return true;
}
function vanishCard(s, key) {
  s.vanishing.add(key);
  delete s.cards[key];
  s.selection.delete(key);
  s.dependencies = s.dependencies.filter((d) => cardKey(d.projectId, d.fromCard) !== key && cardKey(d.projectId, d.toCard) !== key);
}
function revealCard(s, key) {
  s.vanishing.delete(key);
}
function applyLocalMove(s, key, columnId) {
  const card = s.cards[key];
  if (card) s.cards[key] = { ...card, columnId };
}
function cardsInColumn(s, columnId) {
  const out = [];
  for (const c of Object.values(s.cards)) {
    if (c.columnId === columnId && c.projectId === s.projectId) out.push(c);
  }
  return out.sort((a, b) => b.priority - a.priority || a.id - b.id);
}
function panelDeliverables(s) {
  const q = s.q.trim().toLowerCase();
  const list = q ? s.deliverables.filter((d) => d.title.toLowerCase().includes(q)) : s.deliverables;
  const dir = s.delSort === "old" ? 1 : -1;
  return [...list].sort((a, b) => (a.id - b.id) * dir);
}
var DONE_PREVIEW = 2;
function isClosed(card) {
  return card.closedAt !== null && card.closedAt !== void 0;
}
function isDoneColumn(s, columnId) {
  return s.columns[columnId]?.kind === "done";
}
function isStalled(s, card, days, now = Date.now()) {
  if (days <= 0 || s.columns[card.columnId]?.kind !== "doing") return false;
  const at = Date.parse(card.movedAt);
  return Number.isFinite(at) && now - at >= days * DAY_MS;
}
function daysSinceMoved(card, now = Date.now()) {
  const at = Date.parse(card.movedAt);
  return Number.isFinite(at) ? Math.floor((now - at) / DAY_MS) : 0;
}
function openBlockers(s, cardId) {
  const out = [];
  for (const d of s.dependencies) {
    if (d.type !== "blocks" || d.toCard !== cardId) continue;
    const from = s.cards[cardKey(d.projectId, d.fromCard)];
    if (from && isClosed(from)) continue;
    if (from) out.push(from);
  }
  return out.sort((a, b) => a.id - b.id);
}
function blocksCards(s, cardId) {
  const out = [];
  for (const d of s.dependencies) {
    if (d.type !== "blocks" || d.fromCard !== cardId) continue;
    const to = s.cards[cardKey(d.projectId, d.toCard)];
    if (to) out.push(to);
  }
  return out.sort((a, b) => a.id - b.id);
}
function edgesOf(s, cardId) {
  return s.dependencies.filter((d) => d.fromCard === cardId || d.toCard === cardId);
}
function isBlocked(s, card) {
  if (card.blockedReason) return true;
  return openBlockers(s, card.id).length > 0;
}
function isReady(s, card) {
  if (isClosed(card)) return false;
  if (isDoneColumn(s, card.columnId)) return false;
  return !isBlocked(s, card);
}
function lastActorOf(card) {
  const actor = card.lastActor;
  return actor === void 0 || actor === null || actor === "" ? null : actor;
}
var dueRank = (c) => c.due ?? "9999-12-31";
function readyCards(s) {
  return Object.values(s.cards).filter((c) => c.projectId === s.projectId && isReady(s, c)).sort((a, b) => b.priority - a.priority || dueRank(a).localeCompare(dueRank(b)) || a.id - b.id);
}
function acceptanceProgress(body) {
  let fenced = false;
  let total = 0;
  let done = 0;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^\s{0,3}[-*]\s+\[([ xX])\]\s+(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    total += 1;
    if (m[1].toLowerCase() === "x") done += 1;
  }
  return { total, done };
}
function cardMatches(card, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [card.title, card.body ?? "", card.owner ?? "", ...card.labels ?? []].join("\n").toLowerCase();
  return hay.includes(needle);
}

// web/src/gantt.ts
var DAY = 864e5;
var WEEK = 7 * DAY;
function ts(value) {
  if (!value) return null;
  const t = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(t) ? t : null;
}
function dayStart(t) {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}
function weekStart(t) {
  const d = dayStart(t);
  return d - (new Date(d).getUTCDay() + 6) % 7 * DAY;
}
function monthStart(t) {
  const d = new Date(dayStart(t));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function addMonths(t, n) {
  const d = new Date(monthStart(t));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
}
var M = (t) => {
  const d = new Date(t);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
var YM = (t) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`;
};
function ganttRows(cards, now) {
  const out = [];
  for (const card of cards) {
    const created = ts(card.createdAt);
    const moved = ts(card.movedAt);
    const due = ts(card.due);
    const closedAt = ts(card.closedAt);
    const start = Math.min(created ?? moved ?? now, moved ?? created ?? now);
    const end = closedAt ?? due ?? now;
    out.push({
      card,
      start,
      end: Math.max(start, end),
      due,
      moved,
      closed: closedAt !== null,
      openEnded: closedAt === null && due === null
    });
  }
  return out.sort((a, b) => a.start - b.start || a.card.id - b.card.id);
}
function ganttAxis(rows, scale, now) {
  const lo = rows.length ? Math.min(...rows.map((r) => r.start)) : now;
  const hi = rows.length ? Math.max(...rows.map((r) => r.end)) : now;
  const from = scale === "week" ? weekStart(Math.min(lo, now) - WEEK) : monthStart(Math.min(lo, now) - 2 * WEEK);
  const to = scale === "week" ? weekStart(Math.max(hi, now) + WEEK) + WEEK : addMonths(hi, 2);
  const ticks = [];
  if (scale === "week") {
    for (let t = from; t < to; t += DAY) ticks.push({ at: t, label: M(t), major: new Date(t).getUTCDay() === 1 });
  } else {
    for (let t = from; t < to; t += WEEK) {
      const major = new Date(monthStart(t)).getTime() === t;
      ticks.push({ at: t, label: major ? YM(t) : M(t), major });
    }
  }
  return { from, to, ticks };
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== void 0) n.textContent = text;
  return n;
}
var pct = (t, axis) => axis.to === axis.from ? 0 : Math.min(100, Math.max(0, (t - axis.from) / (axis.to - axis.from) * 100));
function renderGantt(host, cards, o) {
  const rows = ganttRows(cards, o.now);
  const axis = ganttAxis(rows, o.scale, o.now);
  const today = Math.floor(o.now / DAY);
  const sig = [
    o.projectId,
    o.scale,
    axis.from,
    axis.to,
    today,
    ...rows.map((r) => `${r.card.id}:${r.start}:${r.end}:${r.card.title}:${r.card.columnId}`)
  ].join("|");
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.textContent = "";
  const head = el("div", "ov-h");
  head.append(el("h2", void 0, "\u6642\u9593"), el("span", "ov-n", `${rows.length} \u4EF6`));
  const seg = el("div", "gseg");
  for (const scale of ["week", "month"]) {
    const b = el("button", `toggle${o.scale === scale ? " on" : ""}`, scale === "week" ? "\u9031" : "\u6708");
    b.type = "button";
    b.setAttribute("aria-pressed", String(o.scale === scale));
    b.title = scale === "week" ? "\u65E5\u523B\u307F\u30674\u9031\u524D\u5F8C" : "\u9031\u523B\u307F\u3067\u6570\u304B\u6708";
    b.addEventListener("click", () => o.onScale(scale));
    seg.append(b);
  }
  head.append(seg);
  host.append(head);
  host.append(el("div", "ov-n", "\u8AAD\u307F\u53D6\u308A\u5C02\u7528\uFF08due\u30FB\u79FB\u52D5\u30FB\u5B8C\u4E86\u304B\u3089\u5C0E\u51FA\u3002\u30C9\u30E9\u30C3\u30B0\u3057\u3066\u3082\u4FDD\u5B58\u3057\u306A\u3044\uFF09"));
  if (!rows.length) {
    host.append(el("div", "empty", "\u30AB\u30FC\u30C9\u304C\u7121\u3044"));
    return;
  }
  const axisRow = el("div", "gantt-row axis");
  axisRow.append(el("div", "g-label"));
  const axisTrack = el("div", "g-track");
  for (const t of axis.ticks) {
    const tick = el("span", `g-tick${t.major ? " major" : ""}`, t.label);
    tick.style.left = `${pct(t.at, axis)}%`;
    axisTrack.append(tick);
  }
  axisRow.append(axisTrack);
  host.append(axisRow);
  const body = el("div", "gantt-rows");
  for (const r of rows) {
    const row = el("div", "gantt-row");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    const range = `${M(r.start)} \u2192 ${r.openEnded ? "\u672A\u5B9A" : M(r.end)}`;
    row.setAttribute("aria-label", `#${r.card.id} ${r.card.title} ${range}`);
    const label = el("div", "g-label");
    label.append(el("span", "cid", `#${r.card.id}`), el("span", void 0, r.card.title));
    const track = el("div", "g-track");
    const bar = el("div", "g-bar");
    const left = pct(r.start, axis);
    bar.style.left = `${left}%`;
    bar.style.width = `${Math.max(0, pct(r.end, axis) - left)}%`;
    bar.classList.toggle("closed", r.closed);
    bar.classList.toggle("late", !r.closed && r.due !== null && r.due < o.now);
    bar.classList.toggle("open", r.openEnded);
    const col = o.columns[r.card.columnId]?.name ?? r.card.columnId;
    bar.title = `#${r.card.id} ${r.card.title}
${col} \xB7 ${range}${r.card.due ? ` \xB7 due ${r.card.due}` : ""}`;
    track.append(bar);
    if (r.due !== null && r.due >= axis.from && r.due <= axis.to) {
      const mark = el("span", "g-due");
      mark.style.left = `${pct(r.due, axis)}%`;
      mark.title = `due ${r.card.due}`;
      track.append(mark);
    }
    row.append(label, track);
    row.addEventListener("click", () => o.onOpen(r.card));
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        o.onOpen(r.card);
      }
    });
    body.append(row);
  }
  host.append(body);
  host.append(el("div", "ov-n", "\u9752=\u9032\u884C\u4E2D / \u7DD1=\u5B8C\u4E86 / \u8D64=\u671F\u9650\u8D85\u904E\u3002\u9EC4\u8272\u306E\u7E26\u7DDA\u304C due"));
}

// web/src/render.ts
function el2(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== void 0) n.textContent = text;
  return n;
}
function keyedDiff(container, items) {
  const keep = new Set(items);
  for (const node of Array.from(container.children)) if (!keep.has(node)) node.remove();
  let ref = container.firstChild;
  for (const item of items) {
    if (item === ref) {
      ref = ref.nextSibling;
      continue;
    }
    container.insertBefore(item, ref);
  }
}
var toastTimer;
function showToast(view2, message, undo, urgent = false) {
  if (!undo && !urgent && !view2.toast.hidden && !view2.toastUndo.hidden) return;
  view2.toastMsg.textContent = message;
  view2.toastUndo.hidden = !undo;
  view2.toastUndo.onclick = undo ? () => {
    view2.toast.hidden = true;
    undo();
  } : null;
  view2.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    view2.toast.hidden = true;
  }, undo ? 5500 : 5e3);
}
var menuEl = null;
var menuUnlisten = null;
function cardMenu() {
  if (!menuEl) {
    menuEl = el2("div", "ctxmenu");
    menuEl.hidden = true;
    document.body.append(menuEl);
  }
  return menuEl;
}
function closeCardMenu() {
  if (!menuEl || menuEl.hidden) return;
  menuEl.hidden = true;
  menuUnlisten?.();
  menuUnlisten = null;
}
function openCardMenu(view2, s, key, x, y) {
  closeCardMenu();
  const card = s.cards[key];
  if (!card) return;
  const h = view2.h;
  const n = card.priority;
  const picked = s.selection.has(key);
  const entries = [
    { label: "\u7DE8\u96C6\u2026", run: () => h.onEdit(key) },
    { label: "\u8A73\u7D30\u3092\u958B\u304F", run: () => h.onOpen(key) },
    ...s.columnOrder.filter((id) => id !== card.columnId && s.columns[id]).map((id) => ({ label: `\u300C${s.columns[id].name}\u300D\u3078\u79FB\u52D5`, run: () => h.onMove(key, id) })),
    { label: `\u512A\u5148\u5EA6 +1\uFF08\u4ECA ${n}\uFF09`, run: () => h.onSetPriority(key, n + 1), disabled: n >= 99 },
    { label: `\u512A\u5148\u5EA6 \u22121\uFF08\u4ECA ${n}\uFF09`, run: () => h.onSetPriority(key, n - 1), disabled: n <= -99 },
    { sep: true },
    picked ? { label: "\u9078\u629E\u304B\u3089\u5916\u3059", run: () => h.onSelect([...s.selection].filter((k) => k !== key)) } : { label: "\u9078\u629E\u306B\u8FFD\u52A0", run: () => h.onSelect([...s.selection, key]) },
    { label: "\u524A\u9664", run: () => h.onDelete(key), danger: true }
  ];
  const m = cardMenu();
  m.textContent = "";
  let first = null;
  for (const e of entries) {
    if ("sep" in e) {
      m.append(el2("div", "sep"));
      continue;
    }
    const b = el2("button", e.danger ? "danger" : void 0, e.label);
    b.type = "button";
    b.disabled = Boolean(e.disabled);
    if (!e.disabled) {
      b.addEventListener("click", () => {
        closeCardMenu();
        e.run();
      });
      first = first ?? b;
    }
    m.append(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect(), pad = 4;
  m.style.left = `${Math.max(pad, x + r.width > window.innerWidth - pad ? x - r.width : x)}px`;
  m.style.top = `${Math.max(pad, y + r.height > window.innerHeight - pad ? y - r.height : y)}px`;
  first?.focus();
  const onDoc = (ev) => {
    if (ev instanceof KeyboardEvent) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeCardMenu();
      }
      return;
    }
    if (m.contains(ev.target)) return;
    closeCardMenu();
  };
  document.addEventListener("pointerdown", onDoc, true);
  document.addEventListener("keydown", onDoc, true);
  document.addEventListener("scroll", onDoc, true);
  menuUnlisten = () => {
    document.removeEventListener("pointerdown", onDoc, true);
    document.removeEventListener("keydown", onDoc, true);
    document.removeEventListener("scroll", onDoc, true);
  };
}
function wireMarquee(board, h) {
  let drag = null;
  const detach = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
  };
  const stop = () => {
    if (drag?.rect) drag.rect.remove();
    for (const n of board.querySelectorAll(".mq-on")) n.classList.remove("mq-on");
    document.body.classList.remove("mq-on");
    drag = null;
    detach();
  };
  const move = (ev) => {
    if (!drag || drag.id !== ev.pointerId) return;
    if (!drag.rect) {
      if (Math.abs(ev.clientX - drag.x) < 4 && Math.abs(ev.clientY - drag.y) < 4) return;
      drag.rect = el2("div", "mq");
      document.body.append(drag.rect);
      document.body.classList.add("mq-on");
    }
    const x1 = Math.min(drag.x, ev.clientX), y1 = Math.min(drag.y, ev.clientY);
    const x2 = Math.max(drag.x, ev.clientX), y2 = Math.max(drag.y, ev.clientY);
    const css = drag.rect.style;
    css.left = `${x1}px`;
    css.top = `${y1}px`;
    css.width = `${x2 - x1}px`;
    css.height = `${y2 - y1}px`;
    drag.hits = [];
    for (const node of board.querySelectorAll(".card[data-key]")) {
      const b = node.getBoundingClientRect();
      const on = b.left < x2 && b.right > x1 && b.top < y2 && b.bottom > y1;
      node.classList.toggle("mq-on", on);
      if (on) drag.hits.push(node.dataset.key);
    }
  };
  const end = (ev) => {
    if (!drag || drag.id !== ev.pointerId) return;
    const picked = drag.rect ? drag.hits : null;
    stop();
    if (picked) h.onSelect(picked);
  };
  const cancel = () => {
    if (drag) stop();
  };
  board.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || ev.pointerType === "touch") return;
    const t = ev.target;
    if (t.closest(".card, button, input, textarea, select, a, .col-h, .addrow")) return;
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, rect: null, hits: [] };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  });
}
function mount(root2, h) {
  const top = el2("div", "top");
  const brand = el2("div", "brand", "Kanban v2");
  const pick2 = el2("label", "pick");
  const select = el2("select");
  select.setAttribute("aria-label", "project");
  select.addEventListener("change", () => h.onProject(select.value));
  pick2.append(el2("span", "lbl", "project"), select);
  const newForm = el2("form", "newproj");
  const newName = el2("input");
  newName.placeholder = "new project name";
  newName.setAttribute("aria-label", "new project name");
  const newBtn = el2("button", void 0, "\u4F5C\u6210");
  newBtn.type = "submit";
  newForm.append(newName, newBtn);
  newForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = newName.value.trim();
    if (!name) return;
    void h.onCreateProject(name).then((ok) => {
      if (ok) newName.value = "";
    });
  });
  const focusBtn = el2("button", "toggle", "\u30D5\u30A9\u30FC\u30AB\u30B9");
  focusBtn.type = "button";
  focusBtn.title = "\u3044\u307E\u7740\u624B\u3067\u304D\u308B\u30AB\u30FC\u30C9\u3060\u3051\u3092\u8868\u793A";
  focusBtn.addEventListener("click", () => h.onToggleFocus());
  const staleWrap = el2("label", "stale-set");
  staleWrap.title = "DOING \u306E\u30AB\u30FC\u30C9\u304C\u52D5\u304B\u306A\u3044\u307E\u307E\u4F55\u65E5\u3067\u300C\u505C\u6EDE\u300D\u3068\u3059\u308B\u304B\uFF080 \u3067\u7121\u52B9\uFF09";
  const stale = el2("input", "stale-days");
  stale.type = "number";
  stale.min = "0";
  stale.max = "365";
  stale.step = "1";
  stale.setAttribute("aria-label", "\u505C\u6EDE\u3068\u307F\u306A\u3059\u65E5\u6570");
  stale.addEventListener("change", () => h.onStaleDays(stale.valueAsNumber));
  staleWrap.append(el2("span", "lbl", "\u505C\u6EDE"), stale, el2("span", "unit", "\u65E5"));
  const panelBtns = {
    deliverables: el2("button", "toggle", "\u6210\u679C\u7269"),
    timeline: el2("button", "toggle", "\u5C65\u6B74")
  };
  for (const [id, btn] of Object.entries(panelBtns)) {
    btn.type = "button";
    btn.title = id === "deliverables" ? "\u6210\u679C\u7269\u3092\u958B\u304F" : "\u6700\u8FD1\u306E\u51FA\u6765\u4E8B\u3092\u958B\u304F";
    btn.addEventListener("click", () => h.onTogglePanel(id));
  }
  const searchWrap = el2("div", "search");
  const q = el2("input", "q");
  q.type = "search";
  q.placeholder = "\u691C\u7D22\u2026";
  q.setAttribute("aria-label", "\u30AB\u30FC\u30C9\u30FB\u6210\u679C\u7269\u3092\u691C\u7D22");
  q.addEventListener("input", () => h.onSearch(q.value));
  q.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      h.onCloseSearch();
      q.blur();
    }
  });
  const qres = el2("div", "qres");
  qres.hidden = true;
  qres.setAttribute("role", "listbox");
  const searchAllBtn = el2("button", "toggle searchall", "\u5168\u677F");
  searchAllBtn.type = "button";
  searchAllBtn.title = "\u5168\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u3092\u307E\u3068\u3081\u3066\u691C\u7D22";
  searchAllBtn.addEventListener("click", () => h.onToggleSearchAll());
  searchWrap.append(q, searchAllBtn, qres);
  const overviewBtn = el2("button", "toggle", "\u5168\u4F53");
  overviewBtn.type = "button";
  overviewBtn.title = "\u5168\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u3092\u4E00\u753B\u9762\u3067\uFF08\u7DCF\u5408\u7BA1\u7406\uFF09";
  overviewBtn.addEventListener("click", () => h.onToggleOverview());
  const graphBtn = el2("button", "toggle", "\u4F9D\u5B58\u30DE\u30C3\u30D7");
  graphBtn.type = "button";
  graphBtn.title = "\u4F9D\u5B58\u95A2\u4FC2\u3092\u30EC\u30A4\u30E4\u3067\u8868\u793A";
  graphBtn.addEventListener("click", () => h.onToggleGraph());
  const ganttBtn = el2("button", "toggle", "\u6642\u9593");
  ganttBtn.type = "button";
  ganttBtn.title = "due\u30FB\u79FB\u52D5\u30FB\u5B8C\u4E86\u304B\u3089\u6642\u9593\u306E\u68D2\u3092\u51FA\u3059\uFF08\u8AAD\u307F\u53D6\u308A\u5C02\u7528\uFF09";
  ganttBtn.addEventListener("click", () => h.onToggleGantt());
  const viewsBtn = el2("button", "toggle", "\u30D3\u30E5\u30FC");
  viewsBtn.type = "button";
  viewsBtn.title = "\u4FDD\u5B58\u3057\u305F\u691C\u7D22\u30D3\u30E5\u30FC";
  viewsBtn.addEventListener("click", () => h.onTogglePane("views"));
  const templatesBtn = el2("button", "toggle", "\u30C6\u30F3\u30D7\u30EC\u30FC\u30C8");
  templatesBtn.type = "button";
  templatesBtn.title = "\u30AB\u30FC\u30C9\u306E\u96DB\u5F62";
  templatesBtn.addEventListener("click", () => h.onTogglePane("templates"));
  const notifBtn = el2("button", "toggle notif", "\u901A\u77E5");
  notifBtn.type = "button";
  notifBtn.title = "\u8B66\u544A\u30FB\u901A\u77E5\u3092\u958B\u304F";
  const notifCounts = { danger: el2("span", "nb danger"), warn: el2("span", "nb warn"), info: el2("span", "nb info") };
  notifBtn.append(notifCounts.danger, notifCounts.warn, notifCounts.info);
  notifBtn.addEventListener("click", () => h.onTogglePane("notifications"));
  const status = el2("div", "status");
  const themeBtn = el2("button", "toggle theme");
  const densityBtn = el2("button", "toggle density");
  themeBtn.type = "button";
  themeBtn.title = "\u30E9\u30A4\u30C8/\u30C0\u30FC\u30AF\u3092\u5207\u308A\u66FF\u3048\uFF08\u8A18\u61B6\u3059\u308B\uFF09";
  densityBtn.type = "button";
  densityBtn.title = "\u30AB\u30FC\u30C9\u306E\u8A70\u307E\u308A\u3092\u5207\u308A\u66FF\u3048\uFF08\u8A18\u61B6\u3059\u308B\uFF09";
  const applyTheme = (light) => {
    document.documentElement.setAttribute("data-theme", light ? "light" : "dark");
    themeBtn.textContent = light ? "\u30C6\u30FC\u30DE: \u660E" : "\u30C6\u30FC\u30DE: \u6697";
  };
  const applyDensity = (compact) => {
    document.documentElement.setAttribute("data-density", compact ? "compact" : "normal");
    densityBtn.textContent = compact ? "\u5BC6\u5EA6: \u30B3\u30F3\u30D1\u30AF\u30C8" : "\u5BC6\u5EA6: \u6A19\u6E96";
  };
  themeBtn.addEventListener("click", () => {
    const light = document.documentElement.getAttribute("data-theme") !== "light";
    applyTheme(light);
    try {
      localStorage.setItem("kb-theme", light ? "light" : "dark");
    } catch {
    }
  });
  densityBtn.addEventListener("click", () => {
    const compact = document.documentElement.getAttribute("data-density") !== "compact";
    applyDensity(compact);
    try {
      localStorage.setItem("kb-density", compact ? "compact" : "normal");
    } catch {
    }
  });
  try {
    applyTheme(localStorage.getItem("kb-theme") === "light");
    applyDensity(localStorage.getItem("kb-density") === "compact");
  } catch {
    applyTheme(false);
    applyDensity(false);
  }
  top.append(brand, pick2, newForm, searchWrap, focusBtn, staleWrap, panelBtns.deliverables, panelBtns.timeline, overviewBtn, graphBtn, ganttBtn, viewsBtn, templatesBtn, notifBtn, themeBtn, densityBtn, el2("div", "grow"), status);
  const errBar = el2("div", "err");
  errBar.hidden = true;
  const loopBar = el2("section", "loop");
  loopBar.hidden = true;
  const loopStatus = el2("span", "loop-st");
  const loopText = el2("span", "loop-txt");
  const loopNext = el2("button", "link next");
  loopNext.type = "button";
  loopNext.hidden = true;
  const loopStart = el2("button", void 0, "\u958B\u59CB");
  loopStart.type = "button";
  const loopStop = el2("button", void 0, "\u505C\u6B62");
  loopStop.type = "button";
  const loopTick = el2("button", "primary", "\u6B21\u3092\u5F15\u304F");
  loopTick.type = "button";
  loopStart.addEventListener("click", () => h.onLoop("start"));
  loopStop.addEventListener("click", () => h.onLoop("stop"));
  loopTick.addEventListener("click", () => h.onLoop("tick"));
  loopNext.addEventListener("click", () => {
    const id = Number(loopNext.dataset.id ?? "");
    if (Number.isFinite(id) && id > 0) h.onOpenCard(id);
  });
  loopBar.append(loopStatus, loopText, loopNext, el2("div", "grow"), loopStart, loopStop, loopTick);
  const locksBar = el2("section", "locks");
  locksBar.hidden = true;
  locksBar.setAttribute("role", "status");
  const locksText = el2("span", "loop-txt");
  locksBar.append(el2("span", "lock-ic", "\u{1F512}"), locksText);
  const empty = el2("div", "empty");
  empty.hidden = true;
  empty.setAttribute("role", "status");
  const board = el2("div", "board");
  wireMarquee(board, h);
  const selbar = el2("div", "selbar");
  selbar.hidden = true;
  selbar.setAttribute("role", "status");
  const focus = el2("section", "focus");
  focus.hidden = true;
  const focusHead = el2("div", "focus-h");
  const focusTitle = el2("h2", void 0, "\u3044\u307E\u3084\u308B");
  const focusCount = el2("span", "focus-n");
  focusHead.append(focusTitle, focusCount);
  const focusList = el2("div", "focus-list");
  const focusEmpty = el2("div", "focus-empty", "\u7740\u624B\u3067\u304D\u308B\u30AB\u30FC\u30C9\u306F\u306A\u3044\uFF08\u5168\u90E8\u30D6\u30ED\u30C3\u30AF\u4E2D\u304B\u5B8C\u4E86\uFF09");
  focusEmpty.hidden = true;
  focus.append(focusHead, focusList, focusEmpty);
  const panelWrap = el2("div", "panels");
  const mkSidePanel = (id, title) => {
    const aside = el2("aside", "panel");
    aside.hidden = true;
    const head = el2("div", "panel-h");
    const h2 = el2("h2", void 0, title);
    const close = el2("button", "ic", "\xD7");
    close.type = "button";
    close.title = "\u9589\u3058\u308B";
    close.addEventListener("click", () => h.onTogglePanel(id));
    head.append(h2, close);
    const body = el2("div", "panel-body");
    aside.append(head, body);
    panelWrap.append(aside);
    return { aside, head: h2, body };
  };
  const delivPanel = mkSidePanel("deliverables", "\u6210\u679C\u7269");
  const histPanel = mkSidePanel("timeline", "\u5C65\u6B74");
  document.addEventListener("pointerdown", (ev) => {
    const target = ev.target;
    if (qres.hidden || !target || searchWrap.contains(target)) return;
    h.onCloseSearch();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !qres.hidden) {
      ev.preventDefault();
      h.onCloseSearch();
    }
  });
  const toast = el2("div", "toast");
  const toastMsg = el2("span", "toast-msg");
  const toastUndo = el2("button", "toast-undo", "\u53D6\u308A\u6D88\u3059");
  toastUndo.hidden = true;
  toast.append(toastMsg, toastUndo);
  toast.hidden = true;
  const overview = el2("section", "ov");
  overview.hidden = true;
  const graph = el2("section", "graph");
  graph.hidden = true;
  const gantt = el2("section", "gantt");
  gantt.hidden = true;
  const mkPane = (title, onClose) => {
    const aside = el2("aside", "panel pane");
    aside.hidden = true;
    const head = el2("div", "panel-h");
    const close = el2("button", "ic", "\xD7");
    close.type = "button";
    close.title = "\u9589\u3058\u308B";
    close.addEventListener("click", onClose);
    head.append(el2("h2", void 0, title), close);
    const body = el2("div", "panel-body");
    aside.append(head, body);
    return { aside, body };
  };
  const tplPane = mkPane("\u30C6\u30F3\u30D7\u30EC\u30FC\u30C8", () => h.onTogglePane("templates"));
  const viewPane = mkPane("\u30D3\u30E5\u30FC", () => h.onTogglePane("views"));
  const notifPane = mkPane("\u901A\u77E5", () => h.onTogglePane("notifications"));
  root2.append(
    top,
    errBar,
    loopBar,
    locksBar,
    empty,
    board,
    overview,
    graph,
    gantt,
    focus,
    panelWrap,
    tplPane.aside,
    viewPane.aside,
    notifPane.aside,
    toast
  );
  return {
    root: root2,
    top,
    h,
    select,
    newName,
    status,
    errBar,
    empty,
    board,
    selbar,
    focus,
    focusCount,
    focusList,
    focusEmpty,
    focusBtn,
    stale,
    panelBtns,
    toast,
    toastMsg,
    toastUndo,
    panelWrap,
    panelDeliv: delivPanel.aside,
    panelDelivHead: delivPanel.head,
    panelDelivBody: delivPanel.body,
    panelDelivSig: "",
    panelHist: histPanel.aside,
    panelHistHead: histPanel.head,
    panelHistBody: histPanel.body,
    panelHistSig: "",
    q,
    qres,
    searchAllBtn,
    notifBtn,
    notifCounts,
    overviewBtn,
    graphBtn,
    ganttBtn,
    viewsBtn,
    templatesBtn,
    loopBar,
    loopStatus,
    loopText,
    loopNext,
    loopStart,
    loopStop,
    loopTick,
    overview,
    overviewSig: "",
    graph,
    graphSig: "",
    gantt,
    locks: locksBar,
    locksText,
    locksSig: "",
    paneTemplates: tplPane.aside,
    paneViews: viewPane.aside,
    paneNotif: notifPane.aside,
    paneSig: { templates: "", views: "", notif: "" },
    cols: /* @__PURE__ */ new Map(),
    cards: /* @__PURE__ */ new Map(),
    focusRows: /* @__PURE__ */ new Map(),
    projectSig: "",
    focusSig: ""
  };
}
function makeColumn(id, h) {
  const section = el2("section", "col");
  section.dataset.col = id;
  const head = el2("div", "col-h");
  const name = el2("h2", "col-name");
  const count = el2("span", "col-count");
  const editBtn = el2("button", "ic", "\u2699");
  editBtn.type = "button";
  editBtn.title = "\u5217\u540D\u3068 WIP \u4E0A\u9650\u3092\u7DE8\u96C6";
  head.append(name, count, editBtn);
  const editEl = el2("form", "col-edit");
  editEl.hidden = true;
  const editName = el2("input", "ce-name");
  editName.placeholder = "\u5217\u540D";
  editName.setAttribute("aria-label", "column name");
  const editWip = el2("input", "ce-wip");
  editWip.type = "number";
  editWip.min = "0";
  editWip.step = "1";
  editWip.placeholder = "WIP\u4E0A\u9650\uFF08\u7A7A=\u7121\u5236\u9650\uFF09";
  editWip.setAttribute("aria-label", "wip limit");
  const editSave = el2("button", "primary", "\u4FDD\u5B58");
  editSave.type = "submit";
  const editCancel = el2("button", "ghost", "\xD7");
  editCancel.type = "button";
  const editNote = el2("div", "ce-err");
  editNote.hidden = true;
  editEl.append(editName, editWip, editSave, editCancel, editNote);
  editBtn.addEventListener("click", () => {
    editEl.hidden = !editEl.hidden;
    editNote.hidden = true;
    if (editEl.hidden) return;
    editName.value = name.textContent ?? "";
    editWip.value = section.dataset.wip ?? "";
    editName.focus();
  });
  editCancel.addEventListener("click", () => {
    editEl.hidden = true;
    editNote.hidden = true;
  });
  editEl.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const patch = { wipLimit: null };
    const nm = editName.value.trim();
    if (nm) patch.name = nm;
    const wip = editWip.value.trim();
    if (wip !== "") {
      const n = Number(wip);
      if (!Number.isFinite(n) || n < 0) {
        editNote.textContent = "WIP \u4E0A\u9650\u306F 0 \u4EE5\u4E0A\u306E\u6570\u5024\u3067\u5165\u529B\u3059\u308B\uFF08\u7A7A=\u7121\u5236\u9650\uFF09";
        editNote.hidden = false;
        return;
      }
      patch.wipLimit = Math.trunc(n);
    }
    void h.onEditColumn(id, patch).then((err) => {
      if (err) {
        editNote.textContent = err;
        editNote.hidden = false;
        return;
      }
      editNote.hidden = true;
      editEl.hidden = true;
    });
  });
  const list = el2("div", "cards");
  const more = el2("button", "col-more");
  more.type = "button";
  more.hidden = true;
  more.addEventListener("click", () => h.onToggleDone());
  const add = el2("form", "addrow");
  const input = el2("input");
  input.placeholder = "#proj !2 due:2026-12-01 \u30BF\u30B9\u30AF";
  input.setAttribute("aria-label", "add card");
  const btn = el2("button", void 0, "\u8FFD\u52A0");
  btn.type = "submit";
  add.append(input, btn);
  add.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    void h.onAddCard(id, title).then((ok) => {
      if (ok) input.value = "";
    });
  });
  const clearDrop = () => section.classList.remove("drop");
  section.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    section.classList.add("drop");
  });
  section.addEventListener("dragleave", (ev) => {
    if (!section.contains(ev.relatedTarget)) clearDrop();
  });
  section.addEventListener("drop", (ev) => {
    ev.preventDefault();
    clearDrop();
    const key = ev.dataTransfer?.getData("text/plain");
    if (key) h.onMove(key, id);
  });
  section.append(head, editEl, list, more, add);
  return { el: section, name, count, list, more, editEl, editName, editWip, editNote };
}
function fillMoves(moves, card, s, key, h) {
  moves.textContent = "";
  for (const id of s.columnOrder) {
    const col = s.columns[id];
    if (!col || id === card.columnId) continue;
    const b = el2("button", "mv", `\u2192 ${col.name}`);
    b.type = "button";
    b.dataset.col = id;
    moves.append(b);
  }
  moves.hidden = moves.childElementCount === 0;
  moves.onclick = (ev) => {
    const b = ev.target.closest("button[data-col]");
    if (b) h.onMove(key, b.dataset.col);
  };
}
function makeCardNode(key, h) {
  const node = el2("div", "card");
  node.dataset.key = key;
  node.draggable = true;
  node.addEventListener("dragstart", (ev) => {
    node.classList.add("dragging");
    ev.dataTransfer?.setData("text/plain", key);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
  });
  node.addEventListener("dragend", () => node.classList.remove("dragging"));
  const head = el2("div", "card-h");
  const prio = el2("span", "prio");
  const cid = el2("span", "cid");
  const due = el2("span", "due");
  const open = el2("button", "ic", "\u2922");
  open.type = "button";
  open.title = "\u8A73\u7D30\u30FB\u4F9D\u5B58\u30FB\u5C65\u6B74";
  const edit = el2("button", "ic", "\u270E");
  edit.type = "button";
  edit.title = "\u30BF\u30A4\u30C8\u30EB\u3092\u7DE8\u96C6";
  const del = el2("button", "ic", "\xD7");
  del.type = "button";
  del.title = "\u524A\u9664";
  open.addEventListener("click", () => h.onOpen(node.dataset.key));
  edit.addEventListener("click", () => h.onEdit(node.dataset.key));
  del.addEventListener("click", () => h.onDelete(node.dataset.key));
  head.append(prio, cid, due, open, edit, del);
  const title = el2("div", "title");
  const meta = el2("div", "meta");
  const body = el2("div", "body");
  const deps = el2("div", "deps");
  const moves = el2("div", "moves");
  node.addEventListener("dblclick", (ev) => {
    if (ev.target.closest("button, input, select, textarea")) return;
    h.onOpen(node.dataset.key);
  });
  node.append(head, title, meta, body, deps, moves);
  return node;
}
function emptyText(s) {
  if (!s.projectId) {
    return s.error ? "\u30B5\u30FC\u30D0\u304B\u3089\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u4E00\u89A7\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3002\u4E0A\u90E8\u306E\u30A8\u30E9\u30FC\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002" : "\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u304C\u3042\u308A\u307E\u305B\u3093\u3002\u53F3\u4E0A\u306E\u6B04\u3067\u4F5C\u6210\u3057\u3066\u304F\u3060\u3055\u3044\u3002";
  }
  if (s.error) return "\u30DC\u30FC\u30C9\u3092\u8868\u793A\u3067\u304D\u307E\u305B\u3093\u3002";
  return "\u30DC\u30FC\u30C9\u3092\u8AAD\u307F\u8FBC\u307F\u4E2D\u2026";
}
function cardSig(card) {
  return [
    card.title,
    card.body ?? "",
    card.priority,
    card.version,
    card.columnId,
    card.blockedReason ?? "",
    card.owner ?? "",
    card.due ?? "",
    card.closedAt ?? "",
    lastActorOf(card) ?? ""
  ].join("");
}
function depsSig(s, card) {
  return [
    ...openBlockers(s, card.id).map((c) => `b${c.id}`),
    ...blocksCards(s, card.id).map((c) => `o${c.id}`)
  ].join(",");
}
function updateCard(node, card, s, h) {
  const blockers = openBlockers(s, card.id);
  const blocked = isBlocked(s, card);
  const progress = acceptanceProgress(card.body);
  if (node.dataset.sig !== cardSig(card)) {
    node.dataset.sig = cardSig(card);
    const q = (c) => node.querySelector(c);
    q(".title").textContent = card.title;
    const body = q(".body");
    body.textContent = card.body ?? "";
    body.hidden = !card.body;
    const prio = q(".prio");
    prio.textContent = `p${card.priority}`;
    prio.classList.toggle("hot", card.priority > 0);
    const cid = q(".cid");
    cid.textContent = `#${card.id}`;
    const due = q(".due");
    const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    due.textContent = card.due ? card.due : "";
    due.hidden = !card.due;
    due.classList.toggle("overdue", Boolean(card.due && card.due < today && !isClosed(card)));
    const meta = q(".meta");
    meta.textContent = "";
    if (card.owner) meta.append(el2("span", "chip owner", `@${card.owner}`));
    const actor = lastActorOf(card);
    if (actor) {
      const chip = el2("span", "chip actor", `\u21BB ${actor}`);
      chip.title = `\u6700\u7D42\u66F4\u65B0\u8005: ${actor}`;
      meta.append(chip);
    }
    if (progress.total > 0) {
      const chip = el2("span", "chip acc", `\u2611 ${progress.done}/${progress.total}`);
      chip.classList.toggle("acc-done", progress.done === progress.total);
      meta.append(chip);
    }
    if (card.blockedReason) meta.append(el2("span", "chip blocked-chip", `\u26D4 ${card.blockedReason}`));
    node.classList.toggle("blocked", blocked);
    node.classList.toggle("closed", isClosed(card) || isDoneColumn(s, card.columnId));
    const hints = [
      card.blockedReason ? `blocked: ${card.blockedReason}` : null,
      blockers.length ? `blocked by: ${blockers.map((c) => `#${c.id} ${c.title}`).join(" / ")}` : null,
      ...progress.total ? [`acceptance: ${progress.done}/${progress.total}`] : []
    ].filter(Boolean);
    if (hints.length) node.title = hints.join("\n");
    else node.removeAttribute("title");
  }
  if (node.dataset.depsig !== depsSig(s, card)) {
    node.dataset.depsig = depsSig(s, card);
    const deps = node.querySelector(".deps");
    deps.textContent = "";
    for (const b of blockers) {
      const chip = el2("span", "chip dep", `\u26D4 #${b.id}`);
      chip.title = b.title;
      deps.append(chip);
    }
    for (const o of blocksCards(s, card.id)) {
      const chip = el2("span", "chip dep-out", `\u2192 #${o.id}`);
      chip.title = o.title;
      deps.append(chip);
    }
    deps.hidden = deps.childElementCount === 0;
  }
  const colsig = `${s.projectId}|${s.columnOrder.join(",")}|${card.columnId}`;
  if (node.dataset.colsig !== colsig) {
    node.dataset.colsig = colsig;
    fillMoves(node.querySelector(".moves"), card, s, node.dataset.key, h);
  }
  const stalled = isStalled(s, card, s.staleDays);
  node.classList.toggle("stale", stalled);
  const metaEl = node.querySelector(".meta");
  let staleChip = metaEl?.querySelector(".chip.stale-chip");
  if (stalled) {
    if (!staleChip && metaEl) staleChip = metaEl.appendChild(el2("span", "chip warn stale-chip"));
    if (staleChip) staleChip.textContent = `${daysSinceMoved(card)}\u65E5\u505C\u6EDE`;
  } else if (staleChip) staleChip.remove();
  if (metaEl) metaEl.hidden = metaEl.childElementCount === 0;
  node.classList.toggle("pending", s.pending.has(node.dataset.key));
}
function focusRow(key, h) {
  const row = el2("div", "focus-row");
  row.dataset.key = key;
  const head = el2("div", "fr-h");
  const prio = el2("span", "prio");
  const cid = el2("span", "cid");
  const open = el2("button", "ic", "\u2922");
  open.type = "button";
  open.title = "\u8A73\u7D30";
  open.addEventListener("click", () => h.onOpen(row.dataset.key));
  head.append(prio, cid, el2("div", "grow"), open);
  const title = el2("div", "title");
  const meta = el2("div", "meta");
  const moves = el2("div", "moves");
  row.append(head, title, meta, moves);
  return row;
}
function delivPanelSig(s) {
  return [
    s.projectId,
    s.delSort,
    s.q,
    ...s.deliverables.map((d) => `${d.id}:${d.title}:${d.kind}:${d.cardId ?? ""}`)
  ].join("");
}
function histPanelSig(s) {
  return [
    s.projectId,
    ...s.timeline.slice(-40).map((e) => `${e.seq}:${e.kind}:${e.entityId}`)
  ].join("");
}
function eventLabel(kind) {
  const map = {
    "project.created": "\u4F5C\u6210",
    "project.updated": "\u66F4\u65B0",
    "card.created": "\u30AB\u30FC\u30C9\u8FFD\u52A0",
    "card.updated": "\u30AB\u30FC\u30C9\u66F4\u65B0",
    "card.moved": "\u79FB\u52D5",
    "card.deleted": "\u524A\u9664",
    "dependency.added": "\u4F9D\u5B58\u8FFD\u52A0",
    "dependency.removed": "\u4F9D\u5B58\u89E3\u9664",
    "deliverable.created": "\u6210\u679C\u7269\u8FFD\u52A0",
    "deliverable.updated": "\u6210\u679C\u7269\u66F4\u65B0",
    "deliverable.deleted": "\u6210\u679C\u7269\u524A\u9664"
  };
  return map[kind] ?? kind;
}
function renderDelivPanel(view2, s) {
  const sig = delivPanelSig(s);
  if (view2.panelDelivSig === sig) return;
  view2.panelDelivSig = sig;
  view2.panelDelivHead.textContent = "";
  const shown = panelDeliverables(s);
  const total = s.deliverables.length;
  const sortBtn = el2("button", "ic del-sort", s.delSort === "old" ? "\u65E7\u2192\u65B0" : "\u65B0\u2192\u65E7");
  sortBtn.type = "button";
  sortBtn.title = s.delSort === "old" ? "\u53E4\u3044\u9806\uFF08\u30AF\u30EA\u30C3\u30AF\u3067\u65B0\u3057\u3044\u9806\uFF09" : "\u65B0\u3057\u3044\u9806\uFF08\u30AF\u30EA\u30C3\u30AF\u3067\u53E4\u3044\u9806\uFF09";
  sortBtn.setAttribute("aria-pressed", String(s.delSort === "old"));
  sortBtn.addEventListener("click", () => view2.h.onToggleDelSort());
  const headText = shown.length === total ? `\u6210\u679C\u7269 ($total)` : `\u7D5E\u8FBC\u4E2D ${shown.length} / \u5168 ${total} \u679A`;
  view2.panelDelivHead.append(el2("span", void 0, headText), sortBtn);
  view2.panelDelivBody.textContent = "";
  const delSec = el2("section", "p-sec");
  const addForm = el2("form", "p-add");
  const addInput = el2("input");
  addInput.placeholder = "\u6210\u679C\u7269\u3092\u8FFD\u52A0";
  addInput.setAttribute("aria-label", "add deliverable");
  const addBtn = el2("button", void 0, "\u8FFD\u52A0");
  addBtn.type = "submit";
  addForm.append(addInput, addBtn);
  addForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const title = addInput.value.trim();
    if (!title) return;
    void view2.h.onAddDeliverable(title).then((ok) => {
      if (ok) addInput.value = "";
    });
  });
  delSec.append(addForm);
  const list = el2("div", "p-list");
  if (!total) list.append(el2("div", "p-empty", "\u6210\u679C\u7269\u306F\u307E\u3060\u306A\u3044"));
  else if (!shown.length) list.append(el2("div", "p-empty", "\u4E00\u81F4\u3059\u308B\u6210\u679C\u7269\u304C\u7121\u3044"));
  for (const d of shown) {
    const row = el2("div", "p-row");
    const main = el2("div", "p-main");
    const t = el2("div", "p-title", d.title);
    t.title = d.title;
    main.append(t);
    const sub = el2("div", "p-sub");
    sub.append(el2("span", "chip kind", d.kind));
    if (d.ref) sub.append(refLink(d));
    if (d.cardId !== null && d.cardId !== void 0) {
      const link = el2("button", "link", `#${d.cardId}`);
      link.type = "button";
      link.addEventListener("click", () => {
        const key = cardKey(s.projectId, d.cardId);
        if (s.cards[key]) view2.h.onOpen(key);
        else showToast(view2, `\u30AB\u30FC\u30C9 #${d.cardId} \u306F\u3082\u3046\u7121\u3044`);
      });
      sub.append(link);
    }
    main.append(sub);
    const shot = refImageThumb(d);
    if (shot) main.append(shot);
    const thumbs = thumbStrip(s.attachments.filter((a) => a.deliverableId === d.id), d.projectId);
    if (thumbs) main.append(thumbs);
    const rm = el2("button", "ic", "\xD7");
    rm.type = "button";
    rm.title = "\u6210\u679C\u7269\u3092\u524A\u9664";
    rm.addEventListener("click", () => view2.h.onDeleteDeliverable(d.projectId, d.id));
    row.append(main, rm);
    list.append(row);
  }
  delSec.append(list);
  view2.panelDelivBody.append(delSec);
}
function renderHistPanel(view2, s) {
  const sig = histPanelSig(s);
  if (view2.panelHistSig === sig) return;
  view2.panelHistSig = sig;
  view2.panelHistBody.textContent = "";
  const tlSec = el2("section", "p-sec");
  const tl = el2("div", "p-list tl");
  if (!s.timeline.length) tl.append(el2("div", "p-empty", "\u51FA\u6765\u4E8B\u306F\u307E\u3060\u306A\u3044"));
  for (const e of s.timeline.slice(-40).reverse()) {
    const row = el2("div", "tl-row");
    const at = el2("span", "tl-at", e.at.slice(5, 16).replace("T", " "));
    const what = el2("span", "tl-kind", eventLabel(e.kind));
    row.append(at, what);
    const target = e.entityType === "card" || e.entityType === "deliverable" ? e.entityId : "";
    if (target) {
      row.append(el2("span", "tl-id", target.slice(target.indexOf("#") + 1)));
      if (e.entityType === "card") {
        const key = e.entityId;
        if (s.cards[key]) {
          row.classList.add("clickable");
          row.addEventListener("click", () => view2.h.onOpen(key));
        }
      }
    }
    tl.append(row);
  }
  tlSec.append(tl);
  view2.panelHistBody.append(tlSec);
}
function renderFocus(view2, s) {
  view2.focus.hidden = !s.focus || !s.projectId;
  if (!view2.focus.hidden) {
    const ready = readyCards(s);
    const sig = [s.projectId, ...ready.map((c) => `${c.id}:${c.version}:${c.title}:${c.priority}:${c.owner ?? ""}:${c.due ?? ""}`)].join("|");
    view2.focusCount.textContent = String(ready.length);
    if (view2.focusSig !== sig) {
      view2.focusSig = sig;
      const els = [];
      for (const card of ready) {
        const key = cardKey(card.projectId, card.id);
        let row = view2.focusRows.get(key);
        if (!row) {
          row = focusRow(key, view2.h);
          view2.focusRows.set(key, row);
        }
        row.querySelector(".prio").textContent = `p${card.priority}`;
        row.querySelector(".cid").textContent = `#${card.id}`;
        row.querySelector(".title").textContent = card.title;
        const meta = row.querySelector(".meta");
        meta.textContent = "";
        meta.append(el2("span", "chip", s.columns[card.columnId]?.name ?? card.columnId));
        if (card.owner) meta.append(el2("span", "chip owner", `@${card.owner}`));
        if (card.due) meta.append(el2("span", "chip", `due ${card.due}`));
        const progress = acceptanceProgress(card.body);
        if (progress.total) meta.append(el2("span", "chip acc", `\u2611 ${progress.done}/${progress.total}`));
        fillMoves(row.querySelector(".moves"), card, s, key, view2.h);
        row.classList.toggle("pending", s.pending.has(key));
        els.push(row);
      }
      keyedDiff(view2.focusList, els);
    }
    view2.focusEmpty.hidden = ready.length > 0;
  }
  const staleRows = [];
  const live = new Set(s.focus && s.projectId ? readyCards(s).map((c) => cardKey(c.projectId, c.id)) : []);
  for (const key of view2.focusRows.keys()) if (!live.has(key)) staleRows.push(key);
  for (const key of staleRows) {
    view2.focusRows.get(key)?.remove();
    view2.focusRows.delete(key);
  }
}
var REF_IMAGE = /\.(png|jpe?g|gif|webp)$/i;
var refName = (ref) => ref.split(/[\\/]/).pop() || ref;
function refLink(d) {
  const link = el2("a", "chip", refName(d.ref));
  link.href = deliverableViewSrc(d.projectId, d.id);
  link.target = "_blank";
  link.rel = "noopener";
  link.title = d.ref;
  return link;
}
function refImageThumb(d) {
  if (!REF_IMAGE.test(d.ref)) return null;
  const a = el2("a", "thumbs");
  a.href = deliverableViewSrc(d.projectId, d.id);
  a.target = "_blank";
  a.rel = "noopener";
  a.title = d.ref;
  const img = el2("img", "thumb");
  img.src = deliverableFileSrc(d.projectId, d.id);
  img.alt = refName(d.ref);
  img.loading = "lazy";
  a.append(img);
  return a;
}
function thumbStrip(list, projectId) {
  if (!list.length) return null;
  const wrap = el2("div", "thumbs");
  for (const a of list) {
    if (a.mime.startsWith("image/")) {
      const img = el2("img", "thumb");
      img.loading = "lazy";
      img.src = attachmentSrc(projectId, a.id);
      img.alt = a.name;
      img.title = a.name;
      wrap.append(img);
    } else {
      const doc = el2("a", "thumb doc");
      doc.href = attachmentViewSrc(projectId, a.id);
      doc.target = "_blank";
      doc.rel = "noopener";
      doc.textContent = docLabel(a.mime);
      doc.title = a.name;
      wrap.append(doc);
    }
  }
  return wrap;
}
function docLabel(mime) {
  if (mime === "application/pdf") return "PDF";
  if (mime.startsWith("video/")) return "\u52D5\u753B";
  if (mime.startsWith("audio/")) return "\u97F3\u58F0";
  if (mime.includes("zip")) return "ZIP";
  return "\u6587\u66F8";
}
function renderSearch(view2, s) {
  const hits = s.hits;
  view2.qres.hidden = hits === null;
  if (hits === null) return;
  const sig = `${s.searchAll}|${hits.map((h) => `${h.projectId}:${h.type}:${h.id}:${h.title}`).join("")}`;
  if (view2.qres.dataset.sig === sig) return;
  view2.qres.dataset.sig = sig;
  view2.qres.textContent = "";
  if (!hits.length) {
    view2.qres.append(el2("div", "p-empty", "\u8A72\u5F53\u306A\u3057"));
    return;
  }
  for (const hit of hits) {
    const row = el2(hit.type === "card" ? "button" : "div", "q-hit");
    row.setAttribute("role", "option");
    if (row instanceof HTMLButtonElement) {
      row.type = "button";
      row.addEventListener("click", () => view2.h.onOpenHit(hit));
    }
    const top = el2("div", "q-h");
    top.append(el2("span", "q-type", hit.type === "card" ? "\u30AB\u30FC\u30C9" : "\u6210\u679C\u7269"), el2("span", "cid", `#${hit.id}`));
    if (s.searchAll) {
      const name = s.projects.find((x) => x.slug === hit.projectId)?.name ?? hit.projectId;
      const onBoard = hit.projectId === s.projectId;
      top.append(el2("span", onBoard ? "chip" : "chip other-board", name));
    }
    if (hit.columnId && hit.projectId === s.projectId) {
      top.append(el2("span", "chip", s.columns[hit.columnId]?.name ?? hit.columnId));
    }
    const title = el2("div", "q-title", hit.title);
    row.append(top, title);
    if (hit.snippet && hit.snippet !== hit.title) row.append(el2("div", "q-snip", hit.snippet));
    view2.qres.append(row);
  }
}
var LEVEL_LABEL = { danger: "\u5371\u967A", warn: "\u8B66\u544A", info: "\u60C5\u5831" };
var LEVELS = ["danger", "warn", "info"];
function renderNotifBadges(view2, s) {
  const counts = LEVELS.map((level) => s.notifications.filter((n) => n.level === level).length);
  LEVELS.forEach((level, i) => {
    const badge = view2.notifCounts[level];
    badge.textContent = counts[i] ? String(counts[i]) : "";
    badge.hidden = counts[i] === 0;
    badge.title = `${LEVEL_LABEL[level]} ${counts[i]} \u4EF6`;
  });
  view2.notifBtn.setAttribute("aria-label", `\u901A\u77E5 \u5371\u967A ${counts[0]} \u8B66\u544A ${counts[1]} \u60C5\u5831 ${counts[2]}`);
}
function loopBarText(loop, now = Date.now()) {
  const bits = [`tick ${loop.ticks}`];
  if (loop.nextTickAt) {
    const left = Math.ceil((Date.parse(loop.nextTickAt) - now) / 1e3);
    bits.push(left > 0 ? `\u6B21 ${left}s` : "\u307E\u3082\u306A\u304F");
  }
  if (loop.haltReason) bits.push(`\u7406\u7531: ${loop.haltReason}`);
  return bits.join(" \xB7 ");
}
function renderLoop(view2, s) {
  const loop = s.loop;
  view2.loopBar.hidden = !s.projectId || !loop;
  if (!s.projectId || !loop) return;
  view2.loopStatus.textContent = loop.status === "running" ? "\u7A3C\u50CD\u4E2D" : loop.status === "halted" ? "\u505C\u6B62" : "\u5F85\u6A5F";
  view2.loopStatus.className = `loop-st ${loop.status}`;
  view2.loopText.dataset.nextTickAt = loop.nextTickAt ?? "";
  view2.loopText.textContent = loopBarText(loop);
  view2.loopText.title = loop.haltReason ?? "";
  view2.loopNext.hidden = loop.nextCardId === null;
  if (loop.nextCardId !== null) {
    view2.loopNext.dataset.id = String(loop.nextCardId);
    view2.loopNext.textContent = `\u6B21: #${loop.nextCardId}`;
  }
  view2.loopStart.disabled = loop.status === "running";
  view2.loopStop.disabled = loop.status !== "running";
  view2.loopTick.disabled = loop.status !== "running";
}
function paneBody(aside) {
  const body = aside.querySelector(".panel-body");
  return body instanceof HTMLElement ? body : aside;
}
function renderNotifications(view2, s) {
  if (view2.paneNotif.hidden) {
    view2.paneSig.notif = "";
    return;
  }
  const sig = [
    s.projectId,
    ...s.notifications.map((n) => `${n.level}:${n.kind}:${n.cardId ?? ""}:${n.title}:${n.detail}`)
  ].join("");
  if (view2.paneSig.notif === sig) return;
  view2.paneSig.notif = sig;
  const body = paneBody(view2.paneNotif);
  body.textContent = "";
  if (!s.notifications.length) {
    body.append(el2("div", "p-empty", "\u901A\u77E5\u306F\u306A\u3044"));
    return;
  }
  for (const level of LEVELS) {
    const group = s.notifications.filter((n) => n.level === level);
    if (!group.length) continue;
    const sec = el2("section", "p-sec");
    sec.append(el2("h3", `p-h lv-${level}`, `${LEVEL_LABEL[level]} (${group.length})`));
    const list = el2("div", "p-list");
    for (const n of group) {
      const row = el2("div", "p-row");
      const main = el2("div", "p-main");
      const title = el2("div", "p-title", n.title);
      title.title = n.title;
      main.append(title);
      const sub = el2("div", "p-sub");
      sub.append(el2("span", "chip kind", n.kind));
      if (n.cardId != null) sub.append(el2("span", "cid", `#${n.cardId}`));
      if (n.detail) sub.append(el2("span", "p-note", n.detail));
      main.append(sub);
      row.append(main);
      if (n.cardId != null) {
        row.classList.add("clickable");
        row.addEventListener("click", () => view2.h.onOpenCard(n.cardId));
      }
      list.append(row);
    }
    sec.append(list);
    body.append(sec);
  }
}
function renderTemplates(view2, s) {
  if (view2.paneTemplates.hidden) {
    view2.paneSig.templates = "";
    return;
  }
  const sig = [s.projectId, ...s.templates.map((t) => `${t.id}:${t.name}:${t.title}:${t.columnId ?? ""}`)].join("");
  if (view2.paneSig.templates === sig) return;
  view2.paneSig.templates = sig;
  const body = paneBody(view2.paneTemplates);
  body.textContent = "";
  if (!s.templates.length) {
    body.append(el2("div", "p-empty", "\u30C6\u30F3\u30D7\u30EC\u30FC\u30C8\u306F\u307E\u3060\u306A\u3044\uFF08\u30AB\u30FC\u30C9\u3092\u958B\u3044\u3066\u300C\u30C6\u30F3\u30D7\u30EC\u30FC\u30C8\u5316\u300D\uFF09"));
    return;
  }
  const list = el2("div", "p-list");
  for (const t of s.templates) {
    const row = el2("div", "p-row");
    const main = el2("div", "p-main");
    const title = el2("div", "p-title", t.name);
    title.title = t.name;
    main.append(title);
    const sub = el2("div", "p-sub");
    sub.append(el2("span", "chip", t.title));
    sub.append(el2("span", "chip", `p${t.priority}`));
    if (t.columnId) sub.append(el2("span", "chip", s.columns[t.columnId]?.name ?? t.columnId));
    main.append(sub);
    const use = el2("button", "link", "\u4F7F\u3046");
    use.type = "button";
    use.title = "\u3053\u306E\u30C6\u30F3\u30D7\u30EC\u30FC\u30C8\u304B\u3089\u30AB\u30FC\u30C9\u3092\u4F5C\u308B";
    use.addEventListener("click", () => view2.h.onUseTemplate(t.id));
    const rm = el2("button", "ic", "\xD7");
    rm.type = "button";
    rm.title = "\u30C6\u30F3\u30D7\u30EC\u30FC\u30C8\u3092\u524A\u9664";
    rm.addEventListener("click", () => view2.h.onDeleteTemplate(t.id));
    row.append(main, use, rm);
    list.append(row);
  }
  body.append(list);
}
function renderViews(view2, s) {
  if (view2.paneViews.hidden) {
    view2.paneSig.views = "";
    return;
  }
  let body = paneBody(view2.paneViews);
  if (body.dataset.built !== "1") {
    body.dataset.built = "1";
    body.textContent = "";
    const form = el2("form", "p-add");
    const nameInput2 = el2("input");
    nameInput2.setAttribute("aria-label", "view name");
    const save = el2("button", void 0, "\u4FDD\u5B58");
    save.type = "submit";
    form.append(nameInput2, save);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const name = nameInput2.value.trim();
      if (!name) return;
      void view2.h.onSaveView(name).then((ok) => {
        if (ok) nameInput2.value = "";
      });
    });
    const focus = el2("label", "ce-focus");
    const box = el2("input");
    box.type = "checkbox";
    box.addEventListener("change", () => view2.h.onToggleFocusQuery(box.checked));
    focus.append(box, el2("span", void 0, "\u30DC\u30FC\u30C9\u3082\u3053\u306E\u6761\u4EF6\u3067\u7D5E\u308A\u8FBC\u3080"));
    body.append(form, focus, el2("div", "p-list"));
  }
  const nameInput = body.querySelector(".p-add input");
  if (nameInput instanceof HTMLInputElement) nameInput.placeholder = s.q ? `\u300C${s.q}\u300D\u3092\u30D3\u30E5\u30FC\u3068\u3057\u3066\u4FDD\u5B58` : "\u30D3\u30E5\u30FC\u540D";
  const focusLabel = body.querySelector(".ce-focus");
  if (focusLabel instanceof HTMLElement) {
    focusLabel.hidden = !s.q;
    const box = focusLabel.querySelector("input");
    if (box instanceof HTMLInputElement) box.checked = s.qFocus;
  }
  const sig = [s.projectId, ...s.views.map((v) => `${v.id}:${v.name}:${v.query.q ?? ""}:${v.query.focus ? 1 : 0}`)].join("");
  if (view2.paneSig.views === sig) return;
  view2.paneSig.views = sig;
  const list = body.querySelector(".p-list");
  if (!(list instanceof HTMLElement)) return;
  list.textContent = "";
  if (!s.views.length) list.append(el2("div", "p-empty", "\u30D3\u30E5\u30FC\u306F\u307E\u3060\u306A\u3044"));
  for (const v of s.views) {
    const row = el2("div", "p-row");
    const main = el2("div", "p-main");
    const title = el2("div", "p-title", v.name);
    title.title = v.name;
    main.append(title);
    const sub = el2("div", "p-sub");
    sub.append(el2("span", "chip", v.query.q ? `q: ${v.query.q}` : "\u6761\u4EF6\u306A\u3057"));
    if (v.query.focus) sub.append(el2("span", "chip", "\u7D5E\u308A\u8FBC\u307F"));
    main.append(sub);
    const apply = el2("button", "link", "\u9069\u7528");
    apply.type = "button";
    apply.addEventListener("click", () => view2.h.onApplyView(v.id));
    const rm = el2("button", "ic", "\xD7");
    rm.type = "button";
    rm.title = "\u30D3\u30E5\u30FC\u3092\u524A\u9664";
    rm.addEventListener("click", () => view2.h.onDeleteView(v.id));
    row.append(main, apply, rm);
    list.append(row);
  }
}
function renderOverview(view2, s) {
  view2.overview.hidden = !s.overview;
  if (!s.overview) {
    view2.overviewSig = "";
    return;
  }
  const sig = s.overviewRows.map((r) => `${r.projectId}:${r.loop}:${r.counts.total}:${r.counts.blocked}:${r.counts.wipOver}:${r.columns.map((c) => `${c.id}=${c.count}/${c.wipLimit ?? "-"}`).join(",")}`).join("|");
  if (view2.overviewSig === sig) return;
  view2.overviewSig = sig;
  view2.overview.textContent = "";
  const head = el2("div", "ov-h");
  head.append(el2("h2", void 0, "\u7DCF\u5408\u7BA1\u7406"), el2("span", "ov-n", `${s.overviewRows.length} \u30D7\u30ED\u30B8\u30A7\u30AF\u30C8`));
  view2.overview.append(head);
  if (!s.overviewRows.length) {
    view2.overview.append(el2("div", "empty", "\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u304C\u7121\u3044"));
    return;
  }
  const rows = el2("div", "ov-rows");
  for (const row of s.overviewRows) {
    const slug = s.projects.find((p2) => p2.projectId === row.projectId)?.slug ?? row.projectId;
    const b = el2("button", "ov-row");
    b.type = "button";
    b.title = `${row.name} \u306E\u30DC\u30FC\u30C9\u3092\u958B\u304F`;
    b.append(el2("div", "ov-name", row.name));
    if (row.loop !== "idle") {
      const live = el2("span", "ov-loop", row.loop === "running" ? "\u81EA\u8D70\u4E2D" : "\u505C\u6B62");
      live.classList.add(row.loop === "running" ? "on" : "halt");
      b.append(live);
    }
    const cols = el2("div", "ov-cols");
    for (const c of row.columns) {
      const chip = el2("span", "ov-col");
      chip.append(el2("span", "ov-col-n", c.name));
      const over = c.wipLimit !== null && c.count > c.wipLimit;
      chip.append(el2("span", "ov-col-c", c.wipLimit !== null ? `${c.count}/${c.wipLimit}` : String(c.count)));
      if (over) chip.classList.add("over");
      if (c.kind === "done") chip.classList.add("done");
      cols.append(chip);
    }
    b.append(cols);
    const counts = el2("div", "ov-counts");
    const stats = [
      { label: "\u5168\u4F53", value: row.counts.total, hot: false },
      { label: "\u672A\u5B8C\u4E86", value: row.counts.open, hot: false },
      { label: "\u7740\u624B\u53EF", value: row.counts.ready, hot: false },
      { label: "\u30D6\u30ED\u30C3\u30AF", value: row.counts.blocked, hot: row.counts.blocked > 0 },
      { label: "\u671F\u9650\u5207\u308C", value: row.counts.overdue, hot: row.counts.overdue > 0 },
      { label: "WIP\u8D85", value: row.counts.wipOver, hot: row.counts.wipOver > 0 }
    ];
    for (const st of stats) {
      const cell = el2("span", "ov-c", `${st.label} ${st.value}`);
      if (st.hot) cell.classList.add("hot");
      counts.append(cell);
    }
    b.append(counts);
    b.addEventListener("click", () => view2.h.onProject(slug));
    rows.append(b);
  }
  view2.overview.append(rows);
}
var SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, cls) {
  const node = document.createElementNS(SVG_NS, tag);
  if (cls) node.setAttribute("class", cls);
  return node;
}
function renderGraph(view2, s) {
  const on = s.graph && !s.overview && Boolean(s.projectId);
  view2.graph.hidden = !on;
  if (!on) {
    view2.graphSig = "";
    return;
  }
  const layout = s.graphLayout;
  const sig = layout ? `${s.projectId}|${layout.layers}|${layout.nodes.map((n) => `${n.id}:${n.layer}:${n.closed}:${n.blocked}`).join(",")}|${layout.edges.map((e) => `${e.from}>${e.to}`).join(",")}` : `none:${s.projectId}`;
  if (view2.graphSig === sig) return;
  view2.graphSig = sig;
  view2.graph.textContent = "";
  const head = el2("div", "ov-h");
  head.append(el2("h2", void 0, "\u4F9D\u5B58\u30DE\u30C3\u30D7"), el2("span", "ov-n", layout ? `${layout.nodes.length} \u30CE\u30FC\u30C9 / ${layout.edges.length} \u4F9D\u5B58` : ""));
  view2.graph.append(head);
  if (!layout) {
    view2.graph.append(el2("div", "empty", "\u8AAD\u307F\u8FBC\u307F\u4E2D\u2026"));
    return;
  }
  if (!layout.nodes.length) {
    view2.graph.append(el2("div", "empty", "\u30AB\u30FC\u30C9\u304C\u7121\u3044"));
    return;
  }
  const NW = 190, NH = 34, GX = 70, GY = 46, PAD = 18;
  const byLayer = /* @__PURE__ */ new Map();
  for (const n of layout.nodes) {
    const list = byLayer.get(n.layer) ?? [];
    list.push(n);
    byLayer.set(n.layer, list);
  }
  const layers = Math.max(1, layout.layers, ...[...byLayer.keys()].map((k) => k + 1));
  const deepest = Math.max(...[...byLayer.values()].map((v) => v.length));
  const pos = /* @__PURE__ */ new Map();
  for (const [layer, list] of byLayer) {
    list.sort((a, b) => a.id - b.id);
    list.forEach((n, i) => pos.set(n.id, { x: PAD + layer * (NW + GX), y: PAD + i * (NH + GY) }));
  }
  const width = PAD * 2 + layers * NW + (layers - 1) * GX;
  const height = PAD * 2 + deepest * NH + Math.max(0, deepest - 1) * GY;
  const svg = svgEl("svg", "gsvg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "\u4F9D\u5B58\u30DE\u30C3\u30D7\u3002\u30CE\u30FC\u30C9\u3092\u62BC\u3059\u3068\u30AB\u30FC\u30C9\u304C\u958B\u304F");
  const defs = svgEl("defs");
  const marker = svgEl("marker");
  marker.setAttribute("id", "garrow");
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "7");
  marker.setAttribute("markerHeight", "7");
  marker.setAttribute("orient", "auto");
  const tip = svgEl("path");
  tip.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  tip.setAttribute("class", "garrow");
  marker.append(tip);
  defs.append(marker);
  svg.append(defs);
  for (const e of layout.edges) {
    const from = pos.get(e.from);
    const to = pos.get(e.to);
    if (!from || !to) continue;
    const x1 = from.x + NW, y1 = from.y + NH / 2;
    const x2 = to.x, y2 = to.y + NH / 2;
    const path = svgEl("path", "gedge");
    const bend = Math.max(24, (x2 - x1) / 2);
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute("marker-end", "url(#garrow)");
    const title = svgEl("title");
    title.textContent = `#${e.from} \u2192 #${e.to}`;
    path.append(title);
    svg.append(path);
  }
  for (const n of layout.nodes) {
    const p2 = pos.get(n.id);
    if (!p2) continue;
    const g = svgEl("g", "gnode");
    if (n.closed) g.classList.add("closed");
    if (n.blocked) g.classList.add("blocked");
    g.setAttribute("tabindex", "0");
    g.setAttribute("role", "button");
    const rect = svgEl("rect");
    rect.setAttribute("x", String(p2.x));
    rect.setAttribute("y", String(p2.y));
    rect.setAttribute("width", String(NW));
    rect.setAttribute("height", String(NH));
    rect.setAttribute("rx", "8");
    const idText = svgEl("text");
    idText.setAttribute("x", String(p2.x + 10));
    idText.setAttribute("y", String(p2.y + NH / 2 + 4));
    idText.setAttribute("class", "gid");
    idText.textContent = `#${n.id}`;
    const titleText = svgEl("text");
    titleText.setAttribute("x", String(p2.x + 48));
    titleText.setAttribute("y", String(p2.y + NH / 2 + 4));
    titleText.setAttribute("class", "gtitle");
    const short = n.title.length > 13 ? `${n.title.slice(0, 13)}\u2026` : n.title;
    titleText.textContent = short;
    const tip2 = svgEl("title");
    tip2.textContent = `#${n.id} ${n.title}`;
    g.append(rect, idText, titleText, tip2);
    g.addEventListener("click", () => view2.h.onOpenCard(n.id));
    g.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        view2.h.onOpenCard(n.id);
      }
    });
    svg.append(g);
  }
  const scroll = el2("div", "gscroll");
  scroll.append(svg);
  view2.graph.append(scroll);
  view2.graph.append(el2("div", "ov-n", "\u9589\u3058\u305F\u30AB\u30FC\u30C9\u306F\u6DE1\u304F\u3001\u30D6\u30ED\u30C3\u30AF\u4E2D\u306F\u67A0\u7DDA\u4ED8\u304D"));
}
function renderLocks(view2, s) {
  const locks = s.projectId ? s.locks : [];
  view2.locks.hidden = locks.length === 0;
  if (!locks.length) {
    view2.locksSig = "";
    return;
  }
  const sig = locks.map((l) => `${l.resource}:${l.owner}:${l.expiresAt}`).join("");
  if (view2.locksSig === sig) return;
  view2.locksSig = sig;
  view2.locksText.textContent = locks.map((l) => `\u677F${s.projectName ? `\u300C${s.projectName}\u300D` : ""}\u3092 ${l.owner} \u304C\u4FDD\u6301${l.expiresAt ? `\uFF08\u301C${l.expiresAt.slice(5, 16).replace("T", " ")}\uFF09` : ""}`).join(" \xB7 ");
}
function renderSelectionBar(view2, s) {
  const bar = view2.selbar;
  if (!bar.isConnected) view2.board.parentNode?.insertBefore(bar, view2.board);
  const keys = [...s.selection].filter((k) => s.cards[k]);
  const off = keys.length === 0 || !s.projectId || view2.board.hidden || s.focus || s.overview || s.graph || s.gantt || !view2.panelDeliv.hidden || !view2.panelHist.hidden || s.pane !== "none";
  bar.hidden = off;
  bar.textContent = "";
  if (off) return;
  const h = view2.h;
  bar.append(el2("span", "n", `${keys.length} \u4EF6\u9078\u629E`));
  for (const id of s.columnOrder) {
    const col = s.columns[id];
    const move = keys.filter((k) => s.cards[k].columnId !== id);
    const b = el2("button", void 0, `\u2192 ${col.name}`);
    b.type = "button";
    b.disabled = move.length === 0;
    b.addEventListener("click", () => {
      for (const k of move) h.onMove(k, id);
      h.onSelect([]);
    });
    bar.append(b);
  }
  const del = el2("button", "danger", "\u524A\u9664");
  del.type = "button";
  del.addEventListener("click", () => h.onDeleteMany(keys));
  const clear = el2("button", void 0, "\u89E3\u9664");
  clear.type = "button";
  clear.addEventListener("click", () => h.onSelect([]));
  bar.append(del, clear);
}
function renderView(view2, s) {
  if (document.activeElement !== view2.stale) view2.stale.value = String(s.staleDays);
  const projectSig = `${s.projects.map((p2) => `${p2.slug}:${p2.name}`).join("|")}#${s.projectId ?? ""}`;
  if (view2.projectSig !== projectSig) {
    view2.projectSig = projectSig;
    view2.select.textContent = "";
    if (!s.projects.length) {
      const o = el2("option", void 0, "(\u306A\u3057)");
      o.value = "";
      view2.select.append(o);
    }
    for (const p2 of s.projects) {
      const o = el2("option", void 0, p2.name || p2.slug);
      o.value = p2.slug;
      view2.select.append(o);
    }
    view2.select.value = s.projectId ?? "";
  }
  view2.focusBtn.classList.toggle("on", s.focus);
  view2.focusBtn.setAttribute("aria-pressed", String(s.focus));
  for (const [id, btn] of Object.entries(view2.panelBtns)) {
    btn.classList.toggle("on", s.panels[id]);
    btn.setAttribute("aria-pressed", String(s.panels[id]));
  }
  view2.panelDeliv.hidden = !s.panels.deliverables || !s.projectId;
  view2.panelHist.hidden = !s.panels.timeline || !s.projectId;
  view2.panelWrap.classList.toggle("both", !view2.panelDeliv.hidden && !view2.panelHist.hidden);
  if (view2.panelDeliv.hidden) view2.panelDelivSig = "";
  else renderDelivPanel(view2, s);
  if (view2.panelHist.hidden) view2.panelHistSig = "";
  else renderHistPanel(view2, s);
  view2.root.style.setProperty("--top-h", `${view2.top.offsetHeight}px`);
  view2.status.textContent = [
    `build ${s.buildHash ?? "\u2013"}`,
    s.version ? `v${s.version}` : null,
    `project ${s.projectId ?? "\u2013"}`,
    s.generation ? `gen ${s.generation.slice(0, 12)}` : null,
    s.loading ? "\u2026" : null
  ].filter(Boolean).join(" \xB7 ");
  view2.errBar.hidden = !s.error;
  if (s.error) view2.errBar.textContent = s.error;
  const colEls = [];
  for (const id of s.columnOrder) {
    let cv = view2.cols.get(id);
    if (!cv) {
      cv = makeColumn(id, view2.h);
      view2.cols.set(id, cv);
    }
    const col = s.columns[id];
    cv.name.textContent = col.name;
    cv.el.dataset.wip = col.wipLimit === null ? "" : String(col.wipLimit);
    const n = cardsInColumn(s, id).length;
    cv.count.textContent = col.wipLimit !== null ? `${n}/${col.wipLimit}` : String(n);
    const over = col.wipLimit !== null && n > col.wipLimit;
    const at = col.wipLimit !== null && n >= col.wipLimit;
    cv.el.classList.toggle("over-wip", over);
    cv.el.classList.toggle("at-wip", at && !over);
    cv.count.title = at ? over ? `WIP\u4E0A\u9650\u8D85\u904E (${col.wipLimit})` : `WIP\u6E80\u676F (${col.wipLimit}) \u2014 \u3053\u308C\u4EE5\u4E0A\u5165\u308C\u3089\u308C\u306A\u3044` : "";
    colEls.push(cv.el);
  }
  const staleCols = [];
  for (const id of view2.cols.keys()) if (!s.columnOrder.includes(id)) staleCols.push(id);
  for (const id of staleCols) {
    view2.cols.get(id)?.el.remove();
    view2.cols.delete(id);
  }
  keyedDiff(view2.board, colEls);
  for (const id of s.columnOrder) {
    const cv = view2.cols.get(id);
    if (!cv) continue;
    const els = [];
    const visible = cardsInColumn(s, id).filter((card) => !(s.qFocus && s.q.trim() && !cardMatches(card, s.q)));
    const foldable = isDoneColumn(s, id);
    const shown = foldable && !s.doneOpen ? visible.slice(0, DONE_PREVIEW) : visible;
    for (const card of shown) {
      const key = cardKey(card.projectId, card.id);
      let node = view2.cards.get(key);
      if (!node) {
        node = makeCardNode(key, view2.h);
        view2.cards.set(key, node);
      }
      updateCard(node, card, s, view2.h);
      node.classList.toggle("msel", s.selection.has(key));
      node.oncontextmenu = (ev) => {
        ev.preventDefault();
        openCardMenu(view2, s, key, ev.clientX, ev.clientY);
      };
      els.push(node);
    }
    keyedDiff(cv.list, els);
    cv.more.hidden = !foldable || visible.length <= DONE_PREVIEW;
    cv.more.textContent = s.doneOpen ? "\u7573\u3080" : `\u6B8B\u308A ${visible.length - DONE_PREVIEW} \u4EF6\u3092\u8868\u793A`;
    cv.more.setAttribute("aria-pressed", String(s.doneOpen));
  }
  const isEmpty = !s.projectId || s.columnOrder.length === 0;
  view2.empty.hidden = !isEmpty;
  if (isEmpty) {
    view2.empty.textContent = emptyText(s);
    view2.board.hidden = true;
    view2.focus.hidden = true;
  } else {
    view2.board.hidden = s.focus;
  }
  renderNotifBadges(view2, s);
  renderLoop(view2, s);
  renderLocks(view2, s);
  renderSearch(view2, s);
  renderOverview(view2, s);
  renderGraph(view2, s);
  const ganttOn = s.gantt && !s.overview && !s.graph && Boolean(s.projectId);
  view2.gantt.hidden = !ganttOn;
  if (ganttOn) {
    renderGantt(view2.gantt, Object.values(s.cards), {
      projectId: s.projectId,
      scale: s.ganttScale,
      now: Date.now(),
      columns: s.columns,
      onScale: (scale) => view2.h.onGanttScale(scale),
      onOpen: (card) => view2.h.onOpen(cardKey(card.projectId, card.id))
    });
  }
  view2.paneTemplates.hidden = s.pane !== "templates" || !s.projectId;
  view2.paneViews.hidden = s.pane !== "views" || !s.projectId;
  view2.paneNotif.hidden = s.pane !== "notifications" || !s.projectId;
  renderNotifications(view2, s);
  renderTemplates(view2, s);
  renderViews(view2, s);
  renderFocus(view2, s);
  if (s.focus || s.graph || s.overview || s.gantt) view2.board.hidden = true;
  if (s.graph || s.overview || s.gantt) view2.focus.hidden = true;
  renderSelectionBar(view2, s);
  const toggle = (b, on) => {
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  };
  toggle(view2.overviewBtn, s.overview);
  toggle(view2.graphBtn, s.graph && !s.overview);
  toggle(view2.ganttBtn, s.gantt && !s.overview && !s.graph);
  toggle(view2.searchAllBtn, s.searchAll);
  toggle(view2.viewsBtn, s.pane === "views");
  toggle(view2.templatesBtn, s.pane === "templates");
  toggle(view2.notifBtn, s.pane === "notifications");
  if (view2.q.value !== s.q) view2.q.value = s.q;
  const levels = { danger: 0, warn: 0, info: 0 };
  for (const n of s.notifications) levels[n.level] += 1;
  for (const level of LEVELS) {
    const node = view2.notifCounts[level];
    node.textContent = levels[level] ? String(levels[level]) : "";
    node.hidden = levels[level] === 0;
  }
  view2.notifBtn.title = s.notifications.length ? `\u901A\u77E5 ${s.notifications.length} \u4EF6\uFF08\u5371\u967A ${levels.danger} / \u8B66\u544A ${levels.warn} / \u60C5\u5831 ${levels.info}\uFF09` : "\u901A\u77E5\u306F\u306A\u3044";
}

// web/src/keys.ts
function isTyping(target) {
  const n = target;
  if (!n || typeof n.tagName !== "string") return false;
  const tag = n.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || n.isContentEditable === true;
}
function stepKey(keys, selected, delta) {
  if (!keys.length) return null;
  const cursor = selected.at(-1);
  const at = cursor === void 0 ? -1 : keys.indexOf(cursor);
  return keys[Math.max(0, Math.min(keys.length - 1, at + delta))] ?? null;
}
function rowKeys() {
  const out = [];
  for (const n of document.querySelectorAll(".card[data-key], .focus-row[data-key]")) {
    if (!n.closest("[hidden]")) out.push(n.dataset.key);
  }
  return out;
}
function pick(actions, key) {
  actions.onSelect([key]);
  document.querySelector(`.card[data-key="${key}"], .focus-row[data-key="${key}"]`)?.scrollIntoView({ block: "nearest" });
}
function installKeys(actions) {
  document.addEventListener("keydown", (ev) => {
    if (ev.repeat) return;
    if (ev.defaultPrevented) return;
    const typing = isTyping(ev.target);
    if (ev.key === "Escape") {
      if (typing) {
        ev.target.blur();
        return;
      }
      if (document.querySelector("dialog[open]")) return;
      if (!actions.selected().length) return;
      ev.preventDefault();
      actions.onSelect([]);
      return;
    }
    if (typing) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key >= "1" && ev.key <= "9") {
      const sel = document.querySelector(".pick select");
      const opt = sel?.options[Number(ev.key) - 1];
      if (!sel || !opt || !opt.value) return;
      ev.preventDefault();
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change"));
      return;
    }
    switch (ev.key) {
      case "j":
      case "k": {
        const next = stepKey(rowKeys(), actions.selected(), ev.key === "j" ? 1 : -1);
        if (!next) return;
        ev.preventDefault();
        pick(actions, next);
        return;
      }
      case "Enter": {
        const key = actions.selected().at(-1);
        if (key === void 0) return;
        ev.preventDefault();
        actions.onOpen(key);
        return;
      }
      case "d": {
        const key = actions.doingFirst();
        if (!key) return;
        ev.preventDefault();
        pick(actions, key);
        return;
      }
      case "/": {
        const q = document.querySelector("input.q");
        if (!q) return;
        ev.preventDefault();
        q.focus();
        return;
      }
      case "c": {
        const input = document.querySelector('.board .col[data-col="todo"] .addrow input') ?? document.querySelector(".board .col .addrow input");
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

// web/src/viewer.ts
var IMAGE = /\.(png|jpe?g|gif|webp)$/i;
var VIDEO = /\.(mp4|webm|mov)$/i;
var DOC = /\.(md|markdown|txt|csv|json|log|ya?ml)$/i;
function kindOf(name, mime) {
  const m = (mime ?? "").split(";")[0]?.trim() ?? "";
  if (m.startsWith("image/") || IMAGE.test(name)) return "image";
  if (m.startsWith("video/") || VIDEO.test(name)) return "video";
  if (m === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (m === "text/html" || /\.html?$/i.test(name)) return "html";
  if (m.startsWith("text/") || m === "application/json" || DOC.test(name)) return "markdown";
  return "other";
}
function deliverableItems(list) {
  return list.map((d) => ({
    title: d.title,
    name: d.ref.split(/[\\/]/).pop() || d.ref,
    fileSrc: deliverableFileSrc(d.projectId, d.id),
    viewSrc: deliverableViewSrc(d.projectId, d.id)
  }));
}
function attachmentItems(projectId, list) {
  return list.map((a) => ({
    title: a.name,
    name: a.name,
    mime: a.mime,
    fileSrc: attachmentSrc(projectId, a.id),
    viewSrc: attachmentViewSrc(projectId, a.id)
  }));
}
function el3(tag, cls) {
  const n = document.createElement(tag);
  n.className = cls;
  return n;
}
function mountViewer(root2) {
  const dlg = el3("dialog", "viewer");
  dlg.tabIndex = -1;
  const head = el3("div", "v-h");
  const cap = el3("span", "v-cap");
  const count = el3("span", "v-count");
  const closeBtn = el3("button", "ic");
  closeBtn.type = "button";
  closeBtn.textContent = "\xD7";
  closeBtn.title = "\u9589\u3058\u308B";
  head.append(cap, count, closeBtn);
  const body = el3("div", "v-body");
  dlg.append(head, body);
  root2.append(dlg);
  let list = [];
  let at = 0;
  function box(item) {
    const kind = kindOf(item.name, item.mime);
    if (kind === "image") {
      const img = el3("img", "v-img");
      img.src = item.fileSrc;
      img.alt = item.title;
      return img;
    }
    if (kind === "video") {
      const vid = el3("video", "v-media");
      vid.controls = true;
      vid.autoplay = true;
      vid.src = item.fileSrc;
      return vid;
    }
    if (kind === "other") {
      const a = el3("a", "v-dl");
      a.href = item.fileSrc;
      a.download = item.name;
      a.textContent = `${item.name} \u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9`;
      return a;
    }
    const fr = el3("iframe", "v-frame");
    fr.src = item.viewSrc;
    if (kind === "html") fr.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
    if (kind === "markdown") fr.setAttribute("sandbox", "");
    return fr;
  }
  function show(i) {
    if (!list.length) return;
    at = (i + list.length) % list.length;
    const item = list[at];
    body.replaceChildren(box(item));
    cap.textContent = item.title;
    cap.title = item.title;
    count.textContent = list.length > 1 ? `${at + 1} / ${list.length}` : "";
    count.hidden = list.length <= 1;
  }
  function reset() {
    list = [];
    body.replaceChildren();
    cap.textContent = "";
    count.textContent = "";
  }
  function close() {
    reset();
    if (dlg.open) dlg.close();
  }
  function open(items, index) {
    if (!items.length) return;
    list = items;
    show(index);
    if (!dlg.open) dlg.showModal();
    dlg.focus();
  }
  closeBtn.addEventListener("click", close);
  dlg.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    close();
  });
  dlg.addEventListener("close", reset);
  dlg.addEventListener("click", (ev) => {
    if (ev.target === dlg) close();
  });
  dlg.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      show(at - 1);
      return;
    }
    if (ev.key === "ArrowRight") {
      ev.preventDefault();
      show(at + 1);
      return;
    }
    ev.stopPropagation();
  });
  return { open, close };
}

// web/src/detail.ts
var ATTACH_ACCEPT = "image/*,application/pdf,video/*,audio/*,.md,.txt,.csv,.json,.log,.yaml,.yml,.zip";
function el4(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== void 0) n.textContent = text;
  return n;
}
function field(label, input) {
  const wrap = el4("label", "f");
  wrap.append(el4("span", "f-l", label), input);
  return wrap;
}
var SESSION_LIST_ID = "kb-session-names";
function sessionLabel(card, list) {
  const id = card?.sessionId ?? null;
  if (!id) return "";
  const hit = list.find((s) => s.id === id);
  return hit ? hit.name : id.slice(0, 8);
}
function sessionIdOfInput(value, card, list, unknown) {
  const wanted = value.trim();
  if (wanted === "") return null;
  const hit = list.find((s) => s.name === wanted);
  if (hit) return hit.id;
  if (wanted === sessionLabel(card, list)) return card?.sessionId ?? null;
  unknown();
  return null;
}
function mountDetail(root2, h) {
  let key = null;
  let snapshot = null;
  let sessions = [];
  const dlg = el4("dialog", "detail");
  const head = el4("div", "d-h");
  const heading = el4("h2", "d-title");
  const actorLine = el4("div", "d-actor");
  actorLine.hidden = true;
  const closeBtn = el4("button", "ic", "\xD7");
  closeBtn.type = "button";
  closeBtn.title = "\u9589\u3058\u308B";
  head.append(heading, actorLine, closeBtn);
  const title = el4("input", "f-title");
  title.placeholder = "\u30BF\u30A4\u30C8\u30EB";
  title.required = true;
  const prio = el4("input", "f-prio");
  prio.type = "number";
  prio.step = "1";
  const owner = el4("input", "f-owner");
  owner.placeholder = "\u672A\u5272\u5F53";
  const due = el4("input", "f-due");
  due.type = "date";
  const blocked = el4("input", "f-blocked");
  blocked.placeholder = "\u7406\u7531\u304C\u3042\u308C\u3070\u5165\u529B\uFF08\u7A7A\u3067\u89E3\u9664\uFF09";
  const body = el4("textarea", "f-body");
  body.rows = 7;
  body.placeholder = "\u30E1\u30E2\u30FB\u53D7\u3051\u5165\u308C\u6761\u4EF6\uFF08- [ ] \u9805\u76EE\uFF09";
  const accHint = el4("div", "acc-hint");
  const sessionPick = el4("input", "f-session");
  sessionPick.placeholder = "\u7A7A\u306A\u3089\u65B0\u898F\u30BB\u30C3\u30B7\u30E7\u30F3";
  sessionPick.setAttribute("list", SESSION_LIST_ID);
  const sessionOpts = el4("datalist");
  sessionOpts.id = SESSION_LIST_ID;
  const grid = el4("div", "d-grid");
  grid.append(
    field("\u30BF\u30A4\u30C8\u30EB", title),
    field("\u512A\u5148\u5EA6", prio),
    field("\u62C5\u5F53", owner),
    field("\u671F\u9650", due),
    field("\u30D6\u30ED\u30C3\u30AF\u7406\u7531", blocked),
    field("\u30BB\u30C3\u30B7\u30E7\u30F3", sessionPick),
    field("\u672C\u6587", body)
  );
  grid.append(accHint, sessionOpts);
  const depSec = el4("section", "d-sec");
  depSec.append(el4("h3", void 0, "\u4F9D\u5B58\u95A2\u4FC2"));
  const depList = el4("div", "d-deps");
  const depForm = el4("form", "d-depadd");
  const depTarget = el4("select");
  depTarget.setAttribute("aria-label", "dependency target");
  const depType = el4("select");
  for (const [v, t] of [["blocks", "\u30D6\u30ED\u30C3\u30AF\u3059\u308B"], ["relates", "\u95A2\u9023"]]) {
    const o = el4("option", void 0, t);
    o.value = v;
    depType.append(o);
  }
  const depAdd = el4("button", void 0, "\u8FFD\u52A0");
  depAdd.type = "submit";
  depForm.append(el4("span", "f-l", "\u5BFE\u8C61"), depTarget, depType, depAdd);
  depForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!key) return;
    const to = Number(depTarget.value);
    if (!Number.isFinite(to) || to <= 0) return;
    void h.onAddDep(key, to, depType.value).then((ok) => {
      if (ok) h.notify("\u4F9D\u5B58\u3092\u8FFD\u52A0\u3057\u305F");
    });
  });
  depSec.append(depList, depForm);
  const dvSec = el4("section", "d-sec");
  dvSec.append(el4("h3", void 0, "\u6210\u679C\u7269"));
  const dvList = el4("div", "d-dvs");
  const dvForm = el4("form", "d-dvadd");
  const dvTitle = el4("input");
  dvTitle.placeholder = "\u3053\u306E\u30AB\u30FC\u30C9\u306B\u7D10\u3065\u304F\u6210\u679C\u7269";
  dvTitle.setAttribute("aria-label", "add deliverable for card");
  const dvAdd = el4("button", void 0, "\u8FFD\u52A0");
  dvAdd.type = "submit";
  dvForm.append(dvTitle, dvAdd);
  dvForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!key) return;
    const t = dvTitle.value.trim();
    if (!t) return;
    const id = parseKey(key).id;
    void h.onAddDeliverable(t, id).then((ok) => {
      if (ok) dvTitle.value = "";
    });
  });
  dvSec.append(dvList, dvForm);
  const tlSec = el4("section", "d-sec");
  tlSec.append(el4("h3", void 0, "\u3053\u306E\u30AB\u30FC\u30C9\u306E\u5C65\u6B74"));
  const tlList = el4("div", "d-tl");
  const atSec = el4("section", "d-sec");
  atSec.append(el4("h3", void 0, "\u6DFB\u4ED8\u30D5\u30A1\u30A4\u30EB"));
  const atList = el4("div", "d-atts");
  const atPick = el4("input", "d-file");
  atPick.type = "file";
  atPick.accept = ATTACH_ACCEPT;
  atPick.setAttribute("aria-label", "\u30D5\u30A1\u30A4\u30EB\u3092\u6DFB\u4ED8");
  atPick.addEventListener("change", () => {
    const file = atPick.files?.[0];
    if (!file || !key) return;
    const k = key;
    void h.onUploadAttachment(k, file).then((ok) => {
      atPick.value = "";
      if (ok) h.notify("\u30D5\u30A1\u30A4\u30EB\u3092\u6DFB\u4ED8\u3057\u305F");
    });
  });
  atSec.append(atList, atPick);
  const foot = el4("div", "d-foot");
  const moveSel = el4("select");
  moveSel.setAttribute("aria-label", "move to column");
  const delBtn = el4("button", "danger", "\u524A\u9664");
  delBtn.type = "button";
  const tplBtn = el4("button", "ghost", "\u30C6\u30F3\u30D7\u30EC\u30FC\u30C8\u5316");
  tplBtn.type = "button";
  tplBtn.title = "\u3053\u306E\u30AB\u30FC\u30C9\u306E\u5185\u5BB9\u3092\u96DB\u5F62\u3068\u3057\u3066\u4FDD\u5B58";
  tplBtn.addEventListener("click", () => {
    if (key) h.onTemplateFromCard(key);
  });
  const cancelBtn = el4("button", "ghost", "\u9589\u3058\u308B");
  cancelBtn.type = "button";
  const saveBtn = el4("button", "primary", "\u4FDD\u5B58");
  saveBtn.type = "button";
  foot.append(el4("div", "grow"), tplBtn, moveSel, delBtn, cancelBtn, saveBtn);
  dlg.append(head, grid, depSec, dvSec, atSec, tlSec, foot);
  root2.append(dlg);
  const viewer = mountViewer(root2);
  const openStrip = (projectId, list) => {
    const images = list.filter((a) => a.mime.startsWith("image/"));
    const items = attachmentItems(projectId, images);
    return (a) => viewer.open(items, images.findIndex((x) => x.id === a.id));
  };
  const close = () => {
    key = null;
    snapshot = null;
    if (dlg.open) dlg.close();
  };
  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  dlg.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    close();
  });
  saveBtn.addEventListener("click", () => {
    if (!key) return;
    const t = title.value.trim();
    if (!t) {
      h.notify("\u30BF\u30A4\u30C8\u30EB\u306F\u7A7A\u306B\u3067\u304D\u306A\u3044");
      title.focus();
      return;
    }
    const p2 = Number(prio.value);
    const patch = {
      title: t,
      priority: Number.isFinite(p2) ? Math.trunc(p2) : 0,
      owner: owner.value.trim() || null,
      due: due.value.trim() || null,
      blockedReason: blocked.value.trim() || null,
      sessionId: sessionIdOfInput(
        sessionPick.value,
        currentCard(key),
        sessions,
        () => h.notify("\u305D\u306E\u540D\u524D\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u306F\u7121\u3044\u3002\u65B0\u898F\u30BB\u30C3\u30B7\u30E7\u30F3\u3068\u3057\u3066\u8D77\u52D5\u3059\u308B")
      ),
      body: body.value
    };
    void h.onSave(key, patch).then((ok) => {
      if (ok) {
        h.notify("\u4FDD\u5B58\u3057\u305F");
        close();
      }
    });
  });
  delBtn.addEventListener("click", () => {
    const k = key;
    if (!k) return;
    if (!window.confirm("\u3053\u306E\u30AB\u30FC\u30C9\u3092\u524A\u9664\u3059\u308B\uFF1F")) return;
    h.onDelete(k);
    close();
  });
  moveSel.addEventListener("change", () => {
    if (!key || !moveSel.value) return;
    h.onMove(key, moveSel.value);
    moveSel.value = "";
  });
  const open = (k) => {
    const parsed = parseKey(k);
    const card = currentCard(k);
    if (!card) {
      h.notify(`\u30AB\u30FC\u30C9 #${parsed.id} \u304C\u898B\u3064\u304B\u3089\u306A\u3044`);
      return;
    }
    key = k;
    snapshot = card;
    heading.textContent = `#${card.id} ${card.title}`;
    title.value = card.title;
    prio.value = String(card.priority);
    owner.value = card.owner ?? "";
    due.value = card.due ?? "";
    blocked.value = card.blockedReason ?? "";
    body.value = card.body ?? "";
    sessionPick.value = sessionLabel(card, sessions);
    sessions = [];
    const openedAs = k;
    void h.onSessions(parsed.projectId).then((list) => {
      sessions = list;
      sessionOpts.replaceChildren(...list.map((s) => {
        const o = el4("option");
        o.value = s.name;
        return o;
      }));
      if (key === openedAs) sessionPick.value = sessionLabel(currentCard(openedAs), list);
    }).catch(() => {
    });
    if (store2) paint(store2, card);
    if (!dlg.open) dlg.showModal();
    title.focus();
  };
  let store2 = null;
  function currentCard(k) {
    return store2?.cards[k] ?? snapshot;
  }
  function renderDeps(s, card) {
    const edges = edgesOf(s, card.id);
    depList.textContent = "";
    if (!edges.length) depList.append(el4("div", "d-empty", "\u4F9D\u5B58\u306A\u3057"));
    for (const e of edges) {
      const outgoing = e.fromCard === card.id;
      const otherId = outgoing ? e.toCard : e.fromCard;
      const other = s.cards[cardKey(s.projectId, otherId)];
      const row = el4("div", "d-dep");
      const label = e.type === "blocks" ? outgoing ? "\u30D6\u30ED\u30C3\u30AF\u3059\u308B" : "\u30D6\u30ED\u30C3\u30AF\u3055\u308C\u3066\u3044\u308B" : "\u95A2\u9023";
      row.append(el4("span", `chip kind${e.type === "relates" ? " rel" : ""}`, label));
      const name = el4("span", "d-dep-name", other ? `#${other.id} ${other.title}` : `#${otherId}\uFF08\u4E0D\u5728\uFF09`);
      name.title = name.textContent;
      row.append(name);
      if (e.type === "blocks" && !outgoing && other && !isClosed(other)) row.append(el4("span", "chip warn", "\u672A\u5B8C\u4E86"));
      const rm = el4("button", "ic", "\xD7");
      rm.type = "button";
      rm.title = "\u4F9D\u5B58\u3092\u89E3\u9664";
      rm.addEventListener("click", () => {
        void h.onRemoveDep(e.projectId, e.fromCard, e.toCard, e.type).then((ok) => {
          if (ok) h.notify("\u4F9D\u5B58\u3092\u89E3\u9664\u3057\u305F");
        });
      });
      row.append(rm);
      depList.append(row);
    }
  }
  function renderDepsPicker(s, card) {
    const prev = depTarget.value;
    depTarget.textContent = "";
    for (const id of s.columnOrder) {
      for (const c of Object.values(s.cards)) {
        if (c.columnId !== id || c.projectId !== s.projectId || c.id === card.id) continue;
        const o = el4("option", void 0, `#${c.id} ${c.title}`);
        o.value = String(c.id);
        depTarget.append(o);
      }
    }
    if (prev && depTarget.querySelector(`option[value="${prev}"]`)) depTarget.value = prev;
  }
  const docLabel2 = (mime) => {
    if (mime === "application/pdf") return "PDF";
    if (mime.startsWith("video/")) return "\u52D5\u753B";
    if (mime.startsWith("audio/")) return "\u97F3\u58F0";
    if (mime.includes("zip")) return "ZIP";
    return "\u6587\u66F8";
  };
  function thumb(a, projectId, onRemove, onOpen) {
    const wrap = el4("span", "thumb-w");
    if (a.mime.startsWith("image/")) {
      const img = el4("img", "thumb");
      img.src = attachmentSrc(projectId, a.id);
      img.alt = a.name;
      img.title = a.name;
      if (onOpen) img.addEventListener("click", onOpen);
      wrap.append(img);
    } else {
      const link = el4("a", "thumb doc");
      link.href = attachmentViewSrc(projectId, a.id);
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = docLabel2(a.mime);
      link.title = `${a.name}\uFF08${Math.max(1, Math.round(a.size / 1024))} KB\uFF09`;
      wrap.append(link);
    }
    if (onRemove) {
      const rm = el4("button", "ic thumb-x", "\xD7");
      rm.type = "button";
      rm.title = `${a.name} \u3092\u5916\u3059`;
      rm.addEventListener("click", () => {
        wrap.classList.add("gone");
        void onRemove().then((ok) => {
          if (!ok) wrap.classList.remove("gone");
        });
      });
      wrap.append(rm);
    }
    return wrap;
  }
  const sigs = { att: "", dv: "", tl: "" };
  function renderAttachments(s, card) {
    const mine = s.attachments.filter((a) => a.cardId === card.id);
    const sig = `${card.id}|${mine.map((a) => `${a.id}:${a.name}`).join(",")}`;
    if (sigs.att === sig) return;
    sigs.att = sig;
    atList.textContent = "";
    if (!mine.length) atList.append(el4("div", "d-empty", "\u6DFB\u4ED8\u306A\u3057"));
    const openAtt = openStrip(card.projectId, mine);
    for (const a of mine) {
      atList.append(thumb(a, card.projectId, () => h.onDeleteAttachment(card.projectId, a.id).then((ok) => {
        if (ok) h.notify("\u6DFB\u4ED8\u3092\u5916\u3057\u305F");
        return ok;
      }), () => openAtt(a)));
    }
  }
  function renderDeliverables(s, card) {
    const mine = s.deliverables.filter((d) => d.cardId === card.id);
    const sig = `${card.id}|${mine.map((d) => `${d.id}:${d.title}:${d.ref ?? ""}`).join(",")}|${s.attachments.filter((a) => a.deliverableId !== null).map((a) => `${a.id}:${a.deliverableId}`).join(",")}`;
    if (sigs.dv === sig) return;
    sigs.dv = sig;
    dvList.textContent = "";
    if (!mine.length) dvList.append(el4("div", "d-empty", "\u7D10\u3065\u304F\u6210\u679C\u7269\u306A\u3057"));
    const viewable = mine.filter((d) => d.ref);
    const items = deliverableItems(viewable);
    for (const d of mine) {
      const row = el4("div", "d-dv");
      const t = el4("span", "d-dv-title", d.title);
      t.title = d.title;
      row.append(el4("span", "chip kind", d.kind), t);
      if (d.ref) {
        const btn = el4("button", "chip v-open", d.ref.split(/[\\/]/).pop() || d.ref);
        btn.type = "button";
        btn.title = d.ref;
        btn.addEventListener("click", () => viewer.open(items, viewable.indexOf(d)));
        row.append(btn);
      }
      const rm = el4("button", "ic", "\xD7");
      rm.type = "button";
      rm.title = "\u6210\u679C\u7269\u3092\u524A\u9664";
      rm.addEventListener("click", () => {
        void h.onDeleteDeliverable(d.projectId, d.id);
      });
      row.append(rm);
      dvList.append(row);
      const atts = s.attachments.filter((a) => a.deliverableId === d.id);
      const strip = el4("div", "d-dv-atts");
      const openAtt = openStrip(d.projectId, atts);
      for (const a of atts) {
        strip.append(thumb(a, d.projectId, () => h.onDeleteAttachment(d.projectId, a.id).then((ok) => {
          if (ok) h.notify("\u6DFB\u4ED8\u3092\u5916\u3057\u305F");
          return ok;
        }), () => openAtt(a)));
      }
      const pick2 = el4("input", "d-file sm");
      pick2.type = "file";
      pick2.accept = ATTACH_ACCEPT;
      pick2.setAttribute("aria-label", `${d.title} \u306B\u30D5\u30A1\u30A4\u30EB\u3092\u6DFB\u4ED8`);
      pick2.addEventListener("change", () => {
        const f = pick2.files?.[0];
        if (!f) return;
        void h.onUploadDeliverableAttachment(d.id, f).then((ok) => {
          pick2.value = "";
          if (ok) h.notify("\u30D5\u30A1\u30A4\u30EB\u3092\u6DFB\u4ED8\u3057\u305F");
        });
      });
      strip.append(pick2);
      dvList.append(strip);
    }
  }
  function renderTimeline(s, card) {
    const mine = s.timeline.filter((e) => e.entityType === "card" && e.entityId === keyOf(card));
    const shown = mine.slice(-10);
    const sig = shown.map((e) => `${e.at}:${e.kind}:${e.actor ?? ""}`).join(",");
    if (sigs.tl === sig) return;
    sigs.tl = sig;
    tlList.textContent = "";
    if (!mine.length) tlList.append(el4("div", "d-empty", "\u5C65\u6B74\u306A\u3057"));
    for (const e of shown.slice().reverse()) {
      const row = el4("div", "d-tl-row");
      row.append(el4("span", "tl-at", e.at.slice(5, 16).replace("T", " ")), el4("span", "tl-kind", e.kind));
      if (e.actor) row.append(el4("span", "tl-actor", e.actor));
      tlList.append(row);
    }
  }
  return {
    get openKey() {
      return key;
    },
    open,
    close,
    render(s, projects) {
      store2 = s;
      if (!key) return;
      const card = s.cards[key];
      if (!card) {
        close();
        return;
      }
      if (snapshot && snapshot.version !== card.version) {
        const dirty = title.value !== snapshot.title || body.value !== (snapshot.body ?? "") || prio.value !== String(snapshot.priority) || owner.value !== (snapshot.owner ?? "") || due.value !== (snapshot.due ?? "") || blocked.value !== (snapshot.blockedReason ?? "");
        if (!dirty) {
          title.value = card.title;
          prio.value = String(card.priority);
          owner.value = card.owner ?? "";
          due.value = card.due ?? "";
          blocked.value = card.blockedReason ?? "";
          body.value = card.body ?? "";
        }
        snapshot = card;
        heading.textContent = `#${card.id} ${card.title}`;
      }
      paint(s, card);
      void projects;
    }
  };
  function paint(s, card) {
    const actor = lastActorOf(card);
    actorLine.hidden = actor === null;
    actorLine.textContent = actor === null ? "" : `\u6700\u7D42\u66F4\u65B0\u8005: ${actor}`;
    const progress = acceptanceProgress(body.value);
    accHint.textContent = progress.total ? `\u53D7\u3051\u5165\u308C\u6761\u4EF6: ${progress.done}/${progress.total}${progress.done === progress.total ? " \u2713" : ""}` : "\u53D7\u3051\u5165\u308C\u6761\u4EF6: \u306A\u3057\uFF08- [ ] \u3067\u8FFD\u52A0\u3067\u304D\u308B\uFF09";
    renderDeps(s, card);
    renderDepsPicker(s, card);
    renderDeliverables(s, card);
    renderAttachments(s, card);
    renderTimeline(s, card);
    const prev = moveSel.value;
    moveSel.textContent = "";
    const ph = el4("option", void 0, "\u2192 \u79FB\u52D5\u5148");
    ph.value = "";
    moveSel.append(ph);
    for (const id of s.columnOrder) {
      if (id === card.columnId) continue;
      const o = el4("option", void 0, s.columns[id]?.name ?? id);
      o.value = id;
      moveSel.append(o);
    }
    moveSel.value = prev && moveSel.querySelector(`option[value="${prev}"]`) ? prev : "";
  }
}

// web/src/app.ts
var PROJECT_KEY = "kb.v2.project";
var UI_KEY = "kb.v2.ui";
var POLL_MS = 5e3;
var store = createStore();
var savedUi = readSavedUi();
store.panels.deliverables = savedUi.deliverables;
store.panels.timeline = savedUi.timeline;
store.doneOpen = savedUi.doneOpen;
store.staleDays = savedUi.staleDays;
store.delSort = savedUi.delSort;
var root = document.getElementById("app");
if (!root) throw new Error("#app not found");
root.textContent = "";
function describe(e) {
  if (e instanceof ApiError) {
    const code = e.status ? `${e.code} ${e.status}` : e.code;
    return `${e.message} [${code}]`;
  }
  return e instanceof Error ? e.message : String(e);
}
function readSavedProject() {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}
function saveProject(slug) {
  try {
    if (slug) localStorage.setItem(PROJECT_KEY, slug);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {
  }
}
function readSavedUi() {
  const none = { deliverables: false, timeline: false, doneOpen: false, staleDays: STALE_DAYS_DEFAULT, delSort: "new" };
  try {
    const raw = JSON.parse(localStorage.getItem(UI_KEY) ?? "{}");
    if (!raw || typeof raw !== "object") return none;
    const o = raw;
    return {
      deliverables: o.deliverables === true,
      timeline: o.timeline === true,
      doneOpen: o.doneOpen === true,
      staleDays: typeof o.staleDays === "number" ? clampStale(o.staleDays) : STALE_DAYS_DEFAULT,
      // An unknown or missing value means the default, not the last of whatever was written.
      delSort: o.delSort === "old" ? "old" : "new"
    };
  } catch {
    return none;
  }
}
function saveUi(s) {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({
      deliverables: s.panels.deliverables,
      timeline: s.panels.timeline,
      doneOpen: s.doneOpen,
      staleDays: s.staleDays,
      delSort: s.delSort
    }));
  } catch {
  }
}
function clampStale(days) {
  return Number.isFinite(days) ? Math.min(365, Math.max(0, Math.round(days))) : STALE_DAYS_DEFAULT;
}
var boardSeq = 0;
var UNDO_MS = 6e3;
var pendingDeletes = /* @__PURE__ */ new Map();
function scheduleDelete(key, card, delay) {
  const prev = pendingDeletes.get(key);
  if (prev) clearTimeout(prev.timer);
  vanishCard(store, key);
  pendingDeletes.set(key, { card, timer: setTimeout(() => void commitDelete(key), delay) });
}
var boardReload;
function loadBoardSoon() {
  if (boardReload) clearTimeout(boardReload);
  boardReload = setTimeout(() => {
    boardReload = void 0;
    void loadBoard();
  }, 50);
}
function undoDelete(key) {
  const entry = pendingDeletes.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingDeletes.delete(key);
  revealCard(store, key);
  if (!upsertCard(store, entry.card)) {
    const name = store.projects.find((p2) => p2.slug === entry.card.projectId)?.name ?? entry.card.projectId;
    showToast(view, `#${entry.card.id} \u306F\u300C${name}\u300D\u306B\u5207\u308A\u66FF\u308F\u3063\u3066\u3044\u305F\u306E\u3067\u623B\u305B\u306A\u304B\u3063\u305F`);
    return;
  }
  showToast(view, `#${entry.card.id} \u306E\u524A\u9664\u3092\u53D6\u308A\u6D88\u3057\u305F`);
  render();
  void loadBoard();
}
async function commitDelete(key) {
  const entry = pendingDeletes.get(key);
  if (!entry) return;
  pendingDeletes.delete(key);
  try {
    await deleteCard(entry.card.projectId, entry.card.id, { version: entry.card.version });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) {
      revealCard(store, key);
      upsertCard(store, entry.card);
      render();
      showToast(view, `#${entry.card.id} \u3092\u524A\u9664\u3067\u304D\u306A\u304B\u3063\u305F: ${describe(e)}`, void 0, true);
    }
  } finally {
    revealCard(store, key);
  }
  loadBoardSoon();
}
async function loadMeta() {
  try {
    setMeta(store, await getMeta());
  } catch (e) {
    store.error = `meta: ${describe(e)}`;
  }
  render();
}
async function loadBoard() {
  const project = store.projectId;
  if (!project) return;
  const seq = ++boardSeq;
  store.loading = true;
  render();
  try {
    const [snap, del, tl] = await Promise.all([
      getBoard(project),
      getDeliverables(project).catch(() => null),
      getTimeline(project).catch(() => null)
    ]);
    if (seq !== boardSeq || store.projectId !== project) return;
    if (!applySnapshot(store, project, snap)) {
      store.error = `\u30DC\u30FC\u30C9\u306E\u5FDC\u7B54\u304C\u5225\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u3067\u3057\u305F (${snap?.project?.slug ?? "?"})`;
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
    if (seq === boardSeq) {
      store.loading = false;
      render();
    }
  }
}
var extrasSeq = 0;
async function loadExtras(project, boardToken) {
  const seq = ++extrasSeq;
  const [att, nt, lp, lk] = await Promise.allSettled([
    getAttachments(project),
    getNotifications(project),
    getLoop(project),
    getLocks(project)
  ]);
  if (seq !== extrasSeq || boardToken !== boardSeq || store.projectId !== project) return;
  const failed = [];
  if (att.status === "fulfilled") store.attachments = att.value.attachments;
  else failed.push(att.reason);
  if (nt.status === "fulfilled") store.notifications = nt.value.notifications;
  else failed.push(nt.reason);
  if (lp.status === "fulfilled") store.loop = lp.value.loop;
  else failed.push(lp.reason);
  store.locks = lk.status === "fulfilled" ? lk.value.locks ?? [] : [];
  if (failed.length) {
    const message = describe(failed[0]);
    store.error = message;
    showToast(view, message);
  }
}
async function selectProject(slug) {
  if (store.projectId === slug) return;
  boardSeq++;
  resetBoard(store, slug);
  saveProject(slug);
  render();
  if (slug) await loadBoard();
}
async function loadProjects() {
  try {
    const { projects } = await getProjects();
    setProjects(store, projects);
    const wanted = store.projectId ?? readSavedProject();
    const pick2 = projects.find((x) => x.slug === wanted)?.slug ?? projects[0]?.slug ?? null;
    if (store.projectId === pick2) render();
    else await selectProject(pick2);
  } catch (e) {
    store.error = `projects: ${describe(e)}`;
    render();
  }
}
async function withPending(key, task) {
  store.pending.add(key);
  render();
  try {
    await task();
    store.error = null;
    return true;
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    await loadBoard();
    return false;
  } finally {
    store.pending.delete(key);
    render();
  }
}
function cardOf(key) {
  const card = store.cards[key];
  if (!card) return null;
  const { projectId, id } = parseKey(key);
  if (projectId !== store.projectId || card.projectId !== store.projectId) return null;
  return { card, projectId, id };
}
async function doAddCard(columnId, title) {
  const project = store.projectId;
  if (!project) {
    showToast(view, "\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044");
    return false;
  }
  try {
    const { card } = await createCard({ project, title, columnId });
    if (card.projectId !== project) {
      setProjects(store, (await getProjects()).projects);
      await selectProject(card.projectId);
      showToast(view, `#${card.id} \u3092 ${card.projectId} \u306B\u8FFD\u52A0`);
      return true;
    }
    if (upsertCard(store, card)) {
      store.error = null;
      render();
    } else await loadBoard();
    return true;
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    render();
    return false;
  }
}
async function doMove(key, columnId) {
  const cur = cardOf(key);
  if (!cur) {
    showToast(view, "\u5225\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u306E\u30AB\u30FC\u30C9\u3067\u3059\u3002\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u307E\u3059\u3002");
    await loadBoard();
    return;
  }
  const { card, projectId, id } = cur;
  applyLocalMove(store, key, columnId);
  await withPending(key, async () => {
    const { card: saved } = await moveCard(projectId, id, { columnId, version: card.version });
    upsertCard(store, saved);
  });
}
async function doEdit(key) {
  const cur = cardOf(key);
  if (!cur) {
    showToast(view, "\u5225\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u306E\u30AB\u30FC\u30C9\u3067\u3059\u3002\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u307E\u3059\u3002");
    await loadBoard();
    return;
  }
  const { card, projectId, id } = cur;
  const next = window.prompt("\u30BF\u30A4\u30C8\u30EB", card.title);
  if (next === null) return;
  const title = next.trim();
  if (!title || title === card.title) return;
  await withPending(key, async () => {
    const { card: saved } = await patchCard(projectId, id, { title, version: card.version });
    upsertCard(store, saved);
  });
}
async function doDelete(key) {
  const cur = cardOf(key);
  if (!cur) {
    showToast(view, "\u5225\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u306E\u30AB\u30FC\u30C9\u3067\u3059\u3002\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u307E\u3059\u3002");
    await loadBoard();
    return;
  }
  const { card, id } = cur;
  if (!window.confirm(`\u30AB\u30FC\u30C9 #${id}\u300C${card.title}\u300D\u3092\u524A\u9664\u3059\u308B\uFF1F`)) return;
  scheduleDelete(key, card, UNDO_MS);
  render();
  showToast(view, `\u30AB\u30FC\u30C9 #${id}\u300C${card.title}\u300D\u3092\u524A\u9664`, () => undoDelete(key));
}
async function doDeleteMany(keys) {
  const live = [];
  for (const key of keys) {
    const cur = cardOf(key);
    if (cur) live.push({ key, card: cur.card });
  }
  if (live.length === 0) {
    showToast(view, "\u5225\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u306E\u30AB\u30FC\u30C9\u3067\u3059\u3002\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u307E\u3059\u3002");
    await loadBoard();
    return;
  }
  if (!window.confirm(`\u30AB\u30FC\u30C9 ${live.length} \u4EF6\u3092\u524A\u9664\u3059\u308B\uFF1F`)) return;
  for (const { key, card } of live) scheduleDelete(key, card, 0);
  store.selection = /* @__PURE__ */ new Set();
  render();
  showToast(view, `${live.length} \u4EF6\u306E\u30AB\u30FC\u30C9\u3092\u524A\u9664`);
}
async function doSave(key, patch) {
  const cur = cardOf(key);
  if (!cur) {
    showToast(view, "\u5225\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u306E\u30AB\u30FC\u30C9\u3067\u3059\u3002\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u307E\u3059\u3002");
    await loadBoard();
    return false;
  }
  const { card, projectId, id } = cur;
  let ok = false;
  await withPending(key, async () => {
    const { card: saved } = await patchCard(projectId, id, { ...patch, version: card.version });
    upsertCard(store, saved);
    ok = true;
  });
  if (ok) await loadBoard();
  return ok;
}
async function doAddDep(key, toCard, type) {
  const cur = cardOf(key);
  if (!cur) {
    showToast(view, "\u5225\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u306E\u30AB\u30FC\u30C9\u3067\u3059\u3002\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u307E\u3059\u3002");
    await loadBoard();
    return false;
  }
  const { projectId, id } = cur;
  if (!store.cards[`${projectId}#${toCard}`]) {
    showToast(view, "\u5BFE\u8C61\u30AB\u30FC\u30C9\u304C\u540C\u3058\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u306B\u898B\u3064\u304B\u308A\u307E\u305B\u3093");
    await loadBoard();
    return false;
  }
  try {
    await addDependency({ project: projectId, fromCard: id, toCard, type });
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    return false;
  }
  await loadBoard();
  return true;
}
async function doRemoveDep(projectId, from, to, type) {
  if (projectId !== store.projectId) {
    await loadBoard();
    return false;
  }
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
async function doAddDeliverable(title, cardId) {
  const project = store.projectId;
  if (!project) {
    showToast(view, "\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044");
    return false;
  }
  if (cardId !== null && !store.cards[`${project}#${cardId}`]) {
    showToast(view, "\u5BFE\u8C61\u30AB\u30FC\u30C9\u304C\u540C\u3058\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u306B\u898B\u3064\u304B\u308A\u307E\u305B\u3093");
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
async function doDeleteDeliverable(projectId, id) {
  if (projectId !== store.projectId) {
    await loadBoard();
    return false;
  }
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
async function doCreateProject(name) {
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
var searchSeq = 0;
var searchTimer;
async function runSearch(q) {
  const all = store.searchAll;
  const board = store.projectId;
  if (!all && !board) return;
  const seq = ++searchSeq;
  try {
    const { hits } = await searchBoard(all ? null : board, q, all ? 50 : 20);
    if (seq !== searchSeq || store.searchAll !== all || store.projectId !== board || store.q !== q) return;
    store.hits = hits;
  } catch (e) {
    if (seq !== searchSeq) return;
    store.hits = null;
    store.error = describe(e);
    showToast(view, describe(e));
  }
  render();
}
function onSearchInput(q) {
  store.q = q;
  if (searchTimer) clearTimeout(searchTimer);
  if (!q.trim()) {
    store.hits = null;
    searchSeq++;
    render();
    return;
  }
  searchTimer = setTimeout(() => {
    void runSearch(q);
  }, 200);
}
function onCloseSearch() {
  searchSeq++;
  store.hits = null;
  render();
}
function openCardId(projectId, id) {
  const key = projectId ? cardKey(projectId, id) : null;
  if (!key || !store.cards[key]) {
    showToast(view, `\u30AB\u30FC\u30C9 #${id} \u306F\u3053\u306E\u30DC\u30FC\u30C9\u306B\u7121\u3044`);
    return;
  }
  detail.open(key);
}
async function openHit(hit) {
  if (hit.projectId !== store.projectId) await selectProject(hit.projectId);
  store.hits = null;
  render();
  if (hit.type === "card") openCardId(hit.projectId, hit.id);
}
function onToggleSearchAll() {
  store.searchAll = !store.searchAll;
  if (store.q.trim()) void runSearch(store.q);
  else render();
}
async function loadOverview() {
  try {
    store.overviewRows = (await getOverview()).projects;
    store.error = null;
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
  }
  render();
}
async function loadGraph() {
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
async function loadTemplates() {
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
async function loadViews() {
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
function openPane(pane) {
  store.pane = store.pane === pane ? "none" : pane;
  if (store.pane !== "none") {
    store.panels.deliverables = false;
    store.panels.timeline = false;
  }
  saveUi(store);
  render();
  if (store.pane === "templates") void loadTemplates();
  else if (store.pane === "views") void loadViews();
}
async function doEditColumn(columnId, patch) {
  const project = store.projectId;
  if (!project) {
    showToast(view, "\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044");
    return "\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u672A\u9078\u629E";
  }
  try {
    const { column } = await patchColumn(project, columnId, patch);
    if (store.projectId === project) {
      store.columns[column.id] = column;
      store.error = null;
      render();
    }
    return null;
  } catch (e) {
    const message = describe(e);
    store.error = message;
    showToast(view, message);
    render();
    return message;
  }
}
async function doUseTemplate(id) {
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
  showToast(view, "\u30C6\u30F3\u30D7\u30EC\u30FC\u30C8\u304B\u3089\u30AB\u30FC\u30C9\u3092\u4F5C\u6210\u3057\u305F");
}
async function doDeleteTemplate(id) {
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
async function doSaveTemplate(key) {
  const cur = cardOf(key);
  if (!cur) {
    showToast(view, "\u5225\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u306E\u30AB\u30FC\u30C9\u3067\u3059\u3002\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u307E\u3059\u3002");
    await loadBoard();
    return false;
  }
  const { card, projectId } = cur;
  const asked = window.prompt("\u30C6\u30F3\u30D7\u30EC\u30FC\u30C8\u540D", card.title);
  if (asked === null) return false;
  const name = asked.trim();
  if (!name) {
    showToast(view, "\u30C6\u30F3\u30D7\u30EC\u30FC\u30C8\u540D\u306F\u7A7A\u306B\u3067\u304D\u306A\u3044");
    return false;
  }
  try {
    await createTemplate({
      project: projectId,
      name,
      title: card.title,
      body: card.body ?? "",
      columnId: card.columnId,
      priority: card.priority,
      ...card.labels && card.labels.length ? { labels: card.labels } : {}
    });
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    render();
    return false;
  }
  store.panels.deliverables = false;
  store.panels.timeline = false;
  store.pane = "templates";
  saveUi(store);
  await loadTemplates();
  showToast(view, "\u30C6\u30F3\u30D7\u30EC\u30FC\u30C8\u306B\u4FDD\u5B58\u3057\u305F");
  return true;
}
async function doSaveView(name) {
  const project = store.projectId;
  if (!project) {
    showToast(view, "\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044");
    return false;
  }
  try {
    await createView({
      project,
      name,
      query: { ...store.q.trim() ? { q: store.q.trim() } : {}, ...store.qFocus ? { focus: true } : {} }
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
async function doDeleteView(id) {
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
function doApplyView(id) {
  const view_ = store.views.find((v) => v.id === id);
  if (!view_) return;
  store.q = view_.query.q ?? "";
  store.qFocus = Boolean(view_.query.focus);
  store.hits = null;
  if (store.q) void runSearch(store.q);
  else render();
  showToast(view, store.qFocus ? "\u30D3\u30E5\u30FC\u3092\u9069\u7528\uFF08\u30DC\u30FC\u30C9\u3092\u7D5E\u308A\u8FBC\u307F\uFF09" : "\u30D3\u30E5\u30FC\u3092\u9069\u7528");
}
async function doLoop(action) {
  const project = store.projectId;
  if (!project) return;
  let loop;
  let next = null;
  try {
    if (action === "start") loop = (await startLoop(project)).loop;
    else if (action === "stop") loop = (await stopLoop(project)).loop;
    else {
      const res = await tickLoop(project);
      loop = res.loop;
      next = res.nextCard;
    }
  } catch (e) {
    store.error = describe(e);
    showToast(view, describe(e));
    render();
    return;
  }
  if (store.projectId !== project) return;
  store.loop = { ...loop, nextTickAt: null };
  store.error = null;
  if (next) upsertCard(store, next);
  if (action === "tick") showToast(view, next ? `\u6B21\u306F #${next.id} ${next.title}` : loop.haltReason ?? "ready \u306A\u30AB\u30FC\u30C9\u304C\u7121\u3057");
  render();
  if (action === "tick") await loadBoard();
}
async function doUpload(key, file) {
  const cur = cardOf(key);
  if (!cur) {
    showToast(view, "\u5225\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u306E\u30AB\u30FC\u30C9\u3067\u3059\u3002\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u307E\u3059\u3002");
    await loadBoard();
    return false;
  }
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
async function doUploadDeliverable(deliverableId, file) {
  const project = store.projectId;
  if (!project) {
    showToast(view, "\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044");
    return false;
  }
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
async function doDeleteAttachment(projectId, id) {
  if (projectId !== store.projectId) {
    await loadBoard();
    return false;
  }
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
var view = mount(root, {
  onProject: (slug) => {
    store.overview = false;
    void selectProject(slug || null);
  },
  onCreateProject: doCreateProject,
  onAddCard: doAddCard,
  onMove: (key, columnId) => {
    void doMove(key, columnId);
  },
  onEdit: (key) => {
    void doEdit(key);
  },
  onDelete: (key) => {
    void doDelete(key);
  },
  onSelect: (keys) => {
    store.selection = new Set(keys);
    render();
  },
  onDeleteMany: (keys) => {
    void doDeleteMany(keys);
  },
  onSetPriority: (key, priority) => {
    void doSave(key, { priority });
  },
  onOpen: (key) => detail.open(key),
  onToggleFocus: () => {
    store.focus = !store.focus;
    render();
  },
  onTogglePanel: (which) => {
    if (which) store.panels[which] = !store.panels[which];
    else {
      store.panels.deliverables = false;
      store.panels.timeline = false;
    }
    if (store.panels.deliverables || store.panels.timeline) store.pane = "none";
    saveUi(store);
    render();
  },
  onToggleDone: () => {
    store.doneOpen = !store.doneOpen;
    saveUi(store);
    render();
  },
  onStaleDays: (days) => {
    store.staleDays = clampStale(days);
    saveUi(store);
    render();
  },
  onAddDeliverable: (title) => doAddDeliverable(title, null),
  onToggleDelSort: () => {
    store.delSort = store.delSort === "old" ? "new" : "old";
    saveUi(store);
    render();
  },
  onDeleteDeliverable: (projectId, id) => {
    void doDeleteDeliverable(projectId, id);
  },
  onSearch: (q) => onSearchInput(q),
  onCloseSearch,
  onOpenCard: (id) => openCardId(store.projectId, id),
  onOpenHit: (hit) => {
    void openHit(hit);
  },
  onToggleSearchAll,
  onToggleGantt: () => {
    store.gantt = !store.gantt;
    if (store.gantt) {
      store.overview = false;
      store.graph = false;
      store.pane = "none";
    }
    render();
  },
  onGanttScale: (scale) => {
    store.ganttScale = scale;
    render();
  },
  onTogglePane: (pane) => openPane(pane),
  onToggleOverview: () => {
    store.overview = !store.overview;
    if (store.overview) {
      store.pane = "none";
      store.gantt = false;
      void loadOverview();
    } else render();
  },
  onToggleGraph: () => {
    store.graph = !store.graph;
    if (store.graph) store.gantt = false;
    render();
    if (store.graph) void loadGraph();
  },
  onEditColumn: (columnId, patch) => doEditColumn(columnId, patch),
  onUseTemplate: (id) => {
    void doUseTemplate(id);
  },
  onDeleteTemplate: (id) => {
    void doDeleteTemplate(id);
  },
  onApplyView: (id) => doApplyView(id),
  onSaveView: (name) => doSaveView(name),
  onDeleteView: (id) => {
    void doDeleteView(id);
  },
  onLoop: (action) => {
    void doLoop(action);
  },
  onToggleFocusQuery: (on) => {
    store.qFocus = on;
    render();
  }
});
var detail = mountDetail(root, {
  onSave: doSave,
  onAddDep: doAddDep,
  onRemoveDep: (projectId, from, to, type) => doRemoveDep(projectId, from, to, type),
  onAddDeliverable: doAddDeliverable,
  onDeleteDeliverable: doDeleteDeliverable,
  onMove: (key, columnId) => {
    void doMove(key, columnId);
  },
  onDelete: (key) => {
    void doDelete(key);
  },
  onUploadAttachment: (key, file) => doUpload(key, file),
  onDeleteAttachment: (projectId, id) => doDeleteAttachment(projectId, id),
  onUploadDeliverableAttachment: (deliverableId, file) => doUploadDeliverable(deliverableId, file),
  onTemplateFromCard: (key) => {
    void doSaveTemplate(key);
  },
  onSessions: (projectId) => getSessions(projectId).then((r) => r.sessions),
  notify: (message) => showToast(view, message)
});
installKeys({
  selected: () => [...store.selection],
  onSelect: (keys) => {
    store.selection = new Set(keys);
    render();
  },
  onOpen: (key) => detail.open(key),
  doingFirst: () => {
    const id = store.columnOrder.find((c) => store.columns[c]?.kind === "doing");
    const card = id === void 0 ? void 0 : cardsInColumn(store, id)[0];
    return card ? cardKey(card.projectId, card.id) : null;
  }
});
function render() {
  renderView(view, store);
  detail.render(store, store.projects);
}
async function boot() {
  render();
  await Promise.allSettled([loadMeta(), loadProjects()]);
}
void boot();
setInterval(() => {
  if (!document.hidden) void loadBoard();
}, POLL_MS);
setInterval(() => {
  if (document.hidden || !store.loop) return;
  view.loopText.textContent = loopBarText(store.loop);
}, 1e3);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  void loadBoard();
});
window.addEventListener("focus", () => {
  void loadBoard();
});
