(function () {
  "use strict";
  var MEDIA = "/api/media/";
  var API = "/api/dashboard";
  var POLL = 5000;
  var DAY = 86400000;
  var STALE = 7 * DAY;

  var state = {
    payload: null, projects: null, board: null,
    cur: "", allview: false, query: "", sel: -1,
    cards: {}, open: {}, doneOpen: false, projDoneOpen: false, offline: false, addCol: null,
    modal: null,
  };
  var etags = {};

  function el(t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = String(x); return n; }
  function $(s) { return document.querySelector(s); }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }

  // #71: 押下中の二重送信を防ぐ。同期ハンドラ（reload など）は null を返して busy にしない。
  function flightGate(fn) {
    var busy = false;
    function release() { busy = false; }
    function run() {
      if (busy) return null;
      var p = fn();
      if (!p || typeof p.then !== "function") return null;
      busy = true;
      p.then(release, release);
      return p;
    }
    run.isBusy = function () { return busy; };
    return run;
  }
  // 操作ボタンの共通形。押下中は disabled、成功・失敗のどちらでも戻す。
  function btn(label, title, fn, off) {
    var b = el("button", "act", label);
    if (title) b.title = title;
    b.disabled = !!off;
    var run = flightGate(fn);
    b.onclick = function () {
      b.disabled = true;
      var p = run();
      if (p) p.then(release, release);
      else b.disabled = !!off;
    };
    function release() { b.disabled = !!off; }
    return b;
  }
  // #71: loop の残数表示。0 は無制限、壊れた入力は無制限に落ちる（モードファイルは手で編集されうる）。
  function loopRestLine(cap, used) {
    var c = typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
    var u = typeof used === "number" && Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
    if (c > 0) return "残り " + Math.max(0, c - u) + " / " + c;
    return "残り " + u + " / 無制限";
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function todayISO() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function qsOf(params) {
    if (!params) return "";
    var qs = [], keys = Object.keys(params), i;
    for (i = 0; i < keys.length; i++) qs.push(encodeURIComponent(keys[i]) + "=" + encodeURIComponent(String(params[keys[i]])));
    return qs.length ? "?" + qs.join("&") : "";
  }

  // ---- fetch: ETag 付き read（304 は null = 変化なし）と POST ----
  function getJSON(path, params) {
    var u = path + qsOf(params), h = {};
    if (etags[u]) h["If-None-Match"] = etags[u];
    return fetch(u, { headers: h }).then(function (r) {
      if (r.status === 401) { authFail(); throw new Error("http 401"); }
      if (r.status === 304) return null;
      if (!r.ok) throw new Error("http " + r.status);
      var et = r.headers.get("ETag");
      if (et) etags[u] = et;
      return r.json();
    });
  }
  // 帯の書き込みは GET+query（サーバ側は same-origin の GET だけ通す。#80-⑥）。
  function act(path, params) {
    var ps = {}, k;
    for (k in params) if (Object.prototype.hasOwnProperty.call(params, k)) ps[k] = params[k];
    if (state.cur && state.cur !== "__all__") ps.p = state.cur;
    return fetch(path + qsOf(ps)).then(function (r) {
      if (r.status === 401) authFail();
      if (!r.ok) throw new Error("http " + r.status);
      etags = {}; // 書き込み後は 304 で古い対面を掴まない
      return r.json();
    });
  }
  function fail(e) { toast("接続失敗: " + (e && e.message ? e.message : e)); }
  function apiDone() { try { authOk(); } catch (e) { void e; } }

  // 401 は「トークンが無い/失効」= 何も見えないのに理由が見えない状態。常報する。
  function authFail() {
    var b = $("#banner");
    if (!b) return;
    b.hidden = false;
    b.textContent = "トークンが無効です。/kanban url でリンクを取り、もう一度開いて。";
  }
  function authOk() {
    var b = $("#banner");
    if (!b || b.hidden) return;
    b.hidden = true; // 401 から復帰したら消す
  }

  // ---- derived data ----
  function projReport() { return state.board && state.board.project ? state.board.project : null; }
  function modesOf() {
    var p = projReport();
    if (p && p.modes) return p.modes;
    if (state.board && state.board.modes && state.board.modes.project) return state.board.modes.project;
    return {};
  }
  // 停止はサーバが true を返した時だけ。b.halted !== true（欠落 / false）は稼働中扱い。
  function halted() { var p = projReport(); return !!p && p.halted === true; }
  function summaryOf(slug) {
    var ps = (state.projects && state.projects.projects) || [], i;
    for (i = 0; i < ps.length; i++) if (ps[i].slug === slug) return ps[i];
    return null;
  }
  function boards() { return (state.payload && state.payload.boards) || []; }
  function cardHit(c) {
    var q = state.query.trim().toLowerCase();
    if (!q) return true;
    var hay = [c.text, "#" + c.id, c.project, c.sid, c.sessionId, c.commit, c.blocked, (c.labels || []).join(" ")]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.indexOf(q) >= 0;
  }
  function prioOf(c) { return typeof c.priority === "number" && isFinite(c.priority) ? c.priority : 0; }
  function dueOf(c) { return typeof c.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.due) ? c.due : ""; }
  function daysLeft(due) { return Math.round((Date.parse(due + "T00:00:00Z") - Date.parse(todayISO() + "T00:00:00Z")) / DAY); }
  function ago(ms) {
    if (!ms) return "";
    var d = Date.now() - ms;
    if (d < 60000) return "たった今";
    if (d < 3600000) return Math.floor(d / 60000) + "分前";
    if (d < DAY) return Math.floor(d / 3600000) + "時間前";
    return Math.floor(d / DAY) + "日前";
  }
  function stalled(c) { return c.col === "doing" && typeof c.movedAt === "number" && Date.now() - c.movedAt >= STALE; }
  function imgsOf(c) {
    if (typeof c.img !== "string" || !c.img) return [];
    return c.img.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  }
  var VID = /\.(mp4|webm|mp3|wav|m4a|ogg)$/i;
  function sortCol(list, col) {
    var a = list.slice();
    if (col === "todo") a.sort(function (x, y) { return (prioOf(y) - prioOf(x)) || (x.id - y.id); });
    else a.sort(function (x, y) { return (y.movedAt || 0) - (x.movedAt || 0); });
    return a;
  }
  function inCol(cards, col) { return sortCol(cards.filter(function (c) { return c.col === col && cardHit(c); }), col); }

  // ---- widgets ----
  var toastTimer;
  function toast(msg, undo) {
    var t = $("#toast"), u = $("#toastundo");
    $("#toastmsg").textContent = msg;
    u.style.display = undo ? "" : "none";
    u.onclick = undo ? function () { t.removeAttribute("open"); undo(); } : null;
    t.setAttribute("open", "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.removeAttribute("open"); }, 6000);
  }
  function chip(cls, text) { return el("span", "chip" + (cls ? " " + cls : ""), text); }

  function cardEl(c, showProject) {
    var due = dueOf(c), left = due ? daysLeft(due) : 0;
    var bad = due && left < 0 && c.col !== "done";
    var a = el("article", "card" + (bad ? " overdue" : ""));
    a.dataset.id = c.id;
    // #46: ボード表示のときだけ掴める（すべてタブでは移動先の板が定まらない）。
    if (!showProject) {
      a.draggable = true;
      a.addEventListener("dragstart", function (e) {
        e.dataTransfer.setData("text/plain", String(c.id));
        e.dataTransfer.effectAllowed = "move";
        a.classList.add("dragging");
      });
      a.addEventListener("dragend", function () { a.classList.remove("dragging"); });
    }
    a.appendChild(el("span", "id", "#" + c.id));
    var tEl = el("span", "t");
    // md() は web/md.js の 1 実装（インライン HTML は web/md.js がエスケープする）。
    // 文字列を innerHTML に代入せず、escape 済みの断片として DOM 化する（XSS 面は md() 側で閉じている）。
    if (typeof md === "function") tEl.append(document.createRange().createContextualFragment(md(c.text)));
    else tEl.textContent = c.text || "";
    a.appendChild(tEl);
    if (c.col === "doing") {
      var sr = el("div", "spinrow");
      sr.appendChild(el("span", "spin"));
      sr.lastChild.setAttribute("aria-hidden", "true");
      sr.appendChild(el("span", "spinlabel", "実行中"));
      if (stalled(c)) sr.appendChild(chip("due-warn", Math.floor((Date.now() - c.movedAt) / DAY) + "日停滞"));
      a.appendChild(sr);
    }
    var imgs = imgsOf(c);
    var pics = imgs.filter(function (n) { return !VID.test(n); });
    var vids = imgs.filter(function (n) { return VID.test(n); });
    if (pics.length) {
      var th = el("div", "thumbs");
      pics.slice(0, 4).forEach(function (name, i) {
        var f = el("figure", "thumb");
        f.dataset.lb = name;
        f.dataset.i = lbList().length;
        var im = document.createElement("img");
        im.alt = c.text;
        im.loading = "lazy";
        im.src = MEDIA + encodeURIComponent(name);
        f.appendChild(im);
        if (i === 3 && pics.length > 4) f.appendChild(el("figcaption", "more", "+" + (pics.length - 4)));
        th.appendChild(f);
      });
      a.appendChild(th);
    }
    vids.forEach(function (name) {
      var mediaExt = (name.split(".").pop() || "").toLowerCase();
      var al = el("div", "attline");
      // 動画は <video> で描画する（img では再生できない）。autoplay は付けない。
      if (mediaExt === "mp4" || mediaExt === "webm") {
        var im = document.createElement("video");
        im.controls = true;
        im.preload = "metadata";
        im.src = MEDIA + encodeURIComponent(name);
        im.className = "vthumb";
        al.appendChild(im);
      } else {
        al.appendChild(el("span", null, "▸"));
        al.appendChild(el("span", null, name));
        al.appendChild(el("span", null, mediaExt));
      }
      a.appendChild(al);
    });
    var chips = el("div", "chips");
    (c.labels || []).forEach(function (l) {
      var k = l === "bug" ? "bug" : l === "feature" ? "feat" : l === "chore" ? "chore" : "";
      chips.appendChild(chip(k, l));
    });
    if (due && c.col !== "done") {
      if (left < 0) chips.appendChild(chip("due-bad", "期限超過 " + (-left) + "日"));
      else if (left === 0) chips.appendChild(chip("due-bad", "今日"));
      else if (left <= 3) chips.appendChild(chip("due-warn", "あと" + left + "日"));
    }
    (c.blocks || []).forEach(function (b) { chips.appendChild(chip("dep", "⊂ #" + b + " 待ち")); });
    if (c.blocked) chips.appendChild(chip("dep", "⊂ " + c.blocked));
    if (c.commit) chips.appendChild(chip("commit", String(c.commit).slice(0, 7)));
    if (chips.childNodes.length) a.appendChild(chips);
    var meta = el("div", "meta");
    if (due) meta.appendChild(el("span", null, "due " + due.slice(5).replace("-", "-")));
    if (typeof c.estimate === "number" && c.estimate > 0) meta.appendChild(el("span", null, c.estimate + "pt"));
    if (prioOf(c) > 0) meta.appendChild(el("span", null, "prio " + prioOf(c)));
    if (showProject && c.project) meta.appendChild(el("span", null, c.project));
    if (c.col !== "todo" && c.movedAt) meta.appendChild(el("span", null, ago(c.movedAt)));
    if (meta.childNodes.length) a.appendChild(meta);
    return a;
  }

  // ---- render: ptabs / strip / swline ----
  function renderPtabs() {
    var nav = clear($("#ptabs"));
    var all = el("button", "ptab");
    all.dataset.p = "__all__";
    all.setAttribute("aria-pressed", String(state.cur === "__all__"));
    all.appendChild(el("span", "dot"));
    all.appendChild(el("b", null, "すべて"));
    var g = (state.payload.global && state.payload.global.counts) || {};
    all.appendChild(el("span", "num", (g.todo || 0) + (g.doing || 0) + " 未完"));
    nav.appendChild(all);
    boards().forEach(function (slug, i) {
      var s = summaryOf(slug), b = el("button", "ptab");
      b.dataset.p = slug;
      b.title = String(i + 1);
      b.setAttribute("aria-pressed", String(state.cur === slug));
      if (s && s.counts.doing > 0) b.classList.add("doing");
      var dot = el("span", "dot");
      if (s && s.total > 0 && s.done === s.total) dot.classList.add("done");
      else if (s && s.counts.doing > 0) dot.classList.add("live");
      b.appendChild(dot);
      b.appendChild(document.createTextNode(slug));
      b.appendChild(el("span", "num", s ? (s.counts.todo ? "TODO " + s.counts.todo : s.done + "/" + s.total) : "—"));
      if (i < 9) b.appendChild(el("span", "key", String(i + 1)));
      nav.appendChild(b);
    });
  }

  function renderStrip() {
    var todo, doing, done, due = 0, stall = 0, pct, label = "この看板", tot = 0, dnum = 0;
    var rep = projReport();
    var cards = (rep && rep.cards) || [];
    if (state.allview) {
      var g = (state.payload.global && state.payload.global.counts) || {};
      todo = g.todo || 0; doing = g.doing || 0; done = g.done || 0;
      ((state.projects && state.projects.projects) || []).forEach(function (p) { due += p.overdue || 0; });
      ((state.payload.global && state.payload.global.cards) || []).forEach(function (c) { if (stalled(c)) stall += 1; });
      label = "全体進捗";
      tot = todo + doing + done; dnum = done;
    } else {
      var cnt = (rep && rep.counts) || {};
      todo = cnt.todo || 0; doing = cnt.doing || 0; done = cnt.done || 0;
      cards.forEach(function (c) { if (stalled(c)) stall += 1; });
      var s = summaryOf(state.cur);
      if (s) { due = s.overdue || 0; tot = s.total; dnum = s.done; }
      else { cards.forEach(function (c) { var d = dueOf(c); if (d && c.col !== "done" && d < todayISO()) due += 1; }); tot = todo + doing + done; dnum = done; }
    }
    pct = tot ? Math.round((dnum / tot) * 100) : 0;
    $("#sv-todo").textContent = todo;
    $("#sv-doing").textContent = doing;
    $("#sv-done").textContent = done;
    $("#sv-due").textContent = due;
    $("#sv-stall").textContent = stall;
    $("#sl-proj").textContent = label;
    var v = clear($("#sv-proj"));
    v.appendChild(document.createTextNode(pct + "% "));
    v.appendChild(el("small", null, dnum + "/" + tot));
  }

  function renderSw() {
    var m = modesOf(), rep = projReport();
    var loop = m.doingLoop !== false, pick = m.autoPick !== false;
    document.querySelector('[data-sw="loop"]').setAttribute("aria-pressed", String(loop));
    document.querySelector('[data-sw="pick"]').setAttribute("aria-pressed", String(pick));
    var pause = document.querySelector('[data-sw="pause"]');
    // #43/#48: 実値だけを見る。押した直後に楽観で反転しない（8 秒内の poll が返す）。
    pause.setAttribute("aria-pressed", String(halted()));
    pause.removeAttribute("aria-disabled");
    pause.title = halted() ? "解除。残り回数は resume で上限へ戻る" : "loop / 自動 pick を止める";
    var max = m.maxLoops, used = (rep && rep.loops) || 0;
    $("#loop-left").textContent = loopRestLine(max, used);
    // 上限の入力は poll で書き戻す。但し編集中の値は壊さない。
    var mlw = document.querySelector(".mlwrap");
    if (mlw) mlw.title = max && max > 0 ? "上限 " + max : "上限（無制限）";
    var mli = $("#ml");
    if (document.activeElement !== mli) mli.value = max && max > 0 ? String(max) : "0";
    var iv = $("#iv");
    if (iv && document.activeElement !== iv) iv.value = String(m.intervalMin > 0 ? m.intervalMin : 5);
    // 停止中は理由と出口を出す（トグルだけでは戻らないことを明記）。
    var note = $("#haltnote");
    if (note) note.hidden = !halted();
  }

  // ---- render: 3 columns ----
  function renderBoard() {
    var box = clear($("#board"));
    var rep = projReport(), cards = (rep && rep.cards) || [];
    ["todo", "doing", "done"].forEach(function (col) {
      var list = inCol(cards, col);
      var d = el("div", "col");
      var head = el("div", "colhead");
      head.appendChild(el("h2", null, col.toUpperCase()));
      head.appendChild(el("span", "n", list.length));
      if (col === "doing") {
        var wip = el("span", "wipbad");
        var n = (rep && rep.counts && rep.counts.doing) || 0;
        if (n >= 3) wip.classList.add("on");
        if (n >= 5) wip.classList.add("hot");
        wip.textContent = "WIP " + n + "/3";
        head.appendChild(wip);
      }
      if (col !== "done") {
        var add = el("button", "add", "+");
        add.title = "新規カード";
        add.onclick = function () { addCard(col); };
        head.appendChild(add);
      }
      d.appendChild(head);
      if (state.addCol === col) d.appendChild(addRow(col));
      // #46: HTML5 DnD。列は受けるだけ、POST は既存の moveCard。
      d.addEventListener("dragover", function (e) {
        if (!state.cur || state.cur === "__all__") return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        d.classList.add("drop");
      });
      d.addEventListener("dragleave", function () { d.classList.remove("drop"); });
      d.addEventListener("drop", function (e) {
        e.preventDefault();
        d.classList.remove("drop");
        var id = Number(e.dataTransfer.getData("text/plain"));
        if (id) moveCard(id, col).then(function () { toast("#" + id + " を " + col.toUpperCase() + " へ"); }, fail);
      });
      var shown = col === "done" && !state.doneOpen ? list.slice(0, 2) : list;
      shown.forEach(function (c) { d.appendChild(cardEl(c, false)); });
      if (col === "done" && list.length > 2) {
        var fold = el("div", "donefold");
        fold.setAttribute("role", "button");
        fold.tabIndex = 0;
        fold.appendChild(el("span", "upsym", state.doneOpen ? "⌄" : "⌃"));
        fold.appendChild(document.createTextNode(state.doneOpen ? " 畳む" : " 残り " + (list.length - 2) + " 枚を開く"));
        fold.onclick = function () { state.doneOpen = !state.doneOpen; render(); };
        d.appendChild(fold);
      }
      box.appendChild(d);
    });
  }

  // ---- render: 横断 ----
  function renderGroups() {
    var box = clear($("#groups"));
    var ps = ((state.projects && state.projects.projects) || []).slice();
    var openPs = ps.filter(function (p) { return p.done < p.total || p.total === 0; });
    var donePs = ps.filter(function (p) { return p.total > 0 && p.done === p.total; });
    var order = openPs.concat(state.query ? donePs : []); // 完了済みは折りたたみの下だけ
    order.forEach(function (p) { box.appendChild(groupEl(p)); });
    if (!state.query && donePs.length) {
      var fold = el("div", "donefold");
      fold.setAttribute("role", "button");
      fold.tabIndex = 0;
      fold.appendChild(el("span", "upsym", state.projDoneOpen ? "⌄" : "⌃"));
      fold.appendChild(document.createTextNode(state.projDoneOpen ? " 完了済みを畳む" : " 完了済み " + donePs.length + " プロジェクトを開く"));
      fold.onclick = function () { state.projDoneOpen = !state.projDoneOpen; render(); };
      box.appendChild(fold);
      if (!state.projDoneOpen) return;
      donePs.forEach(function (p) { box.appendChild(groupEl(p)); });
    }
  }
  function groupEl(p) {
    var complete = p.total > 0 && p.done === p.total;
    var det = document.createElement("details");
    det.className = "group";
    det.dataset.slug = p.slug;
    var isOpen = !!state.open[p.slug]; // 既定は畳む（クリックで開いて即 fetch）
    if (isOpen) det.setAttribute("open", "");
    var sum = document.createElement("summary");
    var dot = el("span", "dot");
    dot.style.background = "var(--" + (complete ? "ok" : p.counts.doing > 0 ? "warn" : "muted") + ")";
    sum.appendChild(dot);
    // #44: 名前（と進捗バー）だけがプロジェクトタブへの遷移。summary の他の面は
    // 既定のトグル（展開）のままにする。
    var gname = el("span", "gname", p.name || p.slug);
    gname.onclick = function (e) { e.preventDefault(); e.stopPropagation(); pick(p.slug); };
    sum.appendChild(gname);
    sum.appendChild(el("span", "gnum", p.done + "/" + p.total));
    var bar = el("div", "gbar"), i = document.createElement("i");
    i.style.width = p.progress + "%";
    if (complete) i.className = "full";
    bar.appendChild(i);
    bar.onclick = function (e) { e.preventDefault(); e.stopPropagation(); pick(p.slug); };
    sum.appendChild(bar);
    sum.appendChild(el("span", "gmini", complete ? "100% ✓" : p.counts.todo ? "TODO " + p.counts.todo : p.counts.doing ? "DOING " + p.counts.doing : "—"));
    det.appendChild(sum);
    var body = el("div", "cards");
    var cards = state.cards[p.slug];
    if (!cards) body.appendChild(el("div", "donefold", "読み込み中…"));
    else {
      var list = cards.filter(cardHit);
      if (!list.length) body.appendChild(el("div", "donefold", "該当なし"));
      sortCol(list, "todo");
      list.sort(function (x, y) { return x.col === "done" ? 1 : y.col === "done" ? -1 : 0; });
      list.forEach(function (c) { body.appendChild(cardEl(c, true)); });
    }
    det.appendChild(body);
    return det;
  }
  function fetchGroup(slug) {
    return getJSON("/api/kanban", { p: slug }).then(function (b) {
      if (b && b.project) state.cards[slug] = b.project.cards;
      return b;
    }, function () { return null; });
  }

  // ---- render: rail ----
  function renderRail() {
    var rail = clear($("#rail"));
    var rep = projReport();
    var cards = (rep && rep.cards) || [];
    var p1 = el("div", "panel");
    p1.appendChild(el("h3", null, "次に着手"));
    var nexts = [];
    if (rep && rep.next) nexts.push(rep.next);
    inCol(cards, "todo").forEach(function (c) { if (nexts.length < 3 && (!nexts[0] || c.id !== nexts[0].id)) nexts.push(c); });
    if (!nexts.length) p1.appendChild(el("div", "donefold", "候補なし"));
    nexts.forEach(function (c) {
      var it = el("div", "next-item");
      it.appendChild(el("span", "id", "#" + c.id));
      it.appendChild(el("span", "t", c.text));
      var d = dueOf(c);
      it.appendChild(el("span", "why", d ? "期限 " + d.slice(5) : prioOf(c) > 0 ? "prio " + prioOf(c) : "依存なし"));
      p1.appendChild(it);
    });
    rail.appendChild(p1);
    var p2 = el("div", "panel");
    p2.appendChild(el("h3", null, "活動 — この看板"));
    var moved = cards.filter(function (c) { return c.movedAt; }).sort(function (x, y) { return y.movedAt - x.movedAt; }).slice(0, 3);
    if (!moved.length) p2.appendChild(el("div", "donefold", "記録なし"));
    moved.forEach(function (c) {
      var ev = el("div", "ev");
      ev.appendChild(el("time", null, ago(c.movedAt)));
      ev.appendChild(el("b", null, "#" + c.id));
      ev.appendChild(document.createTextNode(" を " + c.col.toUpperCase() + " へ"));
      p2.appendChild(ev);
    });
    rail.appendChild(p2);
    // 停止中だけ出す。理由と出口（既存の resume 経路）を 1 か所に集める。
    if (halted()) {
      var p3 = el("div", "panel haltbox");
      p3.appendChild(el("h3", null, "停止中"));
      p3.appendChild(btn("解除", "resume。残り回数は上限へ戻る", function () {
        return act("/api/resume").then(function () { refresh(); toast("解除を要求した（次のポーリングで戻る）"); }, fail);
      }));
      rail.appendChild(p3);
    }
  }

  function renderFoot() {
    var p = state.payload || {};
    $("#footright").textContent = "API " + (p.version || "?") + " · " + (state.offline ? "接続断" : "3秒ポーリング") + " · dashboard v2.5";
  }

  // #70: 打鍵を受け付ける入力にフォーカスがある間は再描画しない（3 秒 poll で入力が消える）。
  var NO_TYPE_INPUT = /^(text|search|tel|url|email|password|number|date|datetime-local|time|month|week)$/;
  var EDIT_ZONE = "#addbar, #swline, #board, #rail, .modal";
  function isEditing() {
    var a = document.activeElement;
    if (!a || !a.tagName) return false;
    if (!a.closest || !a.closest(EDIT_ZONE)) return false;
    if (a.isContentEditable) return true;
    if (a.tagName === "TEXTAREA") return true;
    if (a.tagName !== "INPUT") return false;
    return NO_TYPE_INPUT.test(a.type || "text");
  }

  function render() {
    if (!state.payload) return;
    // 編集中は描き直さない。抜けたら focusout 側で 1 回だけ拾う（state.dirty）。
    if (isEditing()) { state.dirty = true; return; }
    state.dirty = false;
    var html = document.documentElement;
    html.classList.toggle("halt", halted());
    html.classList.toggle("allview", state.allview);
    $("#board").style.display = state.allview ? "none" : "";
    if (state.allview) $("#allview").setAttribute("open", ""); else $("#allview").removeAttribute("open");
    renderPtabs(); renderStrip(); renderSw();
    if (state.allview) renderGroups(); else renderBoard();
    renderRail(); renderFoot();
    applySel();
  }

  function visibleCards() { return Array.prototype.slice.call(document.querySelectorAll("#board .card, #groups .card")); }
  function applySel() {
    var all = visibleCards();
    if (state.sel >= all.length) state.sel = all.length - 1;
    all.forEach(function (n, i) { n.classList.toggle("sel", i === state.sel); });
  }

  // ---- data: poll ----
  function refresh() {
    var jobs = [
      getJSON(API).then(function (p) {
        if (p) { state.payload = p; if (!state.cur) state.cur = p.project && p.project.id ? p.project.id : "__all__"; }
      }),
      getJSON("/api/projects").then(function (p) { if (p) state.projects = p; }),
    ];
    if (state.cur && state.cur !== "__all__") {
      jobs.push(getJSON("/api/kanban", { p: state.cur }).then(function (b) { if (b) state.board = b; }));
    } else if (state.cur === "__all__") {
      Object.keys(state.open).forEach(function (s) { if (state.open[s]) jobs.push(fetchGroup(s)); });
    }
    return Promise.all(jobs).then(function () {
      state.offline = false;
      apiDone();
      if (state.allview) { state.allview = true; }
      // 起動直後は state.cur が dashboard の応答で決まるので、板だけが未取得になる。
      // ここで取り直さないと次の poll（数分後）まで列が空のまま。
      if (!state.board && state.cur && state.cur !== "__all__") return pick(state.cur);
      render();
    }, function (e) {
      state.offline = true;
      renderFoot();
      fail(e);
    });
  }

  function pick(slug) {
    state.cur = slug;
    state.allview = slug === "__all__";
    state.sel = -1;
    state.board = null;
    closeModal();
    var jobs = [getJSON("/api/projects").then(function (p) { if (p) state.projects = p; })];
    if (state.allview) {
      ((state.projects && state.projects.projects) || []).forEach(function (p) {
        if (state.open[p.slug]) jobs.push(fetchGroup(p.slug)); // 開いた時だけ取得
      });
    } else {
      // 切り替え中に古い板が返ってきたら捨てる（state.cur を後で書き換えている）。
      var want = slug;
      jobs.push(getJSON("/api/kanban", { p: slug }).then(function (b) { if (b && state.cur === want) state.board = b; }));
    }
    return Promise.all(jobs).then(render, function (e) { fail(e); });
  }

  // ---- actions ----
  function needProj() {
    if (state.allview || !state.cur || state.cur === "__all__") { toast("横断ビューでは操作できない（ボードを選ぶ）"); return false; }
    return true;
  }
  function addCard(col) {
    if (!needProj()) return;
    state.addCol = col;
    render();
    var i = document.querySelector("#board .addin");
    if (i) i.focus();
  }
  // #75: その場追加の打ちかけは再描画で消さない。閉じる（state.addCol）と破棄（draft）を分ける。
  var addDraft = {};
  function addRow(col) {
    var f = document.createElement("form");
    f.className = "addrow";
    var inp = document.createElement("input");
    inp.className = "addin";
    inp.placeholder = "新規カード → Enter (Esc で取消)";
    if (addDraft[col] != null) inp.value = addDraft[col];
    inp.addEventListener("input", function () { addDraft[col] = inp.value; });
    // 空で離れたら捨てる。値が入っていれば残す（打ちかけを失わない）。
    inp.addEventListener("blur", function () { if (!inp.value.trim()) delete addDraft[col]; });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { state.addCol = null; delete addDraft[col]; render(); }
    });
    f.onsubmit = function (e) { e.preventDefault(); submitAdd(col, inp.value); };
    f.appendChild(inp);
    return f;
  }
  function submitAdd(col, text) {
    if (!text || !text.trim()) { state.addCol = null; render(); return; }
    act("/api/add", { text: text.trim(), col: col }).then(function () {
      state.addCol = null;
      delete addDraft[col];
      refresh();
      toast("#" + (col === "todo" ? "TODO" : col.toUpperCase()) + " に追加");
    }, fail);
  }
  function moveCard(id, col) {
    if (!needProj()) return;
    return act("/api/move", { id: id, col: col }).then(function () { refresh(); }, fail);
  }
  function toggleMode(key) {
    if (!needProj()) return;
    var m = modesOf(), on = key === "doingLoop" ? m.doingLoop !== false : m.autoPick !== false;
    act("/api/modes", { key: key, value: on ? "off" : "on" }).then(function () { refresh(); }, fail);
  }
  function doneTop() {
    if (!needProj()) return;
    var doing = inCol((projReport() && projReport().cards) || [], "doing");
    if (!doing.length) { toast("DOING にカードが無い"); return; }
    var c = doing[0];
    moveCard(c.id, "done").then(function () {
      toast("#" + c.id + " を DONE へ", function () { moveCard(c.id, "doing"); });
    }, fail);
  }
  function summary() {
    var rep = projReport(), m = modesOf();
    var cnt = (rep && rep.counts) || {};
    var t = "kanban " + (state.cur || "?") + " — TODO " + (cnt.todo || 0) + " / DOING " + (cnt.doing || 0) +
      " / DONE " + (cnt.done || 0) + " · loop " + (m.doingLoop !== false ? "on" : "off") +
      " · pick " + (m.autoPick !== false ? "on" : "off") + (halted() ? " · HALT" : "");
    toast(t);
    if (navigator.clipboard) navigator.clipboard.writeText(t).catch(function () {});
  }

  // ---- palette ----
  var palSel = 0, palRuns = [];
  function palItems() {
    var items = [];
    boards().forEach(function (slug, i) {
      items.push({ label: "切替: " + slug + (i < 9 ? " (" + (i + 1) + ")" : ""), run: function () { pick(slug); } });
    });
    items.push({ label: "横断ビュー: すべて", run: function () { pick("__all__"); } });
    items.push({ label: "loop " + (modesOf().doingLoop !== false ? "off" : "on"), run: function () { toggleMode("doingLoop"); } });
    items.push({ label: "autoPick " + (modesOf().autoPick !== false ? "off" : "on"), run: function () { toggleMode("autoPick"); } });
    items.push({ label: "summary を出す", run: summary });
    items.push({ label: "新規カード", run: function () { addCard("todo"); } });
    return items;
  }
  function renderPal() {
    var q = $("#palq").value.trim().toLowerCase();
    var box = clear($("#pallist"));
    palRuns = palItems().filter(function (it) { return !q || it.label.toLowerCase().indexOf(q) >= 0; });
    if (palSel >= palRuns.length) palSel = Math.max(0, palRuns.length - 1);
    palRuns.forEach(function (it, i) {
      var d = el("div", "it" + (i === palSel ? " sel" : ""), it.label);
      d.onclick = function () { closePal(); it.run(); };
      box.appendChild(d);
    });
  }
  function openPal() { $("#pal").setAttribute("open", ""); $("#palq").value = ""; palSel = 0; renderPal(); $("#palq").focus(); }
  function closePal() { $("#pal").removeAttribute("open"); }

  // ---- lightbox ----
  var lbList = function () { return Array.prototype.slice.call(document.querySelectorAll(".thumb")); };
  var lbAt = 0;
  function showLb(i) {
    var th = lbList();
    if (!th.length) return;
    lbAt = (i + th.length) % th.length;
    var im = th[lbAt].querySelector("img");
    $("#lbimg").src = im.src;
    $("#lbcap").textContent = (th[lbAt].dataset.lb || im.alt || "") + "  (" + (lbAt + 1) + "/" + th.length + ")";
    $("#lb").setAttribute("open", "");
  }
  function closeLb() { $("#lb").removeAttribute("open"); $("#lbimg").src = ""; }

  // ---- card modal (#45) ----
  function modalCard() {
    var rep = projReport(), cards = (rep && rep.cards) || [], i;
    for (i = 0; i < cards.length; i++) if (cards[i].id === state.modal) return cards[i];
    return null;
  }
  function openModal(id) {
    if (!needProj()) return;
    state.modal = id;
    var c = modalCard();
    if (!c) { state.modal = null; return; }
    $("#cm-id").textContent = "#" + c.id;
    $("#cm-text").value = c.text || "";
    $("#cm-project").value = c.project || "";
    $("#cm-labels").value = (c.labels || []).join(",");
    $("#cm-due").value = dueOf(c);
    $("#cm-estimate").value = typeof c.estimate === "number" ? String(c.estimate) : "";
    $("#cm-blocked").value = c.blocked || "";
    $("#cm-at").value = c.nextFireAt || "";
    renderPrio(c);
    $("#cm").setAttribute("open", "");
    $("#cm-text").focus();
  }
  function closeModal() { state.modal = null; $("#cm").removeAttribute("open"); }
  function renderPrio(c) {
    var n = prioOf(c);
    Array.prototype.forEach.call(document.querySelectorAll("#cm [data-prio]"), function (b) {
      b.setAttribute("aria-pressed", String(Number(b.dataset.prio) === n));
    });
  }
  // 本文は /api/rename、残り（at/blocked/project/labels）は 1 本の /api/schedule。
  // due/estimate を更新する端点は無いので、この面では表示のみ（v1）。
  function saveModal() {
    var c = modalCard();
    if (!c) return;
    var id = c.id, text = $("#cm-text").value.trim(), jobs = [];
    if (text && text !== c.text) jobs.push(act("/api/rename", { id: id, text: text }));
    jobs.push(act("/api/schedule", {
      id: id,
      at: $("#cm-at").value.trim(),
      blocked: $("#cm-blocked").value.trim(),
      project: $("#cm-project").value.trim(),
      labels: $("#cm-labels").value.trim(),
    }));
    Promise.all(jobs).then(function () { closeModal(); refresh(); toast("#" + id + " を保存"); }, fail);
  }

  // ---- wiring ----
  document.addEventListener("change", function (e) {
    // #47 周辺: 上限の保存。v2.5 で消えていた設定をスイッチ帯に戻した。
    if (!e.target) return;
    if (e.target.id === "iv") {
      if (!needProj()) return;
      var min = Number(e.target.value);
      if (!Number.isFinite(min) || min < 1) return;
      getJSON("/api/interval", { min: Math.round(min) }).then(function () { refresh(); toast("間隔を " + Math.round(min) + " 分に"); }, fail);
      return;
    }
    if (e.target.id !== "ml") return;
    if (!needProj()) return;
    var n = Number(e.target.value);
    if (!Number.isFinite(n) || n < 0) return;
    act("/api/maxloops", { n: Math.round(n) }).then(function () { refresh(); toast("上限を " + (n > 0 ? n : "∞") + " に"); }, fail);
  });

  document.addEventListener("click", function (e) {
    var t = e.target;
    var ptab = t.closest && t.closest(".ptab");
    if (ptab) { pick(ptab.dataset.p); return; }
    var sw = t.closest && t.closest(".sw");
    if (sw) {
      var k = sw.dataset.sw;
      if (k === "pause") {
        // #43/#48: 止まっていれば解除、動いていれば halt。表示は poll の実値に従う。
        if (!needProj()) return;
        var was = halted();
        act(was ? "/api/resume" : "/api/halt").then(function () {
          refresh();
          toast(was ? "解除を要求した（次のポーリングで戻る）" : "一時停止を要求した");
        }, fail);
        return;
      }
      toggleMode(k === "loop" ? "doingLoop" : "autoPick");
      return;
    }
    if (t.closest && t.closest("#cm")) {
      var prio = t.closest("[data-prio]");
      var mv = t.closest("[data-move]");
      var c0 = modalCard();
      if (prio && c0) {
        act("/api/priority", { id: c0.id, n: Number(prio.dataset.prio) }).then(function () { refresh(); var c1 = modalCard(); if (c1) renderPrio(c1); }, fail);
        return;
      }
      if (mv && c0) {
        var col = mv.dataset.move;
        act("/api/move", { id: c0.id, col: col }).then(function () { closeModal(); refresh(); toast("#" + c0.id + " を " + col.toUpperCase() + " へ"); }, fail);
        return;
      }
      if (t.id === "cm-close") { closeModal(); return; }
      if (t.id === "cm-save") { saveModal(); return; }
      if (t.id === "cm-sched" && c0) {
        var at = $("#cm-at").value.trim();
        act("/api/schedule", { id: c0.id, at: at }).then(function () {
          refresh();
          toast("#" + c0.id + (at ? " を " + at + " で実行予約" : " の実行予約を解除"));
        }, fail);
        return;
      }
      if (t.id === "cm-del" && c0) {
        if (!window.confirm("#" + c0.id + " を削除する？")) return;
        act("/api/remove", { id: c0.id }).then(function () { closeModal(); refresh(); toast("#" + c0.id + " を削除"); }, fail);
        return;
      }
      return; // モーダル内の他のクリックは下へ流さない
    }
    var th = t.closest && t.closest(".thumb");
    if (th) { showLb(lbList().indexOf(th)); return; }
    if (t.id === "lb" || t.id === "lbimg") closeLb();
    // カード本文クリックで選択（j/k と同じ対象）＋編集モーダル（#45）。
    var card = t.closest && t.closest("article.card");
    if (card && !(t.closest("button,form,input"))) {
      var all = visibleCards();
      state.sel = all.indexOf(card);
      applySel();
      if (card.closest("#board")) openModal(Number(card.dataset.id));
    }
  });
  document.addEventListener("toggle", function (e) {
    var det = e.target;
    if (!det.classList || !det.classList.contains("group")) return;
    var slug = det.dataset.slug;
    state.open[slug] = det.open;
    if (det.open && !state.cards[slug]) fetchGroup(slug).then(render);
  }, true);

  $("#q").addEventListener("input", function () { state.query = this.value; state.sel = -1; render(); });
  $("#palBtn").onclick = openPal;
  $("#palq").addEventListener("input", function () { palSel = 0; renderPal(); });
  $("#palq").addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { palSel = Math.min(palRuns.length - 1, palSel + 1); renderPal(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { palSel = Math.max(0, palSel - 1); renderPal(); e.preventDefault(); }
    else if (e.key === "Enter") { var it = palRuns[palSel]; if (it) { closePal(); it.run(); } }
    else if (e.key === "Escape") { closePal(); }
  });
  $("#foldAll").onclick = function () {
    ((state.projects && state.projects.projects) || []).forEach(function (p) { state.open[p.slug] = true; });
    state.projDoneOpen = true;
    var jobs = ((state.projects && state.projects.projects) || []).filter(function (p) { return !state.cards[p.slug]; })
      .map(function (p) { return fetchGroup(p.slug); });
    Promise.all(jobs).then(render);
  };
  $("#foldDone").onclick = function () {
    state.projDoneOpen = false;
    ((state.projects && state.projects.projects) || []).forEach(function (p) {
      if (p.total > 0 && p.done === p.total) state.open[p.slug] = false;
    });
    render();
  };
  $("#themeBtn").onclick = function () {
    var light = document.documentElement.getAttribute("data-theme") === "light";
    document.documentElement.setAttribute("data-theme", light ? "dark" : "light");
    this.textContent = "テーマ: " + (light ? "暗" : "明");
    try { localStorage.setItem("kb-theme", light ? "dark" : "light"); } catch (err) { void err; }
  };
  $("#densityBtn").onclick = function () {
    var c = document.documentElement.getAttribute("data-density") === "compact";
    document.documentElement.setAttribute("data-density", c ? "normal" : "compact");
    this.textContent = "密度: " + (c ? "標準" : "コンパクト");
    try { localStorage.setItem("kb-density", c ? "normal" : "compact"); } catch (err) { void err; }
  };

  // プロジェクトタブ列を縦ホイールで横スクロール (shift 不要)
  document.addEventListener("wheel", function (e) {
    var t = e.target.closest ? e.target.closest(".ptabs") : null;
    if (!t || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    t.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  document.addEventListener("keydown", function (e) {
    // Ctrl/Cmd+K は検索欄からでも開く（入力中の打鍵は下で捨てる）
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPal(); return; }
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") {
      if (e.key === "Escape") { e.target.blur(); if (e.target.id === "palq") closePal(); }
      return;
    }
    if ($("#pal").hasAttribute("open")) {
      if (e.key === "Escape") closePal();
      else $("#palq").focus();
      return;
    }
    if ($("#cm").hasAttribute("open")) {
      if (e.key === "Escape") closeModal();
      return;
    }
    if ($("#lb").hasAttribute("open")) {
      if (e.key === "Escape") closeLb();
      else if (e.key === "ArrowRight") showLb(lbAt + 1);
      else if (e.key === "ArrowLeft") showLb(lbAt - 1);
      return;
    }
    if (e.key === "Escape") { state.sel = -1; applySel(); return; }
    if (e.key === "Enter" && state.sel >= 0) {
      var sel = visibleCards()[state.sel];
      if (sel) {
        var tn = sel.querySelector(".thumb");
        if (tn) { showLb(lbList().indexOf(tn)); e.preventDefault(); }
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    if (k >= "0" && k <= "9") {
      if (k === "0") { pick("__all__"); return; }
      var slug = boards()[Number(k) - 1];
      if (slug) pick(slug);
      return;
    }
    if (k === "/") { e.preventDefault(); $("#q").focus(); return; }
    if (k === "c") { addCard("todo"); return; }
    if (k === "d") { doneTop(); return; }
    if (k === "j" || k === "k") {
      var all = visibleCards();
      if (!all.length) return;
      state.sel = Math.max(0, Math.min(all.length - 1, state.sel + (k === "j" ? 1 : -1)));
      applySel();
      if (all[state.sel]) all[state.sel].scrollIntoView({ block: "nearest" });
      e.preventDefault();
    }
  });

  try {
    var th = localStorage.getItem("kb-theme");
    if (th === "light") { document.documentElement.setAttribute("data-theme", "light"); $("#themeBtn").textContent = "テーマ: 明"; }
    if (localStorage.getItem("kb-density") === "compact") { document.documentElement.setAttribute("data-density", "compact"); $("#densityBtn").textContent = "密度: コンパクト"; }
  } catch (err) { void err; }

  // #85: ポーリングは setTimeout 1 本。隠れているタブでは張らず、復帰で 1 回だけ取り直す。
  var timer = null;
  var fails = 0;
  function nextDelay() { return fails === 0 ? POLL : Math.min(1000 * Math.pow(2, fails - 1), 30000); }
  function schedule(){
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (document.visibilityState === "hidden") return;
    timer = setTimeout(function () { timer = null; reload(); }, nextDelay());
  }
  function reload() {
    return refresh().then(function () {
      fails = state.offline ? Math.min(fails + 1, 6) : 0;
      schedule();
    });
  }
  if (typeof document.addEventListener === "function") document.addEventListener("visibilitychange", function () {
    // 復帰時は 1 回だけ取り直す。reload の .then(schedule) が次のタイマーを張る。
    if (document.visibilityState === "visible") { reload(); return; }
    schedule();
  });
  if (typeof document.addEventListener === "function") document.addEventListener("focusout", function () {
    // 編集を抜けたら 1 度だけ描き直す（render 側で編集を検知したら止めている）。
    setTimeout(function () { if (state.dirty && !isEditing()) render(); }, 0);
  });

  refresh().then(function () { schedule(); });
})();
