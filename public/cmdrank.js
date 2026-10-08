/*
 * 夜曲 Nocturne · 命令面板的项目排序（纯函数，浏览器与 Node 测试共用，零依赖）
 * 浏览器里挂在 window.NocturneRank；Node 里 module.exports。
 *
 * 分层（高 → 低），同一层里本机「最近使用」靠前，再按细分分数、原始顺序：
 *   5 标题精确   4 标题前缀   3 别名精确 / 前缀   2 标题包含 / 模糊   1 描述或地址匹配
 * 大小写、首尾 / 连续空格不影响结果；「movie pilot」也能精确匹配「MoviePilot」。
 * 别名只作为搜索文本参与比较，从不被解释或执行。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NocturneRank = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  function norm(s) { return String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim(); }
  function tight(s) { return norm(s).replace(/ /g, ""); }
  /** 子串 / 子序列匹配：{s:分数, hits:[字符下标]} 或 null。下标按 Array.from(text) 计（中文、emoji 安全） */
  function match(text, q) {
    var chars = Array.from(String(text == null ? "" : text)), t = chars.map(function (c) { return c.toLowerCase(); }), qq = Array.from(norm(q));
    if (!qq.length) return { s: 0, hits: [] };
    var k, at = -1;
    for (k = 0; k + qq.length <= t.length; k++) {
      var ok = true;
      for (var j = 0; j < qq.length; j++) if (t[k + j] !== qq[j]) { ok = false; break; }
      if (ok) { at = k; break; }
    }
    var hits = [];
    if (at > -1) {
      for (k = 0; k < qq.length; k++) hits.push(at + k);
      return { s: 100 - Math.min(at, 30) + (at === 0 ? 40 : /[\s\-_.\/:]/.test(t[at - 1] || "") ? 20 : 0) + (t.length === qq.length ? 30 : 0), hits: hits, sub: true };
    }
    var jj = 0, last = -1, gaps = 0, qs = qq.filter(function (c) { return c !== " "; });
    for (k = 0; k < t.length && jj < qs.length; k++) {
      if (t[k] === qs[jj]) { if (last > -1) gaps += k - last - 1; hits.push(k); last = k; jj++; }
    }
    if (jj < qs.length || !qs.length) return null;
    return { s: Math.max(1, 60 - gaps * 3 - hits[0]), hits: hits, sub: false };
  }
  /**
   * 给一个项目打分。urls：要参与匹配的地址（当前推荐地址、内网、外网）。
   * 返回 null（不匹配）或 {tier, b:层内细分档, s:细分分数, hits:标题高亮下标, alias:命中的别名}
   */
  function score(item, q, urls) {
    var nq = norm(q), tq = tight(q);
    if (!nq || !item) return null;
    var title = String(item.title == null ? "" : item.title), nt = norm(title), tt = tight(title);
    var mt = match(title, nq);
    var all = function (m) { return m ? m.hits : []; };
    if (nt === nq || (tt && tt === tq)) return { tier: 5, b: 0, s: 1000, hits: all(mt) };
    if (nt.indexOf(nq) === 0 || (tt && tq && tt.indexOf(tq) === 0)) return { tier: 4, b: 0, s: 1000 - Array.from(nt).length, hits: all(mt) };
    var al = Array.isArray(item.aliases) ? item.aliases.filter(function (x) { return typeof x === "string" && x; }) : [];
    var best = null;
    al.forEach(function (a) {
      var na = norm(a), ta = tight(a);
      if (na === nq || ta === tq) { if (!best || best.b < 1) best = { b: 1, a: a }; }
      else if ((na.indexOf(nq) === 0 || (ta && tq && ta.indexOf(tq) === 0)) && !best) best = { b: 0, a: a };
    });
    if (best) return { tier: 3, b: best.b, s: 500, hits: mt ? mt.hits : [], alias: best.a };
    if (mt) return { tier: 2, b: mt.sub ? 1 : 0, s: mt.s, hits: mt.hits };
    var md = match(item.desc, nq), mu = null;
    (urls || []).forEach(function (u) { var m = u ? match(u, nq) : null; if (m && (!mu || m.s > mu.s)) mu = m; });
    var am = null;
    al.forEach(function (a) { var m = match(a, nq); if (m && m.sub && (!am || m.s > am.s)) am = { s: m.s, a: a }; }); // 别名中间包含：也算低一档的命中
    var s = Math.max(md ? md.s * 1.5 : 0, mu ? mu.s : 0, am ? am.s : 0);
    if (s > 0) return { tier: 1, b: 0, s: s, hits: [], alias: am && (!md || am.s >= md.s * 1.5) && (!mu || am.s >= mu.s) ? am.a : undefined };
    return null;
  }
  /**
   * 排序。entries：[{item, urls, ...任意}]；recent：本机最近使用的 id 数组（越前越近）。
   * 同一个 item.id 只保留一次（去重）。返回 [{entry, r}]，r 为 score() 结果。
   */
  function rank(entries, q, recent) {
    /* 按项目 id 建表：用 Map / 无原型对象（id 可以是 constructor、__proto__ 等，普通对象会读到原型上的函数或改掉原型） */
    var rpos = new Map(); (recent || []).forEach(function (id, i) { if (!rpos.has(String(id))) rpos.set(String(id), i); });
    var seen = new Set(), out = [];
    (entries || []).forEach(function (e, idx) {
      var it = e && e.item; if (!it) return;
      var key = it.id != null ? "id:" + it.id : "ix:" + idx;
      if (seen.has(key)) return; seen.add(key);
      var r = score(it, q, e.urls); if (r) out.push({ entry: e, r: r, idx: idx, rp: it.id != null && rpos.has(String(it.id)) ? rpos.get(String(it.id)) : Infinity });
    });
    out.sort(function (a, b) {
      return (b.r.tier - a.r.tier) || (b.r.b - a.r.b) || (a.rp - b.rp) || (b.r.s - a.r.s) || (a.idx - b.idx);
    });
    return out;
  }
  /* 「状态」动作的文案。NAS 模式只是读取服务端最近一次后台检测（约每 30 秒一轮）的结果，
   * 不触发新的检测，所以叫「刷新状态」，也不说「已重新检测」；纯静态模式才是浏览器里真的重新检测。 */
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function hms(iso) { var d = iso ? new Date(iso) : null; return d && !isNaN(d) ? pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) : ""; }
  /** 状态表里最新的 checkedAt（ISO 字符串，没有就是 null） */
  function latestCheck(map) {
    var best = null, bt = -Infinity;
    Object.keys(map || {}).forEach(function (k) { var c = map[k] && map[k].checkedAt, t = c ? Date.parse(c) : NaN; if (!isNaN(t) && t > bt) { bt = t; best = c; } });
    return best;
  }
  function statusAction(nas) {
    return nas
      ? { t: "刷新状态", d: "读取 NAS 最近一次检测结果", busy: "正在读取 NAS 检测结果…" }
      : { t: "重新检测状态", d: "在这个浏览器里重新检测", busy: "正在重新检测…" };
  }
  function statusReport(nas, d, checkedAt) {
    /* 浏览器探测（no-cors）分不清在线与否：只说「可能在线 / 无法确认」，不说在线 / 离线 */
    if (!nas) return "检测完成：" + (d.maybe || 0) + " 个可能在线，" + (d.unknown || 0) + " 个无法确认（浏览器检测无法确认真实状态）";
    var n = d.on + " 个在线，" + d.off + " 个离线" + ((d.maybe || 0) + (d.unknown || 0) ? "，" + ((d.maybe || 0) + (d.unknown || 0)) + " 个无法确认" : "");
    var at = hms(checkedAt);
    return "已刷新：" + n + "（NAS " + (at ? at + " 的" : "最近一次") + "检测结果）";
  }
  return { norm: norm, match: match, score: score, rank: rank, latestCheck: latestCheck, statusAction: statusAction, statusReport: statusReport };
});
