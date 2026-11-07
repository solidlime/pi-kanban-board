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
    modal: null, uploading: false,
    // #82: 成果物のモーダル番号。card の #3 と deliv の #3 は別物なので id 空間を共有しない。
    modalDeliv: null,
    // #52: false = 他セッションの TODO は畳んで「他 N 件」だけ出す。押した時だけ true にして
    // showOthers=1 で取りに行く（既定の見え方を自動挙動に合わせない）。
    showOthers: false,
    // #84: 溢れたタブを「+N」で畳んでいるか（true = 折り返して全部出す）
    ptabsOpen: false,
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
      // #50: サーバの error 文面を toast に出す（失敗理由が "http 400" だけだと分からない）。
      if (!r.ok) return r.json().then(function (j) {
        throw new Error((j && j.error) || "http " + r.status);
      }, function () { throw new Error("http " + r.status); });
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
  // #56: card.img の 1 エントリが file:<絶対パス> なら「参照型」— コピーせず、その場所を読む。
  var REF = "file:";
  function refOf(n) { return n.slice(0, REF.length) === REF ? n.slice(REF.length) : ""; }
  // 添付 1 エントリの実 URL。media 名は /api/media、参照型は /api/ref（allowlist はサーバ側）。
  function srcOf(n) {
    var p = refOf(n);
    return p ? "/api/ref?f=" + encodeURIComponent(p) : MEDIA + encodeURIComponent(n);
  }
  // #53: .html の添付はサンドボックス iframe で読む（three.js は CDN から自分で読む）。
  var HTML = /\.html?$/i;
  function sortCol(list, col) {
    var a = list.slice();
    if (col === "todo") a.sort(function (x, y) { return (prioOf(y) - prioOf(x)) || (x.id - y.id); });
    else a.sort(function (x, y) { return (y.movedAt || 0) - (x.movedAt || 0); });
    return a;
  }
  function inCol(cards, col) { return sortCol(cards.filter(function (c) { return c.col === col && cardHit(c); }), col); }
  // #52: 自分のボードは showOthers を引き回して取り直す（トグルもこの 1 か所を使う）。
  function boardGet(slug) { return getJSON("/api/kanban", { p: slug, showOthers: state.showOthers ? 1 : 0 }); }
  // #52: DOING の所有者表示。長い sid は最初の 8 文字（s- 接頭辞は落とす）。
  function shortSid(s) { return String(s || "").replace(/^s-/, "").slice(0, 8) || "?"; }

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
      // #52: DOING は誰が掴んでいるかを見せる（c.mine はサーバが sidActor で立てる）。
      if (c.movedBy) sr.appendChild(el("span", "chip owner", "👤 " + (c.mine ? "あなた" : shortSid(c.movedBy))));
      if (stalled(c)) sr.appendChild(chip("due-warn", Math.floor((Date.now() - c.movedAt) / DAY) + "日停滞"));
      a.appendChild(sr);
    }
    // #52: showOthers で出した他セッションの TODO は薄く + 他バッジ（自分のものと見分ける）。
    if (c.col === "todo" && c.movedBy && !c.mine) {
      a.classList.add("other");
      a.appendChild(el("span", "chip other", "他"));
    }
    var imgs = imgsOf(c);
    var vids = imgs.filter(function (n) { return VID.test(n); });
    // html も thumb に並べる（img ではなく mini iframe）。
    var pics = imgs.filter(function (n) { return !VID.test(n); });
    if (pics.length) {
      var th = el("div", "thumbs");
      pics.slice(0, 4).forEach(function (name, i) {
        var f = el("figure", "thumb");
        f.dataset.lb = name;
        f.dataset.i = lbList().length;
        f.appendChild(thumbBody(name, c.text));
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
        im.src = srcOf(name);
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
    // #56: 参照型の添付があるカードはその旨を 1 バッジで示す（中身は thumb 側で見える）。
    if (imgs.some(function (n) { return refOf(n); })) chips.appendChild(chip("ref", "\u2750 \u30ea\u30f3\u30af"));
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
    // #85: poll ごとに作り直すと、タブのフォーカスと scrollLeft が飛ぶ。
    // #78 の renderBoard と同じで、同じ slug のタブは既存ノードを使い回して中身（num/dot/aria）
    // だけ書き換え、並びが変わった分だけ動かす。動かすと focus は落ちるので最後に戻す。
    var nav = $("#ptabs");
    var focused = document.activeElement, sl = nav.scrollLeft;
    nav.classList.toggle("open", state.ptabsOpen === true); // #84
    var keep = {}, more = null;
    Array.prototype.forEach.call(nav.children, function (n) {
      if (n.classList.contains("ptab-more")) more = n;   // 畳みボタンも使い回す
      else if (n.dataset.p) keep[n.dataset.p] = n;
    });
    var g = (state.payload.global && state.payload.global.counts) || {};
    var all = keep["__all__"] || el("button", "ptab");
    if (!all.dataset.p) {
      all.dataset.p = "__all__";
      all.appendChild(el("span", "dot"));
      all.appendChild(el("b", null, "すべて"));
      all.appendChild(el("span", "num"));
    }
    all.setAttribute("aria-pressed", String(state.cur === "__all__"));
    all.querySelector(".num").textContent = (g.todo || 0) + (g.doing || 0) + " 未完";
    var want = [all];
    // #84: DOING のあるボードを左へ。#54 の「選択中を2番目」はその次に回す。
    // 並べ替えは表示だけの話なので、数字キーと `key` バッジは payload の並び（i）のまま。
    // sort は stable、同 rank は元の順。
    function rank(a) {
      var s = summaryOf(a);
      if (s && s.counts && s.counts.doing > 0) return 0;   // #84: 生きているボードを左へ
      return a === state.cur ? 1 : 2;                      // #54: 選択中はその次
    }
    var slugs = boards();
    var order = slugs.slice().sort(function (a, b) { return rank(a) - rank(b); });
    var tabs = [];
    order.forEach(function (slug) {
      var i = slugs.indexOf(slug);
      var s = summaryOf(slug), b = keep[slug] || el("button", "ptab");
      if (!b.dataset.p) {
        b.dataset.p = slug;
        b.appendChild(el("span", "dot"));
        b.appendChild(document.createTextNode(slug));
        b.appendChild(el("span", "num"));
      }
      var live = !!(s && s.counts.doing > 0), fin = !!(s && s.total > 0 && s.done === s.total);
      b.title = String(i + 1);
      b.classList.toggle("doing", live);
      b.classList.remove("over"); // #84: 畳みは毎回引き直す
      b.setAttribute("aria-pressed", String(state.cur === slug));
      var dot = b.querySelector(".dot");
      dot.classList.toggle("done", fin);
      dot.classList.toggle("live", !fin && live);
      b.querySelector(".num").textContent = s ? (s.counts.todo ? "TODO " + s.counts.todo : s.done + "/" + s.total) : "—";
      var kb = b.querySelector(".key");
      if (i < 9) { if (!kb) b.appendChild(kb = el("span", "key")); kb.textContent = String(i + 1); }
      else if (kb) b.removeChild(kb);
      tabs.push(b);
      want.push(b);
    });
    // #85: 差分がある時だけ DOM を触る（無変化の poll ではノードもスクロールも動かさない）。
    var cur = Array.prototype.slice.call(nav.children), dirty = false, j;
    for (j = 0; !dirty && j < want.length; j++) if (cur[j] !== want[j]) dirty = true;
    for (j = want.length; !dirty && j < cur.length; j++) if (cur[j] !== more) dirty = true;
    if (dirty) {
      want.forEach(function (n, k) { if (nav.children[k] !== n) nav.insertBefore(n, nav.children[k] || null); });
      // want の後ろに残るのは .ptab-more だけ（畳みボタンは foldTabs の位置に任せる）
      Array.prototype.slice.call(nav.children, want.length).forEach(function (n) { if (n !== more) nav.removeChild(n); });
      nav.scrollLeft = sl;
    }
    // #84: 溢れの折り畳み。開いている時は折り返して全部出し「−」、閉じている時は入らない分を +N に。
    if (!more) more = el("button", "ptab-more");
    more.type = "button";
    more.setAttribute("aria-controls", "ptabs");
    if (state.ptabsOpen === true) {
      more.textContent = "−";
      more.setAttribute("aria-expanded", "true");
      more.setAttribute("aria-label", "タブ列を畳む");
      if (nav.lastChild !== more) nav.appendChild(more);
    } else {
      foldTabs(nav, all, tabs, more);
    }
    // #85: 並べ替えで落ちたフォーカスを戻す（消えたタブなら何もしない）。
    if (focused && focused !== nav && nav.contains(focused) && focused !== document.activeElement) focused.focus();
  }

  // #84: 幅に入らないタブに .over（display:none）を付けて、「+N」を nav の末尾に置く。
  // .ptab とは別クラス（pick の分岐に拾わせない）。隠れた数は b の textContent に入る（0 件なら外す）。
  function foldTabs(nav, all, tabs, b) {
    // 幅は「+99」で測る（実際は +N で 1〜2 桁。広めに測ればはみ出さない）。
    var cs, i, hid = 0, gap, avail, used = 0, ws = [], full = false;
    b.textContent = "+99";
    if (nav.lastChild !== b) nav.appendChild(b);
    // 計測できない局面（payload 無し / 幅 0 / 未レイアウト）は今まで通り何も隠さない。
    try { cs = getComputedStyle(nav); } catch (e) { cs = null; }
    if (!state.payload || !cs || !nav.clientWidth) { nav.removeChild(b); return null; }
    gap = parseFloat(cs.columnGap) || 6;
    // 「すべて」は常に残るので、その幅と gap も先に引く。
    avail = nav.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - b.offsetWidth - all.offsetWidth - gap;
    // 幅は先に全部読む（class を付けるたびに強制レイアウトを起こさない）
    for (i = 0; i < tabs.length; i++) ws.push(tabs[i].offsetWidth + gap);
    for (i = 0; i < tabs.length; i++) {
      // 選択中のボードだけは畳まない。今どこを編集しているか画面から消さないため。
      if (tabs[i].dataset.p === state.cur) { used += ws[i]; continue; }
      // 1つでも入らなければ以降は全部畳む（歯抜けにしない）
      if (full || used + ws[i] > avail) { tabs[i].classList.add("over"); hid += 1; full = true; }
      else used += ws[i];
    }
    if (!hid) { nav.removeChild(b); return null; }
    b.textContent = "+" + hid;
    b.setAttribute("aria-expanded", "false");
    b.setAttribute("aria-label", "残り " + hid + " 件のプロジェクトを表示");
    return b;
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

  // ---- render: 3 columns (#82: 成果物は列ではない) ----
  function colName(col) { return col.toUpperCase(); }
  function renderBoard() {
    // #78: poll のたびに #board を作り直すと img が再デコードされてチカチカする。
    // 列の中身（innerHTML）が前回と同じなら、その列のノードはそのまま残して DOM を触らない。
    var board = $("#board");
    var prev = Array.prototype.slice.call(board.children);
    var out = [];
    var rep = projReport(), cards = (rep && rep.cards) || [];
    ["todo", "doing", "done"].forEach(function (col) {
      var list = inCol(cards, col);
      var d = el("div", "col");
      var head = el("div", "colhead");
      head.appendChild(el("h2", null, colName(col)));
      // 見出しの数字は列の枚数（#82: 成果物は deliv の件数なのでここには出さない）。
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
      // #52: 他セッションの TODO は既定で出さない。集計行だけを TODO 列の上に置き、
      // 押した時だけ showOthers=1 で取りに行く（0 件なら行ごと出さない）。
      if (col === "todo") {
        var rep0 = projReport(), hid = (rep0 && rep0.hiddenTodoCount) || 0;
        if (hid > 0) {
          var ow = el("div", "othertodos");
          ow.id = "othertodos";
          var ob = el("button", null, (state.showOthers ? "▾ " : "▸ ") + "他 " + hid + " 件（他セッション）");
          ob.setAttribute("aria-pressed", String(!!state.showOthers));
          ob.title = state.showOthers ? "他セッションの TODO を隠す" : "他セッションの TODO を表示する";
          ob.onclick = function () { state.showOthers = !state.showOthers; reload(); };
          ow.appendChild(ob);
          d.appendChild(ow);
        }
      }
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
        if (id) moveCard(id, col).then(function () { toast("#" + id + " を " + colName(col) + " へ"); }, fail);
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
      d.dataset.col = col;
      var p = prev[out.length];
      // #78: applySel() がレンダ後に付ける .sel は markup に出ないので、比較前に落とす（直後に付け直される）。
      if (p) Array.prototype.forEach.call(p.querySelectorAll(".card.sel"), function (n) { n.classList.remove("sel"); });
      out.push(p && p.dataset.col === col && p.innerHTML === d.innerHTML ? p : d);
    });
    var same = out.length === prev.length;
    for (var i = 0; same && i < out.length; i++) if (out[i] !== prev[i]) same = false;
    if (!same) board.replaceChildren.apply(board, out);
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

  // ---- render: 下部帯「成果物」(#58/#82) ----
  // データは card ではなく deliv（api/kanban の project.deliverables / global.deliverables）。
  function delItems() {
    if (state.allview) return (state.payload.global && state.payload.global.deliverables) || [];
    var rep = projReport();
    return (rep && rep.deliverables) || [];
  }
  // 1 カード 1 タイル。プレビューは最初の添付（html/ref は mini iframe、動画は <video>）。
  function delBody(name, alt) {
    var body = el("div", "del-body");
    var ext = (name.split(".").pop() || "").toLowerCase();
    if (ext === "mp4" || ext === "webm") {
      var v = document.createElement("video");
      v.controls = true;
      v.preload = "metadata";
      v.src = srcOf(name);
      body.appendChild(v);
    } else if (VID.test(name)) {
      // 音声など再生できないものは attline と同じ「アイコン + 名前」。
      var f = el("div", "delfile");
      f.appendChild(el("span", null, "▸"));
      f.appendChild(el("span", null, name.length > 28 ? name.slice(0, 27) + "…" : name));
      f.appendChild(el("span", null, ext));
      body.appendChild(f);
    } else {
      body.appendChild(thumbBody(name, alt));
      // #56: 参照先が消えている場合はサムネの上に「不在」を出す（thumbBody の alt 差し替えでは
      // スレートの上に文字が出ないため、ここだけオーバーレイを自前で置く）。
      var im = body.firstChild;
      if (im && im.tagName === "IMG") {
        im.onerror = function () { if (!body.querySelector(".refbad")) body.appendChild(el("div", "refbad", "不在")); };
      }
    }
    return body;
  }
  function delTile(c) {
    var imgs = imgsOf(c), name = imgs[0];
    var t = el("div", "del-tile");
    t.dataset.deliv = c.id; // #82: 帯のタイル→成果物モーダル（card の id 空間とは別）
    // 動画はタイル内で再生できるので lightbox には載せない（.thumb を付けない）。
    if (imgs.length && !VID.test(name)) { t.classList.add("thumb"); t.dataset.lb = name; }
    var cap = el("div", "del-cap");
    cap.appendChild(el("span", "id", "#" + c.id));
    cap.appendChild(document.createTextNode(c.text || ""));
    if (state.allview && c.sid) cap.appendChild(el("span", "del-sid", c.sid));
    cap.title = c.text || "";
    t.appendChild(cap);
    // #79: 添付なしでも成果物として帯に出す（本文だけのタイル）。
    if (imgs.length) t.appendChild(delBody(name, c.text));
    else t.appendChild(el("div", "del-nobody", "添付なし"));
    // #56: 参照型（file:）の添付があるカードは右上に 1 バッジ。
    if (imgs.length && imgs.some(function (n) { return refOf(n); })) t.lastChild.appendChild(el("span", "del-ref", "\u2750"));
    // #61: hover で右上に ×。csv の index をそのまま送るので、外れるのはこの 1 枚だけ。
    if (imgs.length) {
      var at = imgs.indexOf(name);
      var x = el("span", "del-x", "\u00d7");
      x.title = "この添付を外す";
      x.onclick = function (ev) {
        // tile 自身が .thumb（クリックで lightbox）なので、ここで止めないと両方走る。
        ev.stopPropagation();
        // 横断ビューは c.sid、ボード表示は state.cur が書き先の slug。
        var p = c.sid || state.cur;
        if (!p || p === "__all__") { toast("添付を外す先のボードが定まらない"); return; }
        fetch("/api/attach/del" + qsOf({ p: p, deliv: c.id, n: at })).then(function (r) {
          if (r.status === 401) authFail();
          return r.json().then(function (j) {
            if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || "http " + r.status);
            toast("#" + c.id + " から添付 " + name + " を外した");
            refresh();
          });
        }, fail).catch(fail);
      };
      t.appendChild(x);
    }
    return t;
  }
  function renderDeliverables() {
    var box = $("#deliverables"), grid = $("#delgrid");
    // #79: 3 列化したので成果物の置き場はこの帯だけ。添付の有無に関わらず全部出す。
    var cards = delItems();
    // 打ちかけ（state.addCol）も署名に含める。含めないと + を押しても入力欄が出ない。
    var sig = String(state.addCol) + "\n" + cards.map(function (c) { return c.id + "|" + c.img + "|" + (c.sid || "") + "|" + c.text; }).join("\n");
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    clear(grid);
    if (state.addCol === "deliverable") grid.appendChild(addRow("deliverable"));
    var refs = 0;
    cards.forEach(function (c) {
      if (imgsOf(c).some(function (n) { return refOf(n); })) refs += 1;
      grid.appendChild(delTile(c));
    });
    $("#delcount").textContent = cards.length
      ? "成果物 " + cards.length + " 枚 / 参照型 " + refs + " 枚"
      : "成果物 0 枚 — ＋ で追加";
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
      ev.appendChild(document.createTextNode(" を " + colName(c.col) + " へ"));
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
    $("#footright").textContent = "API " + (p.version || "?") + " · " + (state.offline ? "接続断" : "5秒ポーリング") + " · dashboard v2.5";
  }

  // #70: 打鍵を受け付ける入力にフォーカスがある間は再描画しない（5 秒 poll で入力が消える）。
  var NO_TYPE_INPUT = /^(text|search|tel|url|email|password|number|date|datetime-local|time|month|week)$/;
  var EDIT_ZONE = "#addbar, #swline, #board, #delgrid, #rail, .modal";
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
    renderDeliverables();
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
      jobs.push(boardGet(state.cur).then(function (b) { if (b) state.board = b; }));
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
    state.addCol = null; // #75: 打ちかけの追加行は板ごとの状態。切替で持ち越さない
    state.ptabsOpen = false; // #84: 開いたタブ列は切替で閉じる（伸びたヘッダを持ち越さない）
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
      jobs.push(boardGet(slug).then(function (b) { if (b && state.cur === want) state.board = b; }));
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
    var i = document.querySelector("#board .addin, #delgrid .addin");
    if (i) i.focus();
  }
  // #75: その場追加の打ちかけは再描画で消さない。閉じる（state.addCol）と破棄（draft）を分ける。
  var addDraft = {};
  // #50: 入力欄は textarea。単行・トークン無しは従来どおり /api/add、それ以外は /api/quickadd。
  // 行頭のタブ/2 スペースは親へのインデントなので、trim せずにサーバへ渡す。
  var QA_RE = /(^|\s)(#[A-Za-z0-9._-]+|![0-9]{1,3}|due:\S+)/;
  function addRow(col) {
    var f = document.createElement("form");
    f.className = "addrow";
    var inp = document.createElement("textarea");
    inp.className = "addin";
    inp.rows = 1;
    inp.placeholder = "#proj !2 due:2026-12-01 本文　複数行可（インデントで子カード）· Ctrl+Enter で追加 · Esc で取消";
    if (addDraft[col] != null) inp.value = addDraft[col];
    inp.addEventListener("input", function () { addDraft[col] = inp.value; });
    // 空で離れたら捨てる。値が入っていれば残す（打ちかけを失わない）。
    inp.addEventListener("blur", function () { if (!inp.value.trim()) delete addDraft[col]; });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { state.addCol = null; delete addDraft[col]; render(); }
      // Enter は改行。送信は Ctrl/Cmd+Enter。
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitAdd(col, inp.value); }
    });
    f.onsubmit = function (e) { e.preventDefault(); submitAdd(col, inp.value); };
    f.appendChild(inp);
    return f;
  }
  function submitAdd(col, text) {
    var body = text || "";
    if (!body.trim()) { state.addCol = null; render(); return; }
    // #82: 成果物は card ではない。1 件だけ /api/deliv/add へ（quickadd は通さない）。
    if (col === "deliverable") {
      act("/api/deliv/add", { text: body.trim() }).then(function (r) {
        state.addCol = null;
        delete addDraft[col];
        refresh();
        toast("成果物 #" + ((r && r.deliverable && r.deliverable.id) || "?") + " を追加");
      }, fail);
      return;
    }
    var multi = body.indexOf("\n") >= 0 || QA_RE.test(body);
    var req = multi
      ? act("/api/quickadd", { text: body })
      : act("/api/add", { text: body.trim(), col: col });
    req.then(function (r) {
      state.addCol = null;
      delete addDraft[col];
      refresh();
      var added = (multi && r && r.added) || [];
      toast(added.length ? added.map(function (c) { return "#" + c.id; }).join(" ") + " を追加"
        : "#" + colName(col) + " に追加");
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

  // thumb の中身: 画像は img、html は読み込まない mini iframe（クリックで lightbox が本開）。
  function thumbBody(name, alt) {
    if (HTML.test(name)) {
      var fr = document.createElement("iframe");
      fr.className = "htmb";
      fr.setAttribute("sandbox", "allow-scripts allow-forms");
      fr.setAttribute("loading", "lazy");
      fr.setAttribute("title", alt || name);
      fr.src = srcOf(name);
      return fr;
    }
    var im = document.createElement("img");
    im.alt = alt || name;
    im.loading = "lazy";
    im.src = srcOf(name);
    // #56: 参照先が消えていたらサムネは空になる。クリック（lightbox）は残す。
    // shortcut: iframe は error を持たないので html の「不在」は空枠のまま、必要になったら
    // サーバに HEAD を投げて判定する。
    im.onerror = function () { im.alt = "不在"; im.classList.add("refbad"); };
    return im;
  }

  // ---- lightbox ----
  var lbList = function () { return Array.prototype.slice.call(document.querySelectorAll(".thumb")); };
  var lbAt = 0;
  function showLb(i) {
    var th = lbList();
    if (!th.length) return;
    lbAt = (i + th.length) % th.length;
    var name = th[lbAt].dataset.lb || "";
    var img = $("#lbimg"), fr = $("#lbif");
    if (HTML.test(name)) {
      // sandbox="allow-scripts" のみ。allow-same-origin を足すと dashboard と同一 origin に
      // なり、添付 html が cookie を読めてしまう（サーバも CSP: sandbox で二重に閉じる）。
      img.removeAttribute("src");
      img.hidden = true;
      fr.hidden = false;
      fr.src = srcOf(name);
    } else {
      var el0 = th[lbAt].querySelector("img");
      fr.removeAttribute("src");
      fr.hidden = true;
      img.hidden = false;
      img.onerror = function () { $("#lbcap").textContent = name + "  (不在)"; };
      img.src = el0 ? el0.src : srcOf(name);
    }
    $("#lbcap").textContent = name + "  (" + (lbAt + 1) + "/" + th.length + ")";
    $("#lb").setAttribute("open", "");
  }
  function closeLb() {
    $("#lb").removeAttribute("open");
    $("#lbimg").removeAttribute("src");
    $("#lbif").removeAttribute("src");
  }

  // ---- card modal (#45) ----
  function modalCard() {
    var rep = projReport(), cards = (rep && rep.cards) || [], i;
    for (i = 0; i < cards.length; i++) if (cards[i].id === state.modal) return cards[i];
    return null;
  }
  // #82: 成果物モーダルの行。card と同じ #cm を使うが、探す先と番号空間が違う。
  function delivModal() {
    var list = delItems(), i;
    for (i = 0; i < list.length; i++) if (list[i].id === state.modalDeliv) return list[i];
    return null;
  }
  function modalOpen() { return state.modal != null || state.modalDeliv != null; }
  function openDelivModal(id) {
    state.modal = null;
    state.modalDeliv = id;
    var d = delivModal();
    if (!d) { state.modalDeliv = null; return; }
    // 横断ビューは読み取り専用（削除と添付× だけ d.sid 宛で許す）。
    var ro = state.allview || !state.cur || state.cur === "__all__";
    $("#cm").classList.add("deliv");
    $("#cm-text").readOnly = ro;
    $("#cm-id").textContent = "#" + d.id;
    $("#cm-text").value = d.text || "";
    renderAtt(d);
    $("#cm").setAttribute("open", "");
    $("#cm-text").focus();
  }
  function openModal(id) {
    if (!needProj()) return;
    state.modal = id;
    state.modalDeliv = null;
    var c = modalCard();
    if (!c) { state.modal = null; return; }
    $("#cm").classList.remove("deliv");
    $("#cm-text").readOnly = false;
    $("#cm-id").textContent = "#" + c.id;
    $("#cm-text").value = c.text || "";
    $("#cm-project").value = c.project || "";
    $("#cm-labels").value = (c.labels || []).join(",");
    $("#cm-due").value = dueOf(c);
    $("#cm-estimate").value = typeof c.estimate === "number" ? String(c.estimate) : "";
    $("#cm-blocked").value = c.blocked || "";
    $("#cm-at").value = c.nextFireAt || "";
    renderPrio(c);
    renderAtt(c);
    $("#cm").setAttribute("open", "");
    $("#cm-text").focus();
  }
  function closeModal() {
    state.modal = null;
    state.modalDeliv = null;
    $("#cm").classList.remove("deliv");
    $("#cm-text").readOnly = false;
    $("#cm").removeAttribute("open");
  }
  function renderPrio(c) {
    var n = prioOf(c);
    Array.prototype.forEach.call(document.querySelectorAll("#cm [data-prio]"), function (b) {
      b.setAttribute("aria-pressed", String(Number(b.dataset.prio) === n));
    });
  }
  // ---- 添付 (#49)。/api/upload は body が生バイナリで、戻りは act() と同じ {ok,cards} ----
  // 許可拡張子はサーバの OK_EXTS（extensions/kanban.ts:328）と同じ並び。ここに無いものは
  // 送る前に断る（415 を往復させない）。サーバ側を増やしたらここも増やす。
  var UP_EXTS = ["png", "jpg", "gif", "webp", "avif", "mp4", "webm"];
  function upExtOf(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
    return m ? m[1].toLowerCase() : "";
  }
  function attBusy(on) {
    state.uploading = on;
    $("#cm-file").disabled = on;
    $("#cm-drop").classList.toggle("busy", on);
    $("#cm-attstatus").textContent = on ? "送信中…" : "";
  }
  function upFetch(url, init) {
    return fetch(url, init).then(function (r) {
      if (r.status === 401) authFail();
      return r.json().then(function (b) {
        // 失敗はサーバの文面をそのまま返す（415 拡張子 / 413 容量 / 400 板）。
        if (!r.ok || !b || b.ok === false) throw new Error((b && b.error) || "http " + r.status);
        return b;
      }, function () { throw new Error("http " + r.status); });
    });
  }
  function uploadOne(sel, file) {
    var params = { p: sel.p, ext: upExtOf(file.name) };
    if (sel.deliv != null) params.deliv = sel.deliv;
    else params.id = sel.id;
    return upFetch("/api/upload" + qsOf(params), {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file,
    });
  }
  // ---- #55: ペーストで画像を貼る ----
  // クリップボードの File は POST body ではなく dataURL にして /api/upload2 の query へ
  // （iframe 由来の小さい payload と同じ形。サーバの上限も 128KB）。
  // 添付先: モーダルのカード > 選択中（矢印キーで選ぶ state.sel）のカード > TODO に受け皿。
  var PASTE_MAX_FILE = 96 * 1024; // base64 にすると 4/3 倍 = 128KB（サーバの同じ上限）
  function pasteOne(sel, file) {
    return new Promise(function (ok, ng) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result || "")); };
      r.onerror = function () { ng(new Error("クリップボードを読めない")); };
      r.readAsDataURL(file);
    }).then(function (data) {
      var params = { p: sel.p, data: data };
      if (sel.deliv != null) params.deliv = sel.deliv;
      else params.id = sel.id;
      return upFetch("/api/upload2" + qsOf(params));
    });
  }
  function pasteTo(sel, file) {
    return pasteOne(sel, file).then(function () {
      toast((sel.deliv != null ? "成果物 #" + sel.deliv : "#" + sel.id) + " に画像を添付");
      return refresh();
    }, function (e) { toast("添付できず: " + (e && e.message ? e.message : e)); });
  }
  // 今モーダルが相手にしている行（card か deliv）。添付 API の引数はここで決める。
  function attSel() {
    if (state.modalDeliv != null) {
      var d = delivModal();
      if (!d) return null;
      // 横断ビューの書き先は d.sid（帯の × と同じ解決）。
      return { p: d.sid || state.cur, deliv: d.id };
    }
    if (state.modal != null) return { p: state.cur, id: state.modal };
    return null;
  }
  function pasteImage(file) {
    if (!file) return;
    if (file.size > PASTE_MAX_FILE) { toast("大きすぎる画像（base64 で 128KB 超）"); return; }
    var c = attSel();
    if (c) { pasteTo(c, file); return; }
    if (state.allview || !state.cur || state.cur === "__all__") { toast("ボードを選んでからペーストして"); return; }
    var sel = state.sel >= 0 ? visibleCards()[state.sel] : null;
    if (sel) { pasteTo({ p: state.cur, id: Number(sel.dataset.id) }, file); return; }
    // 選択が無いときは受け皿を 1 枚作る（ペーストだけで完結させる）。
    act("/api/add", { text: "ペースト画像", col: "todo" }).then(function (r) {
      var cards = (r && r.cards) || [];
      if (!cards.length) throw new Error("カードを作れない");
      var id = Math.max.apply(null, cards.map(function (x) { return x.id; }));
      return pasteTo({ p: state.cur, id: id }, file);
    }).then(null, function (e) { toast("添付できず: " + (e && e.message ? e.message : e)); });
  }
  document.addEventListener("paste", function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [], i;
    for (i = 0; i < items.length; i++) {
      // kind==='file' の image/* だけ拾う（テキストのペーストはそのまま通す）。
      // MIME の検証はサーバ（MIME_BY_EXT）が持つ。
      if (items[i].kind === "file" && String(items[i].type).indexOf("image/") === 0) {
        e.preventDefault();
        pasteImage(items[i].getAsFile());
        return;
      }
    }
  });
  // モーダルを閉じても送信は止めない（完了後の refresh は state.cur の盤にしか触らない）。
  function uploadFiles(files) {
    var sel = attSel();
    if (!sel) return;
    if (state.uploading) { toast("送信中… 終わるまで待って"); return; }
    var id = sel.deliv != null ? sel.deliv : sel.id, go = [], bad = [];
    var label = sel.deliv != null ? "成果物 #" + id : "#" + id;
    Array.prototype.forEach.call(files || [], function (f) {
      if (UP_EXTS.indexOf(upExtOf(f.name)) >= 0) go.push(f); else bad.push(f.name);
    });
    if (bad.length) toast("未対応の拡張子: " + bad.join(", "));
    if (!go.length) return;
    attBusy(true);
    var sent = [], err = null, chain = Promise.resolve();
    // 1 ファイル 1 リクエスト。直列にしてサーバの総量判定を並列で揺らさない。
    go.forEach(function (f) {
      chain = chain.then(function () {
        return uploadOne(sel, f).then(function () { sent.push(f.name); }, function (e) { err = e; });
      });
    });
    chain.then(function () {
      attBusy(false);
      if (sent.length) toast(label + " に " + sent.join(", ") + " を添付");
      if (err) toast("添付失敗: " + (err.message || err));
      refresh().then(function () {
        if (!modalOpen()) return;
        var c1 = state.modalDeliv != null ? delivModal() : modalCard();
        if (c1) renderAtt(c1);
      }, fail);
    });
  }
  // モーダル内の現在のサムネ。class は .thumb を使う（クリックは既存 lightbox が拾う）。
  function renderAtt(c) {
    var box = clear($("#cm-thumbs")), imgs = imgsOf(c), i;
    for (i = 0; i < imgs.length; i++) {
      var f = el("figure", "thumb");
      f.dataset.lb = imgs[i];
      if (VID.test(imgs[i])) f.appendChild(el("span", "more", "▸"));
      else f.appendChild(thumbBody(imgs[i], imgs[i]));
      box.appendChild(f);
    }
  }
  // ゾーン外に落とすとブラウザがファイルを開いて盤面が消えるので、モーダル全体で default を止める。
  function wireAttach() {
    var cm = $("#cm"), zone = $("#cm-drop"), file = $("#cm-file");
    file.addEventListener("change", function () { uploadFiles(file.files); file.value = ""; });
    cm.addEventListener("dragover", function (e) { if (modalOpen()) e.preventDefault(); });
    cm.addEventListener("drop", function (e) {
      if (!modalOpen()) return;
      e.preventDefault();
      zone.classList.remove("over");
      if (e.target === zone || (zone.contains && zone.contains(e.target))) {
        uploadFiles(e.dataTransfer && e.dataTransfer.files);
      }
    });
    zone.addEventListener("dragover", function (e) {
      if (!modalOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add("over");
    });
    zone.addEventListener("dragleave", function () { zone.classList.remove("over"); });
  }
  wireAttach();

  // 本文は /api/rename、残り（at/blocked/project/labels）は 1 本の /api/schedule。
  // due/estimate を更新する端点は無いので、この面では表示のみ（v1）。
  function saveModal() {
    // #82: 成果物モードは本文だけ（project/labels/due/estimate/loop/依存/移動/予約の欄は出ない）。
    if (state.modalDeliv != null) {
      var d = delivModal();
      if (!d) { closeModal(); return; }
      if (!needProj()) return;
      var t = $("#cm-text").value.trim();
      if (!t || t === d.text) { closeModal(); return; }
      act("/api/deliv/edit", { id: d.id, text: t }).then(function () { closeModal(); refresh(); toast("成果物 #" + d.id + " を保存"); }, fail);
      return;
    }
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
    // #77: 背景（#cm 自身）をクリックしたら閉じる。箱の中のクリックは target が子になるので閉じない。
    if (t.id === "cm") { closeModal(); return; }
    // #79: 帯の + 。summary の中なので既定の開閉を止めてから入力欄を出す。
    if (t.id === "deladd") { e.preventDefault(); addCard("deliverable"); return; }
    // #84: 溢れタブの「+N」/「−」。.ptab の pick より先に拾う。
    var more = t.closest && t.closest(".ptab-more");
    if (more) { state.ptabsOpen = !state.ptabsOpen; renderPtabs(); return; }
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
        act("/api/move", { id: c0.id, col: col }).then(function () { closeModal(); refresh(); toast("#" + c0.id + " を " + colName(col) + " へ"); }, fail);
        return;
      }
      var th0 = t.closest(".thumb");
      if (th0) { showLb(lbList().indexOf(th0)); return; }
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
      // #82: 成果物モードの削除。横断ビューでも d.sid 宛でなら許す。
      if (t.id === "cm-del" && state.modalDeliv != null) {
        var dv = delivModal();
        if (!dv) { closeModal(); return; }
        if (!dv.sid && !needProj()) return;
        if (!window.confirm("成果物 #" + dv.id + " を削除する？")) return;
        act("/api/deliv/remove", { p: dv.sid || state.cur, id: dv.id }).then(function () {
          closeModal(); refresh(); toast("成果物 #" + dv.id + " を削除");
        }, fail);
        return;
      }
      return; // モーダル内の他のクリックは下へ流さない
    }
    // #82: 帯タイルは見出し（.del-cap）だけが成果物モーダル。サムネは lightbox、添付なしは入口にしない。
    var dt = t.closest && t.closest(".del-tile");
    if (dt && t.closest(".del-cap")) { openDelivModal(Number(dt.dataset.deliv)); return; }
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

  // #84: 幅が変わったら畳み数を測り直す。render() は呼ばない（無限再描画を作らない）。
  // ドラッグ中に毎フレーム作り直すと scrollLeft とフォーカスが飛ぶので 1 フレーム 1 回に落とす。
  var ptRaf = 0;
  window.addEventListener("resize", function () {
    if (!state.payload || ptRaf) return;
    ptRaf = requestAnimationFrame(function () { ptRaf = 0; renderPtabs(); });
  });

  // プロジェクトタブ列を縦ホイールで横スクロール (shift 不要)
  document.addEventListener("wheel", function (e) {
    var t = e.target.closest ? e.target.closest(".ptabs") : null;
    // #84: 開いて折り返している時は横に流れる先が無い。ページのスクロールを奪わない。
    if (!t || t.classList.contains("open") || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    t.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  document.addEventListener("keydown", function (e) {
    // Ctrl/Cmd+K は検索欄からでも開く（入力中の打鍵は下で捨てる）
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPal(); return; }
    // #77: #cm の入力欄にフォーカスがあっても Esc で閉じる（下の input/textarea 分岐が blur で消費するため先に処理する）。
    if (e.key === "Escape" && $("#cm").hasAttribute("open")) { closeModal(); return; }
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
    if ($("#cm").hasAttribute("open")) return; // #77: 開いている間は他のキーを盤面へ流さない
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

  // #58: 第4帯の開閉は覚える（既定は開）。toggle は summary クリックで飛ぶ。
  (function () {
    var box = $("#deliverables");
    try { if (localStorage.getItem("deliverables-open") === "0") box.removeAttribute("open"); } catch (err) { void err; }
    box.addEventListener("toggle", function () {
      try { localStorage.setItem("deliverables-open", box.open ? "1" : "0"); } catch (err) { void err; }
    });
  })();

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

  // #88: sticky な列ヘッダの top を topbar の実高に合わせる。56px 決め打ちは折り返しでズレる
  // （モバイルの .toprow は 2 段に折り返し、タブ列の高さもボード数や折り畳みで変わる）。
  (function measureTopbar() {
    var tb = document.querySelector(".topbar"), put;
    if (!tb) return;
    put = function () {
      document.documentElement.style.setProperty("--topbar-h", tb.getBoundingClientRect().height + "px");
    };
    put();
    // 高さが変わった瞬間に測り直す（resize では tab 列の開閉を拾えない）
    if (window.ResizeObserver) { new ResizeObserver(put).observe(tb); }
    else { window.addEventListener("resize", put); }
  })();

  refresh().then(function () { schedule(); });
})();
