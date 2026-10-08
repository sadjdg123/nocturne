/*
 * 夜曲 Nocturne · 统一的 URL 校验（浏览器与 server.js 共用，零依赖）
 * 浏览器里挂在 window.NocturneURL；Node 里 module.exports。
 *
 * 场景区分：
 *  - nav(u)      会触发页面跳转的地址（项目的内网 / 外网地址、快捷面板打开）：只允许 http: / https:
 *  - engine(u)   搜索引擎模板：http(s) 且包含 %s
 *  - image(u)    图标图片：http(s)、本站上传的 api/icons/<id>、旧版内嵌的 data:image/*（仅为兼容迁移）
 *  - wallpaper(u) 壁纸图片地址：http(s)、旧版内嵌的 data:image/*（仅为兼容迁移）
 * 一律拒绝 javascript: / data:（非图片字段）/ file: / vbscript: / blob: 以及大小写、空白、控制字符等变体：
 * 做法是白名单——字符串本身必须以 http:// 或 https:// 开头（不先 trim、不先解码），且不含任何空白或控制字符。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NocturneURL = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var MAX = 2048;
  // C0/C1 控制字符（含 Tab / 换行）、DEL、不换行空格、零宽字符、行/段分隔符、BOM：URL 解析器会悄悄丢掉或改写它们，统统视为无效。
  // 普通空格只允许出现在中间（路径里的空格浏览器会编码；首尾空格一律拒绝）
  var BAD_CHARS = /[\u0000-\u001f\u007f-\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]/;
  var HTTP = /^https?:\/\/[^\/?#]/i;
  var ICON_REF = /^api\/icons\/[A-Za-z0-9_-]{16,64}$/;
  var DATA_IMG = /^data:image\/(png|jpe?g|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon|avif|bmp);base64,[A-Za-z0-9+\/=]+$/i;

  function str(u) { return typeof u === "string" ? u : null; }
  /** 合法的 http(s) 地址（严格：不 trim，不允许空白 / 控制字符，必须能被 URL 解析且有主机名） */
  function http(u) {
    u = str(u);
    if (!u || u.length > MAX || BAD_CHARS.test(u) || / $/.test(u) || !HTTP.test(u)) return false;
    try {
      var p = new URL(u);
      return (p.protocol === "http:" || p.protocol === "https:") && !!p.hostname;
    } catch (e) { return false; }
  }
  /** 导航地址。空字符串 = 没填（不可点击，但不算错）。返回 true / false */
  function nav(u) { return u === "" || u == null ? true : http(u); }
  /** 导航地址：合法时原样返回，否则返回 ""（渲染用：无效地址按「没有地址」处理，不可点击） */
  function safeNav(u) { return typeof u === "string" && u !== "" && http(u) ? u : ""; }
  function engine(u) {
    u = str(u);
    return !!u && u.indexOf("%s") > -1 && http(u.split("%s").join("q"));
  }
  function dataImage(u) { u = str(u); return !!u && u.length <= 4 * 1024 * 1024 && DATA_IMG.test(u); }
  function image(u) {
    if (u === "" || u == null) return true;
    u = str(u);
    return !!u && (http(u) || ICON_REF.test(u) || dataImage(u));
  }
  function wallpaper(u) {
    if (u === "" || u == null) return true;
    u = str(u);
    return !!u && (http(u) || dataImage(u));
  }

  /**
   * 检查整份配置里所有会被打开 / 加载的地址，返回问题列表（空数组 = 全部合法）：
   * [{kind:"nav"|"engine"|"image"|"wallpaper", where:"分组/项目 · 字段", id, field, value}]
   */
  function checkConfig(d) {
    var out = [];
    if (!d || typeof d !== "object") return out;
    var st = d.settings && typeof d.settings === "object" ? d.settings : {};
    (Array.isArray(st.engines) ? st.engines : []).forEach(function (e, i) {
      if (e && typeof e === "object" && !engine(e.url)) out.push({ kind: "engine", where: "搜索引擎「" + String(e.name || i + 1).slice(0, 24) + "」", id: e.id, field: "url", value: e.url });
    });
    var w = st.wallpaper;
    if (w && typeof w === "object" && w.url != null && !wallpaper(w.url)) out.push({ kind: "wallpaper", where: "壁纸", field: "wallpaper", value: w.url });
    (Array.isArray(d.groups) ? d.groups : []).forEach(function (g) {
      if (!g || typeof g !== "object") return;
      (Array.isArray(g.items) ? g.items : []).forEach(function (it) {
        if (!it || typeof it !== "object") return;
        var label = String(g.name || "").slice(0, 20) + " / " + String(it.title || "未命名").slice(0, 20);
        ["lan", "wan", "url"].forEach(function (f) {
          if (it[f] != null && !nav(it[f])) out.push({ kind: "nav", where: label + " · " + f, id: it.id, field: f, value: it[f] });
        });
        var ic = it.icon;
        if (ic && typeof ic === "object" && ic.type === "image" && !image(ic.value)) out.push({ kind: "image", where: label + " · 图标", id: it.id, field: "icon", value: ic.value });
      });
    });
    return out;
  }
  /* ---------------- 项目搜索别名 item.aliases（V1.1）：只作搜索文本，从不当作 URL / 脚本 / 命令解释 ---------------- */
  var ALIAS_MAX = 10, ALIAS_LEN = 32;
  function chars(x) { return Array.from(x).length; }
  /** 把输入（字符串：逗号 / 中文逗号 / 顿号 / 换行分隔；或数组）整理成别名数组：去首尾空白、去空、大小写不敏感去重（保留第一次出现）。不截断 */
  function normAliases(v) {
    var parts = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,，、\n\r]+/) : [];
    var out = [], seen = {};
    parts.forEach(function (x) {
      if (typeof x !== "string") return;
      x = x.replace(/\s+/g, " ").trim();
      var k = x.toLowerCase();
      if (!x || seen[k]) return;
      seen[k] = 1; out.push(x);
    });
    return out;
  }
  /** 单个项目的别名是否合法：没有（undefined）合法；否则必须是 ≤10 个、每个 1–32 字、无控制字符、无首尾空白的字符串数组。返回错误说明或 "" */
  function aliasProblem(v) {
    if (v === undefined) return "";
    if (!Array.isArray(v)) return "必须是字符串数组";
    if (v.length > ALIAS_MAX) return "最多 " + ALIAS_MAX + " 个";
    for (var i = 0; i < v.length; i++) {
      var x = v[i];
      if (typeof x !== "string") return "必须是字符串";
      if (!x.trim() || x !== x.trim()) return "不能为空或带首尾空格";
      if (chars(x) > ALIAS_LEN) return "每个最多 " + ALIAS_LEN + " 个字";
      if (BAD_CHARS.test(x.replace(/ /g, "a"))) return "含有不可见字符";
    }
    return "";
  }
  /** 整份配置里不合法的别名：[{where, id, problem}]（空数组 = 全部合法） */
  function checkAliases(d) {
    var out = [];
    (d && Array.isArray(d.groups) ? d.groups : []).forEach(function (g) {
      if (!g || typeof g !== "object") return;
      (Array.isArray(g.items) ? g.items : []).forEach(function (it) {
        if (!it || typeof it !== "object") return;
        var p = aliasProblem(it.aliases);
        if (p) out.push({ where: String(g.name || "").slice(0, 20) + " / " + String(it.title || "未命名").slice(0, 20) + " · 别名", id: it.id, problem: p });
      });
    });
    return out;
  }

  /** 便于提示的简短展示（截断、去掉控制字符） */
  function show(v) {
    var s = typeof v === "string" ? v : JSON.stringify(v);
    s = String(s).replace(/[\u0000-\u001f\u007f]/g, "?");
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  }

  return { http: http, nav: nav, safeNav: safeNav, engine: engine, image: image, wallpaper: wallpaper, dataImage: dataImage, checkConfig: checkConfig, show: show,
    ALIAS_MAX: ALIAS_MAX, ALIAS_LEN: ALIAS_LEN, normAliases: normAliases, aliasProblem: aliasProblem, checkAliases: checkAliases };
});
