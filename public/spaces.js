/*
 * 夜曲 Nocturne · 场景空间（V2.0）数据模型。前端（window.NocturneSpaces）与 server.js（require）共用，零依赖。
 *
 * 唯一的项目来源仍然是 data.groups[].items[]。空间只保存「空间信息 + 引用 + 显示配置」，从不复制项目：
 *   data.spaces = [{ id, name, groupIds: [分组 id…], itemIds?: [项目 id…], theme?, density? }]
 *   - 「全部」（id = "all"）是虚拟空间：不存进 data.spaces、不可删除，永远展示全部分组和全部项目。
 *   - data.spaces 不存在 = 只有「全部」（V1.1 及更早的配置）。本模块从不主动给配置加上 spaces 字段。
 *   - 空间顺序 = data.spaces 数组顺序。
 *   - 空间内的显示顺序 = 全局顺序：分组按 data.groups 的顺序，组内项目按该分组 items 的顺序；
 *     groupIds / itemIds 里的先后顺序不影响显示（只是集合）。
 *   - groupIds：整组引用（组内现在和将来的项目都在这个空间里）。
 *   - itemIds：单个项目的引用（不必带上整组）；项目移到别的分组后引用照样有效（按 id 找）。
 *     单独引用的项目显示在它当前所在分组的标题下（该分组只显示被引用的那几个项目）。
 *   - 复制项目会得到新 id，新项目不会自动加进任何 itemIds（若它所在分组整组在空间里，则随分组出现）。
 *   - 删除项目 / 分组后，悬空的引用由 prune() 清掉；删除空间只删这条空间记录，不动分组、项目、图标、壁纸。
 * 当前选中的空间是本机状态：存在 localStorage 的 nocturne.space:<账户> 里，不在 data 里、不参与同步、不产生版本号。
 *
 * 向前兼容（V2.0 阶段 2）：较新版本可能给空间加字段（例如 V2.1 的 accent）。本模块（schema 版本 SCHEMA = 1）：
 *   - 不认识的空间字段叫「扩展字段」：字段名 /^[A-Za-z][A-Za-z0-9_]{0,31}$/ 且不是 Object.prototype 上的名字；
 *     不能用 items / groups / title / url / lan / wan / icon / aliases / desc 等项目字段名（任何一层都不行：空间不是第二套项目集合）；
 *     值只能是 null / 布尔 / 有限数字 / 字符串（≤1024 字、无控制字符、不能是 javascript: / data: 等地址）/ 数组（≤64 个）/ 普通对象（≤32 个键），嵌套最多 4 层；
 *     每个空间最多 16 个扩展字段、合计 ≤4096 字节（JSON，UTF-8）。合法的扩展字段 check() 放行、normalize() 原样保留（值不改、键顺序不改），
 *     不合法的仍按畸形数据处理（check → bad_spaces；normalize → 丢掉这个字段）。
 *   - data.spacesVersion（可选，1–999 的整数）：写过这份配置的最高空间 schema 版本。add() 第一次建空间时写上 SCHEMA；
 *     更高的值原样保留。服务端据此和请求里的 caps "spaces:<N>" 判断客户端认识哪些字段（见 knownKeys / server.js reconcileSpaces）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NocturneSpaces = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var ALL = "all"; // 虚拟空间「全部」的 id（保留字，自定义空间不能用）
  var ALL_NAME = "全部";
  var MAX_SPACES = 24; // 自定义空间上限（不含「全部」）
  var NAME_MAX = 24; // 名称最多 24 个字符（按 Unicode 码点计）
  var MAX_REFS = 500; // groupIds / itemIds 各自最多 500 个引用
  var REF_MAX = 64; // 单个引用 id 最长 64 字符
  var ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  var THEMES = ["default", "dawn", "dusk", "frost"]; // 默认（中性午夜蓝）/ 晨光琥珀 / 深靛紫 / 冷霜青
  var DENSITIES = ["comfortable", "poster", "compact"]; // 舒适 / 海报卡 / 紧凑行
  var CTRL = /[\u0000-\u001f\u007f\u2028\u2029]/;
  var SCHEMA = 1; // 本模块认识的空间 schema 版本
  var KNOWN_BY_VERSION = { 1: ["id", "name", "groupIds", "itemIds", "theme", "density"] }; // 每个 schema 版本认识的空间字段
  var EXT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/, EXT_SUBKEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
  var EXT_MAX_KEYS = 16, EXT_MAX_BYTES = 4096, EXT_MAX_DEPTH = 4, EXT_MAX_STR = 1024, EXT_MAX_ARR = 64, EXT_MAX_OBJ = 32;

  /* id 字典一律用无原型对象 + 自有属性判断：id / 引用 / 字段名可以是 constructor、toString、__proto__、hasOwnProperty、valueOf、prototype
   * （ID_RE 和引用规则都允许），绝不能和 Object.prototype 上的成员撞上（误判重复 / 误判存在 / 改掉字典的原型 / 调用到函数）。 */
  var HOP = Object.prototype.hasOwnProperty;
  function dict() { return Object.create(null); }
  function has(o, k) { return HOP.call(o, k); }
  function setOf(list) { var d = dict(); for (var i = 0; i < list.length; i++) d[list[i]] = true; return d; }
  var KEYS = setOf(KNOWN_BY_VERSION[SCHEMA]);
  /** 某个 schema 版本的客户端认识的空间字段（无原型集合）。版本未知（比本模块还新）→ null（不知道它认识什么） */
  function knownKeys(v) { v = v | 0; if (v < 1) v = 1; return KNOWN_BY_VERSION[v] ? setOf(KNOWN_BY_VERSION[v]) : null; }
  function protoName(k) { return k === "prototype" || k === "__proto__" || HOP.call(Object.prototype, k); }
  /* 扩展字段不许用这些名字（任何一层）：空间不能变成第二套项目集合，也不能借扩展字段绕过 URL 白名单 / 别名限制 */
  var EXT_RESERVED = setOf(["items", "groups", "spaces", "settings", "recent", "title", "url", "lan", "wan", "icon", "aliases", "desc"]);
  var BAD_SCHEME = /^\s*(javascript|vbscript|data|file|blob)\s*:/i;
  function utf8Len(str) { var n = 0; for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c < 0xdc00) ? (i++, 4) : 3; } return n; }
  /** 扩展字段的值是否合法：返回 "" 或问题描述 */
  function extValueProblem(v, depth) {
    if (depth > EXT_MAX_DEPTH) return "嵌套超过 " + EXT_MAX_DEPTH + " 层";
    if (v === null || typeof v === "boolean") return "";
    if (typeof v === "number") return isFinite(v) ? "" : "数字不合法";
    if (typeof v === "string") return v.length > EXT_MAX_STR ? "字符串太长" : CTRL.test(v) ? "含控制字符" : BAD_SCHEME.test(v) ? "不允许脚本 / 数据地址" : "";
    if (Array.isArray(v)) {
      if (v.length > EXT_MAX_ARR) return "数组最多 " + EXT_MAX_ARR + " 项";
      for (var i = 0; i < v.length; i++) { var p = extValueProblem(v[i], depth + 1); if (p) return p; }
      return "";
    }
    if (typeof v === "object" && Object.prototype.toString.call(v) === "[object Object]") { // 普通对象（不看 realm：jsdom / 结构化克隆来的对象原型不同）
      var n = 0;
      for (var k in v) {
        if (!has(v, k)) continue;
        if (++n > EXT_MAX_OBJ) return "对象最多 " + EXT_MAX_OBJ + " 个键";
        if (!EXT_SUBKEY_RE.test(k) || protoName(k) || has(EXT_RESERVED, k)) return "键名不合法";
        var q = extValueProblem(v[k], depth + 1); if (q) return q;
      }
      return "";
    }
    return "类型不支持";
  }
  /** 一个空间的扩展字段（不认识的键）逐个检查：[{key, problem}]；另外报告数量 / 体积超限（key 为 null）。known：认识的键集合 */
  function extProblems(s, known) {
    var out = [], n = 0, bytes = 0;
    for (var k in s) {
      if (!has(s, k) || has(known, k)) continue;
      if (!EXT_KEY_RE.test(k) || protoName(k)) { out.push({ key: k, problem: "字段名不合法" }); continue; }
      if (has(EXT_RESERVED, k)) { out.push({ key: k, problem: "保留字段名，空间不能保存项目实体" }); continue; }
      var p = extValueProblem(s[k], 1);
      if (p) { out.push({ key: k, problem: p }); continue; }
      n++; bytes += utf8Len(k) + utf8Len(JSON.stringify(s[k]));
    }
    if (n > EXT_MAX_KEYS) out.push({ key: null, problem: "扩展字段最多 " + EXT_MAX_KEYS + " 个" });
    if (bytes > EXT_MAX_BYTES) out.push({ key: null, problem: "扩展字段合计最多 " + EXT_MAX_BYTES + " 字节" });
    return out;
  }
  function versionOk(v) { return typeof v === "number" && v % 1 === 0 && v >= 1 && v <= 999; }

  function len(s) { return Array.from(s).length; }
  function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
  function nameKey(s) { return String(s).trim().toLowerCase(); }

  /* ------------------------------------------------------------ 结构校验 */
  /** 结构问题清单（服务器 / 导入用）：[{where, problem}]。空数组 = 合法。只看结构，不看引用是否存在（悬空引用由 prune 处理）。
   *  opts.lenient（JSON 导入用）：重名不算错误（导入后由 normalize 加序号）。 */
  function check(data, opts) {
    var bad = [], lenient = !!(opts && opts.lenient);
    if (isObj(data) && data.spacesVersion !== undefined && !versionOk(data.spacesVersion)) bad.push({ where: "spacesVersion", problem: "必须是 1–999 的整数" });
    if (!isObj(data) || data.spaces === undefined) return bad;
    var sp = data.spaces;
    if (!Array.isArray(sp)) return bad.concat([{ where: "spaces", problem: "必须是数组" }]);
    if (sp.length > MAX_SPACES) bad.push({ where: "spaces", problem: "最多 " + MAX_SPACES + " 个空间" });
    var ids = dict(), names = dict();
    for (var i = 0; i < sp.length && bad.length < 50; i++) {
      var s = sp[i], w = "第 " + (i + 1) + " 个空间";
      if (!isObj(s)) { bad.push({ where: w, problem: "必须是对象" }); continue; }
      var ep = extProblems(s, KEYS); // 不认识的字段：较新版本加的扩展字段在限制内放行，畸形的照样拒绝
      if (ep.length) bad.push({ where: w, problem: ep[0].key == null ? ep[0].problem : "未知字段 " + String(ep[0].key).slice(0, 32) + "（" + ep[0].problem + "）" });
      if (typeof s.id !== "string" || !ID_RE.test(s.id)) bad.push({ where: w, problem: "id 只能是 1–40 位字母、数字、_ -" });
      else if (s.id === ALL) bad.push({ where: w, problem: "id \"all\" 是「全部」保留的" });
      else if (has(ids, s.id)) bad.push({ where: w, problem: "id 重复" });
      else ids[s.id] = true;
      if (typeof s.name !== "string" || !s.name.trim()) bad.push({ where: w, problem: "名称不能为空" });
      else if (len(s.name) > NAME_MAX) bad.push({ where: w, problem: "名称最多 " + NAME_MAX + " 个字" });
      else if (CTRL.test(s.name)) bad.push({ where: w, problem: "名称含控制字符" });
      else if (!lenient && (nameKey(s.name) === ALL_NAME || has(names, nameKey(s.name)))) bad.push({ where: w, problem: "名称「" + s.name.trim() + "」重复" });
      else names[nameKey(s.name)] = true;
      ["groupIds", "itemIds"].forEach(function (f) {
        var v = s[f];
        if (v === undefined && f === "itemIds") return;
        if (!Array.isArray(v)) { bad.push({ where: w, problem: f + " 必须是字符串数组" }); return; }
        if (v.length > MAX_REFS) { bad.push({ where: w, problem: f + " 最多 " + MAX_REFS + " 个" }); return; }
        for (var j = 0; j < v.length; j++) if (typeof v[j] !== "string" || !v[j] || v[j].length > REF_MAX || CTRL.test(v[j])) { bad.push({ where: w, problem: f + " 里有不合法的 id" }); return; }
      });
      if (s.theme !== undefined && THEMES.indexOf(s.theme) < 0) bad.push({ where: w, problem: "theme 只能是 " + THEMES.join(" / ") });
      if (s.density !== undefined && DENSITIES.indexOf(s.density) < 0) bad.push({ where: w, problem: "density 只能是 " + DENSITIES.join(" / ") });
    }
    return bad;
  }

  /* ------------------------------------------------------------ 引用 */
  function index(data) {
    var g = dict(), it = dict();
    var groups = isObj(data) && Array.isArray(data.groups) ? data.groups : [];
    for (var i = 0; i < groups.length; i++) {
      var x = groups[i]; if (!isObj(x) || x.id == null) continue;
      g[String(x.id)] = x;
      var items = Array.isArray(x.items) ? x.items : [];
      for (var j = 0; j < items.length; j++) if (isObj(items[j]) && items[j].id != null) it[String(items[j].id)] = x;
    }
    return { groups: g, items: it };
  }
  function cleanRefs(list, exists) {
    var seen = dict(), out = [];
    for (var i = 0; i < list.length; i++) { var v = list[i]; if (typeof v !== "string" || has(seen, v) || !has(exists, v)) continue; seen[v] = true; out.push(v); }
    return out;
  }
  /** 清掉悬空 / 重复的引用（被删的分组、被删的项目）。原地修改，返回清掉的引用个数。没有 spaces 字段时什么也不做。
   *  只删引用，不删空间（空空间照样保留）。结构不合法的空间不在这里处理（见 normalize）。 */
  function prune(data) {
    if (!isObj(data) || !Array.isArray(data.spaces)) return 0;
    var ix = index(data), n = 0;
    data.spaces.forEach(function (s) {
      if (!isObj(s)) return;
      ["groupIds", "itemIds"].forEach(function (f) {
        if (!Array.isArray(s[f])) return;
        var next = cleanRefs(s[f], f === "groupIds" ? ix.groups : ix.items);
        if (next.length !== s[f].length) { n += s[f].length - next.length; s[f] = next; }
      });
    });
    return n;
  }

  /** 前端加载 / 导入时的宽松清洗（不抛错、不崩溃）：丢掉无法修复的空间（不是对象、id 不合法或重复、超出上限）、
   *  名称修剪 / 截断 / 重名加序号、去掉非法 theme/density 和未知字段、清悬空引用。原地修改，返回是否有改动。
   *  没有 spaces 字段时什么也不做（不会给旧配置凭空加字段）。 */
  function normalize(data) {
    if (!isObj(data) || data.spaces === undefined) return false;
    var before = JSON.stringify(data.spaces);
    if (!Array.isArray(data.spaces)) { delete data.spaces; return true; }
    var ids = dict(), names = dict(), out = [];
    data.spaces.forEach(function (s) {
      if (out.length >= MAX_SPACES || !isObj(s) || typeof s.id !== "string" || !ID_RE.test(s.id) || s.id === ALL || has(ids, s.id)) return;
      ids[s.id] = true;
      var name = typeof s.name === "string" ? s.name.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "").trim() : "";
      if (len(name) > NAME_MAX) name = Array.from(name).slice(0, NAME_MAX).join("").trim();
      if (!name) name = "未命名空间";
      var base = name, k = 2;
      while (nameKey(name) === ALL_NAME || has(names, nameKey(name))) { var suf = " " + k++; name = Array.from(base).slice(0, NAME_MAX - suf.length).join("").trim() + suf; }
      names[nameKey(name)] = true;
      /* 按原来的键顺序重建：认识的字段清洗，合法的扩展字段（较新版本加的）原样保留，畸形的扩展字段丢掉 */
      var badExt = dict(), x = {}, extN = 0, extBytes = 0;
      extProblems(s, KEYS).forEach(function (p) { if (p.key != null) badExt[p.key] = true; });
      for (var key in s) {
        if (!has(s, key)) continue;
        if (key === "id") x.id = s.id;
        else if (key === "name") x.name = name;
        else if (key === "groupIds") x.groupIds = Array.isArray(s.groupIds) ? s.groupIds.slice(0, MAX_REFS) : [];
        else if (key === "itemIds") { if (Array.isArray(s.itemIds)) x.itemIds = s.itemIds.slice(0, MAX_REFS); }
        else if (key === "theme") { if (THEMES.indexOf(s.theme) > -1) x.theme = s.theme; }
        else if (key === "density") { if (DENSITIES.indexOf(s.density) > -1) x.density = s.density; }
        else if (!has(badExt, key)) {
          var sz = utf8Len(key) + utf8Len(JSON.stringify(s[key]));
          if (extN >= EXT_MAX_KEYS || extBytes + sz > EXT_MAX_BYTES) continue; // 超出预算的扩展字段丢掉（服务器也不会收）
          extN++; extBytes += sz; x[key] = JSON.parse(JSON.stringify(s[key]));
        }
      }
      if (!has(x, "name")) x.name = name;
      if (!has(x, "groupIds")) x.groupIds = [];
      out.push(x);
    });
    data.spaces = out;
    prune(data);
    var changed = JSON.stringify(data.spaces) !== before;
    if (data.spacesVersion !== undefined && !versionOk(data.spacesVersion)) { delete data.spacesVersion; changed = true; }
    return changed;
  }

  /* ------------------------------------------------------------ 读取 */
  function list(data) { return isObj(data) && Array.isArray(data.spaces) ? data.spaces.filter(isObj) : []; }
  function get(data, id) { if (id === ALL) return null; var l = list(data); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  /** 本机记住的空间 id 是否还有效；无效（被删 / 别的账户的 / 乱写的）→ "all" */
  function resolve(data, id) { return typeof id === "string" && get(data, id) ? id : ALL; }
  /** 某个空间要显示的内容（全局顺序）：[{group, items, whole}]。items 是 data 里的同一批对象（不是副本）。
   *  "all" 或不存在的空间 → 全部分组、全部项目。分组整组在空间里 → whole:true；只因单独引用的项目出现 → 只含这些项目。 */
  function view(data, id) {
    var groups = isObj(data) && Array.isArray(data.groups) ? data.groups : [];
    var s = get(data, id);
    if (!s) return groups.filter(isObj).map(function (g) { return { group: g, items: Array.isArray(g.items) ? g.items : [], whole: true }; });
    var gs = dict(), is = dict();
    (Array.isArray(s.groupIds) ? s.groupIds : []).forEach(function (x) { if (typeof x === "string") gs[x] = true; });
    (Array.isArray(s.itemIds) ? s.itemIds : []).forEach(function (x) { if (typeof x === "string") is[x] = true; });
    var out = [];
    groups.forEach(function (g) {
      if (!isObj(g)) return;
      var items = Array.isArray(g.items) ? g.items : [];
      if (g.id != null && has(gs, String(g.id))) out.push({ group: g, items: items, whole: true });
      else {
        var pick = items.filter(function (i) { return isObj(i) && i.id != null && has(is, String(i.id)); });
        if (pick.length) out.push({ group: g, items: pick, whole: false });
      }
    });
    return out;
  }
  /** 每个分组出现在哪些自定义空间里：{groupId: [spaceId…]}（管理界面「出现在 N 个空间」用）。
   *  返回无原型对象：m["constructor"] 只在真有这个分组 id 时才有值。 */
  function membership(data) {
    var m = dict();
    list(data).forEach(function (s) {
      (Array.isArray(s.groupIds) ? s.groupIds : []).forEach(function (g) {
        if (typeof g !== "string") return;
        if (!has(m, g)) m[g] = [];
        if (m[g].indexOf(s.id) < 0) m[g].push(s.id);
      });
    });
    return m;
  }

  /** 某个项目在这个空间里是否可见（"all" 永远可见） */
  function itemVisible(data, id, itemId) {
    if (!get(data, id)) return true;
    var v = view(data, id);
    for (var i = 0; i < v.length; i++) for (var j = 0; j < v[i].items.length; j++) if (v[i].items[j] && String(v[i].items[j].id) === String(itemId)) return true;
    return false;
  }
  /** 分组是否整组在这个空间里（"all" 永远是） */
  function groupInSpace(data, id, groupId) {
    var s = get(data, id); if (!s) return true;
    return (Array.isArray(s.groupIds) ? s.groupIds : []).indexOf(String(groupId)) > -1;
  }
  /** 切换器 / 管理界面用的数量：{groups: 显示的分组数, items: 显示的项目数} */
  function stats(data, id) {
    var v = view(data, id), n = 0; v.forEach(function (e) { n += e.items.length; });
    return { groups: v.length, items: n };
  }

  /**
   * 拖动排序（编辑模式）：order = 界面上「看得见的」分组与项目拖完之后的顺序 [{gid, ids:[项目 id…]}]。
   * 规则 = 统一的全局顺序：在某个空间里拖动只改变「看得见的这些」彼此之间的先后，
   *   - 分组：看得见的分组依次填回它们原来在 data.groups 里占的位置；看不见的分组位置不动。
   *   - 项目：分组里看不见的项目（只在部分显示的分组里才有）跟着它前面那个看得见的项目走（开头的留在开头）；
   *     从别的分组拖进来的项目插在拖到的位置；拖走的项目从原分组删掉（它后面跟着的看不见的项目并到前一段）。
   *   - 在「全部」里（全部可见）就是普通的整体重排，与 V1.1 一致。
   * 任何项目都不会丢：界面上没出现、又不在原位的项目放回原分组末尾。原地修改，返回是否有变化。
   */
  function reorder(data, order) {
    if (!isObj(data) || !Array.isArray(data.groups) || !Array.isArray(order)) return false;
    var before = JSON.stringify(data.groups.map(function (g) { return [g && g.id, (g && Array.isArray(g.items) ? g.items : []).map(function (i) { return i && i.id; })]; }));
    var gById = dict(), itemById = dict(), homeOf = dict();
    data.groups.forEach(function (g) {
      if (!isObj(g) || g.id == null) return;
      gById[String(g.id)] = g;
      (Array.isArray(g.items) ? g.items : []).forEach(function (it) { if (isObj(it) && it.id != null) { itemById[String(it.id)] = it; homeOf[String(it.id)] = String(g.id); } });
    });
    var visG = [], seenG = dict(), visI = dict(), claimed = dict();
    order.forEach(function (o) {
      if (!o || o.gid == null) return; var gid = String(o.gid);
      if (!has(gById, gid) || has(seenG, gid)) return;
      seenG[gid] = true;
      var ids = [];
      (Array.isArray(o.ids) ? o.ids : []).forEach(function (x) { x = String(x); if (has(itemById, x) && !has(claimed, x)) { claimed[x] = true; visI[x] = true; ids.push(x); } });
      visG.push({ gid: gid, ids: ids });
    });
    /* 1. 分组：看得见的分组填回原来的位置 */
    var slots = []; data.groups.forEach(function (g, i) { if (isObj(g) && g.id != null && has(seenG, String(g.id))) slots.push(i); });
    var groups = data.groups.slice();
    slots.forEach(function (pos, k) { groups[pos] = gById[visG[k].gid]; });
    /* 2. 项目：按分组重建 */
    var newItems = dict();
    visG.forEach(function (o) {
      var g = gById[o.gid], old = Array.isArray(g.items) ? g.items : [];
      var lead = [], trail = dict(), last = null;
      old.forEach(function (it) {
        var id = isObj(it) && it.id != null ? String(it.id) : null;
        if (id != null && has(visI, id)) {
          if (o.ids.indexOf(id) > -1) { last = id; trail[id] = []; }
          /* 被拖走的可见项目：它后面跟着的看不见的项目并到前一段（last 不变） */
        } else if (last == null) lead.push(it); else trail[last].push(it);
      });
      var out = lead.slice();
      o.ids.forEach(function (id) { out.push(itemById[id]); if (has(trail, id)) out = out.concat(trail[id]); });
      newItems[o.gid] = out;
    });
    groups.forEach(function (g) {
      if (!isObj(g) || g.id == null || !has(newItems, String(g.id))) return;
      g.items = newItems[String(g.id)];
    });
    /* 3. 看得见、却没出现在任何分组里的项目（不应发生）：放回原分组末尾，绝不丢 */
    var placed = dict();
    groups.forEach(function (g) { (isObj(g) && Array.isArray(g.items) ? g.items : []).forEach(function (it) { if (isObj(it) && it.id != null) placed[String(it.id)] = true; }); });
    for (var id in itemById) if (has(itemById, id) && !has(placed, id)) { var h = gById[homeOf[id]]; if (h) { if (!Array.isArray(h.items)) h.items = []; h.items.push(itemById[id]); } }
    data.groups = groups;
    var after = JSON.stringify(data.groups.map(function (g) { return [g && g.id, (g && Array.isArray(g.items) ? g.items : []).map(function (i) { return i && i.id; })]; }));
    return after !== before;
  }

  /* ------------------------------------------------------------ 修改（在 App.commit 里调用，可撤销） */
  function newId(data) {
    var used = dict(); list(data).forEach(function (s) { if (typeof s.id === "string") used[s.id] = true; });
    for (;;) { var id = "s" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); if (!has(used, id) && id !== ALL) return id; }
  }
  function err(m) { var e = new Error(m); e.code = "bad_space"; return e; }
  /** 名称校验（界面实时提示用，与 check() / 服务器规则一致）：返回 "" 或提示文字。exceptId：重命名时排除自己 */
  function nameProblem(data, name, exceptId) {
    var n = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "").trim() : "";
    if (!n) return "名称不能为空";
    if (len(n) > NAME_MAX) return "名称最多 " + NAME_MAX + " 个字";
    if (nameKey(n) === ALL_NAME) return "「" + ALL_NAME + "」是保留名称";
    if (list(data).some(function (s) { return s.id !== exceptId && nameKey(s.name) === nameKey(n); })) return "已经有叫「" + n + "」的空间了";
    return "";
  }
  function cleanName(data, name, exceptId) {
    var p = nameProblem(data, name, exceptId); if (p) throw err(p);
    return name.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "").trim();
  }
  /** 新建空间，返回 id。opts: {name, groupIds?, itemIds?, theme?, density?}。第一次新建时才给配置加上 spaces 字段。 */
  function add(data, opts) {
    opts = opts || {};
    if (list(data).length >= MAX_SPACES) throw err("最多 " + MAX_SPACES + " 个空间");
    var s = { id: newId(data), name: cleanName(data, opts.name), groupIds: Array.isArray(opts.groupIds) ? opts.groupIds.slice() : [] };
    if (Array.isArray(opts.itemIds)) s.itemIds = opts.itemIds.slice();
    if (opts.theme !== undefined) { if (THEMES.indexOf(opts.theme) < 0) throw err("theme 不合法"); s.theme = opts.theme; }
    if (opts.density !== undefined) { if (DENSITIES.indexOf(opts.density) < 0) throw err("density 不合法"); s.density = opts.density; }
    if (!Array.isArray(data.spaces)) data.spaces = [];
    if (!versionOk(data.spacesVersion) || data.spacesVersion < SCHEMA) data.spacesVersion = SCHEMA; // 只升不降：更高的版本号原样保留
    data.spaces.push(s);
    prune(data);
    return s.id;
  }
  function rename(data, id, name) { var s = get(data, id); if (!s) throw err("空间不存在"); s.name = cleanName(data, name, id); }
  /** 删除空间：只删这条记录（不动分组、项目、图标、壁纸）。删到一个不剩时保留空数组 spaces: []（表示「用户明确没有自定义空间」）。 */
  function remove(data, id) {
    if (id === ALL) throw err("「全部」不能删除");
    var l = Array.isArray(data.spaces) ? data.spaces : [], i = l.findIndex(function (s) { return isObj(s) && s.id === id; });
    if (i < 0) return false;
    l.splice(i, 1); return true;
  }
  /** 调整空间顺序：把 id 移到第 to 位（0 起） */
  function move(data, id, to) {
    var l = Array.isArray(data.spaces) ? data.spaces : [], i = l.findIndex(function (s) { return isObj(s) && s.id === id; });
    if (i < 0) return false;
    var s = l.splice(i, 1)[0]; to = Math.max(0, Math.min(l.length, to | 0)); l.splice(to, 0, s); return true;
  }
  function setGroups(data, id, groupIds) { var s = get(data, id); if (!s) throw err("空间不存在"); s.groupIds = (groupIds || []).slice(0, MAX_REFS); prune(data); }
  function pin(data, id, itemId, on) {
    var s = get(data, id); if (!s) throw err("空间不存在");
    var l = Array.isArray(s.itemIds) ? s.itemIds.filter(function (x) { return x !== itemId; }) : [];
    if (on !== false) l.push(itemId);
    s.itemIds = l.slice(0, MAX_REFS); prune(data);
  }
  function setLook(data, id, look) {
    var s = get(data, id); if (!s) throw err("空间不存在");
    look = look || {};
    if (has(look, "theme")) { if (look.theme == null) delete s.theme; else if (THEMES.indexOf(look.theme) > -1) s.theme = look.theme; else throw err("theme 不合法"); }
    if (has(look, "density")) { if (look.density == null) delete s.density; else if (DENSITIES.indexOf(look.density) > -1) s.density = look.density; else throw err("density 不合法"); }
  }

  /* ------------------------------------------------------------ 本机当前空间（不同步） */
  var SEL_PREFIX = "nocturne.space:";
  /** 本机存储键：每个账户一个（NAS 模式 = 账户名小写；纯静态页 = "~local"）。换账户读不到上一个账户的选择。 */
  function selKey(owner) { return SEL_PREFIX + (owner ? String(owner).toLowerCase() : "~local"); }
  function readSel(storage, owner, data) {
    var v = null; try { v = storage && storage.getItem(selKey(owner)); } catch (e) { v = null; }
    return resolve(data, v);
  }
  function writeSel(storage, owner, id) {
    try { if (!storage) return; if (!id || id === ALL) storage.removeItem(selKey(owner)); else storage.setItem(selKey(owner), String(id)); } catch (e) { /* 存储被禁用：只在内存里 */ }
  }

  return {
    ALL: ALL, ALL_NAME: ALL_NAME, MAX_SPACES: MAX_SPACES, NAME_MAX: NAME_MAX, MAX_REFS: MAX_REFS, ID_RE: ID_RE, THEMES: THEMES, DENSITIES: DENSITIES,
    SCHEMA: SCHEMA, knownKeys: knownKeys, extProblems: extProblems,
    EXT: { KEY_RE: EXT_KEY_RE, MAX_KEYS: EXT_MAX_KEYS, MAX_BYTES: EXT_MAX_BYTES, MAX_DEPTH: EXT_MAX_DEPTH },
    check: check, prune: prune, normalize: normalize, nameProblem: nameProblem,
    list: list, get: get, resolve: resolve, view: view, membership: membership, itemVisible: itemVisible, groupInSpace: groupInSpace, stats: stats, reorder: reorder,
    add: add, rename: rename, remove: remove, move: move, setGroups: setGroups, pin: pin, setLook: setLook,
    selKey: selKey, readSel: readSel, writeSel: writeSel, SEL_PREFIX: SEL_PREFIX
  };
});
