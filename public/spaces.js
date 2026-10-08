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

  /* id 字典一律用无原型对象 + 自有属性判断：id / 引用 / 字段名可以是 constructor、toString、__proto__、hasOwnProperty、valueOf、prototype
   * （ID_RE 和引用规则都允许），绝不能和 Object.prototype 上的成员撞上（误判重复 / 误判存在 / 改掉字典的原型 / 调用到函数）。 */
  var HOP = Object.prototype.hasOwnProperty;
  function dict() { return Object.create(null); }
  function has(o, k) { return HOP.call(o, k); }
  function setOf(list) { var d = dict(); for (var i = 0; i < list.length; i++) d[list[i]] = true; return d; }
  var KEYS = setOf(["id", "name", "groupIds", "itemIds", "theme", "density"]);

  function len(s) { return Array.from(s).length; }
  function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
  function nameKey(s) { return String(s).trim().toLowerCase(); }

  /* ------------------------------------------------------------ 结构校验 */
  /** 结构问题清单（服务器 / 导入用）：[{where, problem}]。空数组 = 合法。只看结构，不看引用是否存在（悬空引用由 prune 处理）。
   *  opts.lenient（JSON 导入用）：重名不算错误（导入后由 normalize 加序号）。 */
  function check(data, opts) {
    var bad = [], lenient = !!(opts && opts.lenient);
    if (!isObj(data) || data.spaces === undefined) return bad;
    var sp = data.spaces;
    if (!Array.isArray(sp)) return [{ where: "spaces", problem: "必须是数组" }];
    if (sp.length > MAX_SPACES) bad.push({ where: "spaces", problem: "最多 " + MAX_SPACES + " 个空间" });
    var ids = dict(), names = dict();
    for (var i = 0; i < sp.length && bad.length < 50; i++) {
      var s = sp[i], w = "第 " + (i + 1) + " 个空间";
      if (!isObj(s)) { bad.push({ where: w, problem: "必须是对象" }); continue; }
      for (var k in s) if (has(s, k) && !has(KEYS, k)) { bad.push({ where: w, problem: "未知字段 " + String(k).slice(0, 32) }); break; }
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
      var x = { id: s.id, name: name, groupIds: Array.isArray(s.groupIds) ? s.groupIds.slice(0, MAX_REFS) : [] };
      if (Array.isArray(s.itemIds)) x.itemIds = s.itemIds.slice(0, MAX_REFS);
      if (THEMES.indexOf(s.theme) > -1) x.theme = s.theme;
      if (DENSITIES.indexOf(s.density) > -1) x.density = s.density;
      out.push(x);
    });
    data.spaces = out;
    prune(data);
    return JSON.stringify(data.spaces) !== before;
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

  /* ------------------------------------------------------------ 修改（在 App.commit 里调用，可撤销） */
  function newId(data) {
    var used = dict(); list(data).forEach(function (s) { if (typeof s.id === "string") used[s.id] = true; });
    for (;;) { var id = "s" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); if (!has(used, id) && id !== ALL) return id; }
  }
  function err(m) { var e = new Error(m); e.code = "bad_space"; return e; }
  function cleanName(data, name, exceptId) {
    var n = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "").trim() : "";
    if (!n) throw err("名称不能为空");
    if (len(n) > NAME_MAX) throw err("名称最多 " + NAME_MAX + " 个字");
    if (nameKey(n) === ALL_NAME || list(data).some(function (s) { return s.id !== exceptId && nameKey(s.name) === nameKey(n); })) throw err("已经有叫「" + n + "」的空间了");
    return n;
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
    check: check, prune: prune, normalize: normalize,
    list: list, get: get, resolve: resolve, view: view, membership: membership,
    add: add, rename: rename, remove: remove, move: move, setGroups: setGroups, pin: pin, setLook: setLook,
    selKey: selKey, readSel: readSel, writeSel: writeSel, SEL_PREFIX: SEL_PREFIX
  };
});
