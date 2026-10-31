  var LS_SCROLL = "kb-scroll", LS_OPEN = "kb-open";
  var MAX_CARD_OPEN = 40;      // 展開状態を覚えるカードの上限（超えたら挿入順の古い方から捨てる）
  var SCROLL_DEBOUNCE_MS = 150; // 毎スクロールで書かない。書き込みは止まってから
  // localStorage は信用しない。壊れた JSON / 配列 / null は「保存なし」に落とす。
  function memParse(raw){
    if (raw == null) return null;
    try {
      var v = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch (e) { return null; }
  }
  function memRead(key){
    try { return memParse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function memWrite(key, val){
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function memLoad(key, ns){
    var all = memRead(key), v = all && all[ns];
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  }
  function memSave(key, ns, obj){
    var all = memRead(key) || {};
    all[ns] = obj;
    memWrite(key, all);
  }
  // 列が縮んだときに下の空白へ飛ばないよう、今の最大スクロール量に丸める。
  function memClamp(v, scrollHeight, clientHeight){
    if (typeof v !== "number" || !isFinite(v) || v <= 0) return 0;
    var sh = typeof scrollHeight === "number" && isFinite(scrollHeight) ? scrollHeight : 0;
    var ch = typeof clientHeight === "number" && isFinite(clientHeight) ? clientHeight : 0;
    var max = sh - ch;
    if (!(max > 0)) return 0;
    return v > max ? max : v;
  }
  // 記憶する価値のある展開か。DONE は数十枚あり容量も食うので対象外（閉じた状態に戻す）。
  function memKeepable(ckey){
    return /:(todo|doing)$/.test(String(ckey || ""));
  }
  // 保存前に掃除: DONE を落とし、上限を超えた分は挿入順の古い方から捨てる。
  function memCompactCards(obj, max){
    var out = {}, keys = Object.keys(obj || {}), n = keys.length;
    if (max == null) max = MAX_CARD_OPEN;
    for (var i = 0; i < n; i++){
      if (!memKeepable(keys[i].split("#")[0])) continue;
      if (obj[keys[i]] !== true) continue;
      out[keys[i]] = true;
    }
    keys = Object.keys(out);
    for (var j = 0; j + max < keys.length; j++) delete out[keys[j]];
    return out;
  }
  // 消えたカードの id を保存から落とす（列単位。消えたときだけ true を返す）。
  function memPruneColumn(obj, ckey, ids){
    var live = {}, pruned = false, prefix = ckey + "#";
    (ids || []).forEach(function(id){ live[prefix + id] = true; });
    Object.keys(obj || {}).forEach(function(k){
      if (k.indexOf(prefix) === 0 && !live[k]) { delete obj[k]; pruned = true; }
    });
    return pruned;
  }
