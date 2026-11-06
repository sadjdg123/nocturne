/* 夜曲 Nocturne · 导入浏览器书签（V2.3）
 * 读浏览器「导出书签」得到的 HTML（Netscape Bookmark 格式：Chrome / Edge / Safari / Firefox 都是这一种），
 * 按文件夹整理成待导入的分组。纯函数，不碰 DOM、不联网；界面在 app-ui.js（设置 → 数据）。
 *   parse(html)            → [{ title, url, folder }]       只收 http(s) 地址；folder = 所在最内层文件夹名（没有文件夹为 ""）
 *   plan(list, state, opt) → { folders: [{ name, items: [{ title, url }] }], total, dup, skipped, cut }
 *                            去掉首页已经有的地址（内网 / 外网任一相同）和文件里重复的地址；最多 opt.max 个（默认 300）
 *   item(entry, uid)       → 夜曲项目 { id, title, desc, lan, wan, icon }：私有地址进 lan，其余进 wan
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NocturneBookmarks = factory();
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  var NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  function decode(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e[0] === "#") {
        var n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF) ? String.fromCodePoint(n) : "";
      }
      var v = NAMED[e.toLowerCase()]; return v === undefined ? m : v;
    });
  }
  function text(s) { return decode(String(s).replace(/<[^>]*>/g, "")).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim(); }
  function attr(tag, name) {
    var m = new RegExp("\\s" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i").exec(tag);
    return m ? decode(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]) : "";
  }
  function http(u) {
    if (typeof u !== "string" || !u || u.length > 2048 || /[\u0000-\u0020\u007f]/.test(u)) return false;
    try { var p = new URL(u); return (p.protocol === "http:" || p.protocol === "https:") && !!p.hostname; } catch (e) { return false; }
  }

  function parse(html) {
    var out = [], stack = [], pending = null, re = /<(\/?)(dl|h3|a)\b([^>]*)>([\s\S]*?)(?=<)/gi, m;
    html = String(html == null ? "" : html);
    if (html.length > 20 * 1024 * 1024) html = html.slice(0, 20 * 1024 * 1024); /* 再大的书签文件也只读前 20MB */
    while ((m = re.exec(html))) {
      var close = m[1] === "/", tag = m[2].toLowerCase();
      if (tag === "dl") {
        if (close) stack.pop();
        else { stack.push(pending); pending = null; }
      } else if (tag === "h3" && !close) {
        pending = text(m[4]) || null; /* 文件夹名：<H3> 到下一个标签之间的文字 */
      } else if (tag === "a" && !close) {
        var url = attr(m[3], "href").trim(), title = text(m[4]);
        if (!http(url)) continue; /* javascript: 小书签、file:、place: 等都不收 */
        var folder = ""; for (var i = stack.length - 1; i >= 0; i--) if (stack[i]) { folder = stack[i]; break; }
        out.push({ title: title, url: url, folder: folder });
      }
    }
    return out;
  }

  /* 地址比较：忽略协议大小写、末尾的 /、#片段；http 与 https 视为同一个网站地址 */
  function key(u) {
    try { var p = new URL(u); return (p.host.toLowerCase() + p.pathname.replace(/\/+$/, "") + p.search).replace(/^www\./, ""); } catch (e) { return String(u); }
  }
  function plan(list, state, opt) {
    var max = (opt && opt.max) || 300, have = new Set(), seen = new Set(), dup = 0, total = 0, cut = 0, byName = new Map(), order = [];
    ((state && state.groups) || []).forEach(function (g) { (g.items || []).forEach(function (i) { [i.lan, i.wan].forEach(function (u) { if (u) have.add(key(u)); }); }); });
    (list || []).forEach(function (b) {
      total++;
      var k = key(b.url);
      if (have.has(k) || seen.has(k)) { dup++; return; }
      seen.add(k);
      var name = (b.folder || "导入的书签").slice(0, 40);
      if (!byName.has(name)) { byName.set(name, []); order.push(name); }
      byName.get(name).push({ title: (b.title || "").slice(0, 60), url: b.url });
    });
    var folders = [], n = 0;
    order.forEach(function (name) {
      var items = byName.get(name), room = Math.max(0, max - n);
      if (items.length > room) { cut += items.length - room; items = items.slice(0, room); }
      n += items.length;
      if (items.length) folders.push({ name: name, items: items });
    });
    return { folders: folders, total: total, dup: dup, cut: cut, count: n };
  }

  function priv(h) {
    return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === "localhost" || /\.(local|lan|home\.arpa|internal)$/i.test(h);
  }
  function item(b, uid) {
    var u = new URL(b.url), h = u.hostname.toLowerCase(), label = h.replace(/^www\./, "").split(".")[0];
    var title = b.title || (/^\d/.test(h) ? h : label.charAt(0).toUpperCase() + label.slice(1)) || h;
    var lan = priv(h);
    /* 图标和手动添加的「自动」一样：按域名去图标库里找同名图标（找不到时显示首字母） */
    var icon = /^[a-z0-9][a-z0-9-]*$/.test(label) && !/^\d+$/.test(label) && !lan ? { type: "iconify", value: "selfhst:" + label, bg: "" } : { type: "", value: "", bg: "" };
    return { id: uid(), title: title, desc: "", lan: lan ? b.url : "", wan: lan ? "" : b.url, icon: icon };
  }

  return { parse: parse, plan: plan, item: item, key: key };
});
