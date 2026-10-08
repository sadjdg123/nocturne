/* 夜曲 Nocturne V2.0 · Midnight Edition — 设计预览交互（阶段 0）
   纯前端模拟：数据结构与正式配置同形（settings / groups / items + spaces 引用 groupIds）。
   不访问服务器，不写正式配置；localStorage 全部 try/catch（沙盒 iframe 无存储时照常运行）。 */
(function () {
  "use strict";

  /* ───────── 模拟配置（与正式 config 同形） ───────── */
  var CONFIG = {
    settings: { name: "jingbo", engine: "google", net: "auto", wallpaper: { id: "star", dim: 35, blur: 0 } },
    groups: [
      { id: "g-media", name: "影音", style: "tile", items: [
        { id: "emby", title: "Emby", desc: "家庭影院", icon: "", lan: "http://192.168.1.20:8096", wan: "https://emby.example.com", aliases: ["em", "影院"] },
        { id: "plex", title: "Plex", desc: "媒体库", icon: "", lan: "http://192.168.1.20:32400", wan: "https://plex.example.com", aliases: [] },
        { id: "jellyfin", title: "Jellyfin", desc: "开源影音", icon: "", lan: "http://192.168.1.20:8097", wan: "https://jf.example.com", aliases: ["jf"] },
        { id: "photos", title: "Synology Photos", desc: "照片备份", icon: "", lan: "http://192.168.1.20:5080", wan: "https://photos.example.com", aliases: ["相册", "照片"] }
      ] },
      { id: "g-dl", name: "下载", style: "tile", items: [
        { id: "mp", title: "MoviePilot", desc: "影视订阅", icon: "", lan: "http://192.168.1.20:3000", wan: "https://mp.example.com", aliases: ["mp", "订阅"] },
        { id: "qb", title: "qBittorrent", desc: "下载器", icon: "", lan: "http://192.168.1.20:8085", wan: "", aliases: ["qb"] },
        { id: "tr", title: "Transmission", desc: "PT 做种", icon: "", lan: "http://192.168.1.20:9091", wan: "", aliases: ["tr"] },
        { id: "pt", title: "PT 站", desc: "站点签到", icon: "", lan: "", wan: "https://pt.example.com", aliases: ["pt", "签到"] }
      ] },
      { id: "g-nas", name: "存储", style: "tile", items: [
        { id: "dsm", title: "群晖 DSM", desc: "白色 NAS", icon: "", lan: "http://192.168.1.20:5000", wan: "https://dsm.example.com", aliases: ["dsm", "白群"] },
        { id: "xpe", title: "黑群晖", desc: "备份机", icon: "", lan: "http://192.168.1.30:5000", wan: "", aliases: ["黑群", "备份"] }
      ] },
      { id: "g-home", name: "家居", style: "tile", items: [
        { id: "ha", title: "Home Assistant", desc: "全屋智能", icon: "", lan: "http://192.168.1.40:8123", wan: "https://ha.example.com", aliases: ["ha", "家"] }
      ] },
      { id: "g-ops", name: "网络与运维", style: "tile", items: [
        { id: "kuma", title: "Uptime Kuma", desc: "服务监控", icon: "", lan: "http://192.168.1.20:3001", wan: "https://status.example.com", aliases: ["kuma", "监控"] },
        { id: "lucky", title: "Lucky", desc: "端口转发与 DDNS", icon: "", lan: "http://192.168.1.1:16601", wan: "", aliases: ["ddns"] },
        { id: "cf", title: "Cloudflare", desc: "域名与隧道", icon: "", lan: "", wan: "https://dash.cloudflare.com", aliases: ["cf"] },
        { id: "ts", title: "Tailscale", desc: "异地组网", icon: "", lan: "", wan: "https://login.tailscale.com", aliases: ["ts"] },
        { id: "vps", title: "日本 VPS", desc: "东京节点", icon: "", lan: "", wan: "https://vps.example.com", aliases: ["vps", "jp", "东京"] }
      ] },
      { id: "g-daily", name: "常用", style: "chip", items: [
        { id: "gh", title: "GitHub", desc: "代码仓库", icon: "", lan: "", wan: "https://github.com", aliases: ["gh"] },
        { id: "google", title: "Google", desc: "搜索", icon: "", lan: "", wan: "https://www.google.com", aliases: ["gg"] }
      ] }
    ],
    // V2 新增：空间只引用分组 ID，不复制项目。「全部」为虚拟空间，不存储。
    spaces: [
      { id: "s-daily", name: "日常", groupIds: ["g-daily", "g-home", "g-dl"], theme: "dawn", density: "comfortable" },
      { id: "s-fun", name: "娱乐", groupIds: ["g-media", "g-dl"], theme: "indigo", density: "poster" },
      { id: "s-nas", name: "NAS", groupIds: ["g-nas", "g-ops", "g-dl"], theme: "frost", density: "compact" }
    ]
  };
  var ALL = { id: "all", name: "全部", theme: "midnight", density: "comfortable", virtual: true };
  var THEMES = { midnight: "#7C8FB8", dawn: "#E7B467", indigo: "#9C8CE6", frost: "#8FC9D6" };

  /* 预览专用：图标色调 + 徽记 + 模拟状态（正式版用真实图标与真实检测） */
  var LOOK = {
    emby: ["#3E6E52", "E"], plex: ["#86662A", "P"], jellyfin: ["#5A4C92", "J"], photos: ["#8A5A3C", "相"],
    mp: ["#3B5A86", "MP"], qb: ["#2F5D8C", "qB"], tr: ["#7A3E48", "Tr"], pt: ["#5C5474", "PT"],
    dsm: ["#5E6A82", "DS"], xpe: ["#2B303C", "黑"], ha: ["#2D6475", "HA"],
    kuma: ["#3F6B52", "UK"], lucky: ["#7A6236", "Lu"], cf: ["#8A5530", "CF"], ts: ["#3E4660", "TS"], vps: ["#6A3E52", "日"],
    gh: ["#343B4C", "GH"], google: ["#3A5A8A", "G"]
  };
  var SIM = { // 模拟数据：ms（内网/外网）或 down
    emby: [9, 86], plex: [14, 92], jellyfin: [11, 88], photos: [16, 104], mp: [12, 96], qb: [7, 0], tr: "down", pt: [0, 168],
    dsm: [5, 74], xpe: "down", ha: [18, 110], kuma: [6, 82], lucky: [4, 0], cf: [0, 142], ts: [0, 96], vps: [0, 54], gh: [0, 88], google: [0, 72]
  };
  var RECENT = [["mp", "3 分钟前"], ["emby", "18 分钟前"], ["dsm", "1 小时前"], ["ha", "今天 08:12"]];
  var ENGINES = [["google", "Google"], ["bing", "Bing"], ["baidu", "百度"], ["github", "GitHub"]];

  /* ───────── 本机状态（不参与同步） ───────── */
  var store = {
    get: function (k, d) { try { var v = window.localStorage.getItem("nocturne.v2preview." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { window.localStorage.setItem("nocturne.v2preview." + k, JSON.stringify(v)); } catch (e) { /* 无存储：只在本次会话生效 */ } }
  };
  var params = (function () { var o = {}; (location.search.slice(1) + "&" + location.hash.slice(1)).split("&").forEach(function (p) { if (!p) return; var kv = p.split("="); o[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ""); }); return o; })();
  var savedSpaces = store.get("spaces", null);
  if (Array.isArray(savedSpaces) && !params.fresh) CONFIG.spaces = savedSpaces;
  var S = {
    space: params.space || store.get("space", "all"),
    net: store.get("net", "auto"),
    engine: store.get("engine", "google"),
    editing: false
  };
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var isCJK = function (s) { return /[\u3400-\u9fff]/.test(s); };

  var groupById = {}; var itemById = {}; var itemGroup = {};
  CONFIG.groups.forEach(function (g) { groupById[g.id] = g; g.items.forEach(function (it) { itemById[it.id] = it; itemGroup[it.id] = g; }); });

  function spacesAll() { return [ALL].concat(CONFIG.spaces); }
  function spaceById(id) { return spacesAll().filter(function (s) { return s.id === id; })[0]; }
  function groupsOf(sp) { return sp.virtual ? CONFIG.groups : sp.groupIds.map(function (id) { return groupById[id]; }).filter(Boolean); }
  function itemsOf(sp) { var out = []; groupsOf(sp).forEach(function (g) { g.items.forEach(function (it) { if (out.indexOf(it) < 0) out.push(it); }); }); return out; }
  function sharedCount(gid) { return CONFIG.spaces.filter(function (s) { return s.groupIds.indexOf(gid) >= 0; }).length; }
  if (!spaceById(S.space)) S.space = "all";

  /* 网络三态：自动 → 模拟探测内网可达 */
  function effNet() { return S.net === "auto" ? "lan" : S.net; }
  function addr(it) { var e = effNet(); if (e === "lan") return it.lan ? { u: it.lan, via: "内网" } : { u: it.wan, via: "外网" }; return it.wan ? { u: it.wan, via: "外网" } : { u: it.lan, via: "内网" }; }
  function lat(it) { var s = SIM[it.id]; if (s === "down") return null; var a = addr(it); var v = a.via === "内网" ? s[0] : s[1]; return v || (s[0] || s[1]); }
  function hostOf(u) { return u.replace(/^https?:\/\//, "").replace(/\/$/, ""); }

  function mono(it, cls) { var L = LOOK[it.id] || ["#3C4E7A", it.title.slice(0, 1)]; return '<span class="mono' + (isCJK(L[1]) ? " cjk" : "") + (cls ? " " + cls : "") + '" style="--tone:' + L[0] + '" aria-hidden="true">' + esc(L[1]) + "</span>"; }

  /* ───────── 渲染：左栏 + 手机切换器 ───────── */
  function renderSpaces() {
    var ul = $("spaces"); var ind = $("sp-ind");
    Array.prototype.slice.call(ul.querySelectorAll("li")).forEach(function (li) { li.remove(); });
    var html = spacesAll().map(function (sp) {
      return '<li><button class="sp" type="button" data-space="' + sp.id + '" aria-current="' + (sp.id === S.space) + '" style="--sw:' + THEMES[sp.theme] + '">' +
        '<span class="sw" aria-hidden="true"></span><span class="nm">' + esc(sp.name) + '</span><span class="ct">' + itemsOf(sp).length + "</span></button></li>";
    }).join("");
    ul.insertAdjacentHTML("beforeend", html); ul.appendChild(ind);
    $("sws").innerHTML = spacesAll().map(function (sp) {
      return '<button class="swc" type="button" role="tab" data-space="' + sp.id + '" aria-current="' + (sp.id === S.space) + '" aria-selected="' + (sp.id === S.space) + '" style="--sw:' + THEMES[sp.theme] + '">' +
        '<span class="sw" aria-hidden="true"></span>' + esc(sp.name) + '<span class="ct">' + itemsOf(sp).length + "</span></button>";
    }).join("") + '<button class="swc add" type="button" data-act="manage">管理空间</button>';
    moveIndicator();
  }
  function moveIndicator() {
    var b = document.querySelector('.sp[data-space="' + S.space + '"]'); if (!b) return;
    var y = b.parentNode.offsetTop + (b.offsetHeight - 22) / 2;
    $("sp-ind").style.setProperty("--y", y + "px");
  }
  function markCurrent() {
    document.querySelectorAll("[data-space]").forEach(function (b) { var on = b.getAttribute("data-space") === S.space; b.setAttribute("aria-current", on); if (b.getAttribute("role") === "tab") b.setAttribute("aria-selected", on); });
    moveIndicator();
    var chip = document.querySelector('.swc[data-space="' + S.space + '"]'), row = $("sws");
    if (chip && row && row.offsetParent) { var x = chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2; row.scrollTo({ left: Math.max(0, x), behavior: reduced ? "auto" : "smooth" }); }
  }

  /* ───────── 渲染：空间内容 ───────── */
  function tileHTML(it, density, style) {
    var s = SIM[it.id] === "down" ? "down" : "up"; var a = addr(it);
    var href = ' href="' + esc(a.u) + '" data-item="' + it.id + '" data-s="' + s + '"';
    var stTitle = s === "down" ? "离线（模拟）" : "在线（模拟）";
    if (density === "compact") {
      var l = lat(it);
      return "<a class=\"row\"" + href + ">" + mono(it) + '<span class="tx"><span class="tt">' + esc(it.title) + '</span><span class="host">' + esc(hostOf(a.u)) + "</span></span>" +
        '<span class="lat">' + (l == null ? "离线" : l + " ms") + '<span class="st" data-s="' + s + '" title="' + stTitle + '"></span></span></a>';
    }
    if (density === "poster") {
      var L = LOOK[it.id] || ["#3C4E7A", "?"]; var big = isCJK(it.title) ? it.title.slice(0, 1) : it.title.slice(0, 1).toUpperCase();
      return "<a class=\"poster\"" + href + ' style="--tone:' + L[0] + '"><span class="cv">' + mono(it) + '<span class="st" data-s="' + s + '" title="' + stTitle + '"></span><span class="big' + (isCJK(big) ? " cjk" : "") + '" aria-hidden="true">' + esc(big) + "</span></span>" +
        '<span class="cap"><span class="tt">' + esc(it.title) + '</span><span class="ds">' + esc(it.desc) + "</span></span></a>";
    }
    if (style === "chip") return "<a class=\"chip\"" + href + ">" + mono(it) + "<span>" + esc(it.title) + "</span></a>";
    return "<a class=\"it\"" + href + ">" + mono(it) + '<span class="tx"><span class="tt">' + esc(it.title) + '</span><span class="ds">' + esc(it.desc) + '</span></span><span class="st" data-s="' + s + '" title="' + stTitle + '"></span></a>';
  }
  function renderView() {
    var sp = spaceById(S.space); var gs = groupsOf(sp); var v = $("view");
    if (!gs.length) {
      v.innerHTML = '<div class="empty grp" style="--i:0"><div class="glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></div>' +
        "<h2>「" + esc(sp.name) + "」还没有分组</h2><p>空间只引用你已有的分组，不会复制项目。勾选要放进来的分组，修改项目时各空间会一起更新。</p>" +
        '<button class="btn pri" type="button" data-act="pick" data-sp="' + sp.id + '">选择分组</button></div>';
      return;
    }
    v.innerHTML = gs.map(function (g, i) {
      var style = sp.density === "comfortable" ? g.style : "tile";
      var n = sharedCount(g.id);
      var shared = sp.virtual && n > 1 ? '<span class="shared">出现在 ' + n + " 个空间</span>" : "";
      return '<section class="grp" style="--i:' + i + '" aria-labelledby="gh-' + g.id + '"><div class="gh"><h2 id="gh-' + g.id + '">' + esc(g.name) + '</h2><span class="ct">' + g.items.length + ' 项</span><span class="rule" aria-hidden="true"></span>' + shared + "</div>" +
        '<div class="' + (style === "chip" ? "chips" : "grid") + '">' + g.items.map(function (it) { return tileHTML(it, sp.density, style); }).join("") + "</div></section>";
    }).join("");
  }
  function renderHeader() {
    var sp = spaceById(S.space); var gs = groupsOf(sp); var n = itemsOf(sp).length;
    $("sp-name").textContent = sp.name;
    $("sp-sub").textContent = gs.length ? gs.length + " 个分组，" + n + " 项服务" : "还没有分组";
  }
  function renderObs() {
    var sp = spaceById(S.space); var its = itemsOf(sp);
    var down = its.filter(function (it) { return SIM[it.id] === "down"; });
    var up = its.length - down.length;
    var C = 106.8, Cm = 100.5, f = its.length ? up / its.length : 0;
    $("ring").setAttribute("stroke-dashoffset", (C * (1 - f)).toFixed(1));
    $("mring").setAttribute("stroke-dashoffset", (Cm * (1 - f)).toFixed(1));
    $("obs-n").innerHTML = its.length ? up + "<small>/ " + its.length + " 在线</small>" : "—<small>暂无服务</small>";
    $("mstat-n").textContent = up + "/" + its.length;
        $("obs-p").innerHTML = !its.length ? "这个空间还没有服务" : (down.length ? down.length + " 项离线" : "全部在线") + "<br />最近检测 " + lastCheck;
    var rows = its.map(function (it) { return { it: it, l: lat(it) }; });
    rows.sort(function (a, b) { if (a.l == null) return -1; if (b.l == null) return 1; return b.l - a.l; });
    var max = Math.max.apply(null, rows.map(function (r) { return r.l || 0; }).concat([1]));
    $("lat-h").textContent = effNet() === "lan" ? "响应延迟（按内网优先）" : "响应延迟（按外网）";
    $("lat").innerHTML = rows.slice(0, 6).map(function (r) {
      return '<li><span class="n">' + esc(r.it.title) + '</span><span class="v' + (r.l == null ? " down" : "") + '">' + (r.l == null ? "离线" : r.l + " ms") + '</span><span class="b" aria-hidden="true"><i style="--w:' + (r.l == null ? 0 : Math.max(4, Math.round(r.l / max * 100))) + '%"></i></span></li>';
    }).join("") || '<li><span class="n" style="color:var(--mist)">暂无数据</span></li>';
    $("recent").innerHTML = RECENT.map(function (r) { var it = itemById[r[0]]; return '<li><a href="' + esc(addr(it).u) + '" data-item="' + it.id + '">' + mono(it) + '<span class="n">' + esc(it.title) + "</span><time>" + r[1] + "</time></a></li>"; }).join("");
  }
  function applyTheme() {
    var sp = spaceById(S.space);
    document.body.setAttribute("data-theme", sp.theme);
    document.body.setAttribute("data-density", sp.density);
    document.querySelectorAll(".dome").forEach(function (d) {
      var on = d.getAttribute("data-t") === sp.theme;
      if (on) { d.classList.remove("is-off"); d.classList.add("is-on"); }
      else if (d.classList.contains("is-on")) { d.classList.remove("is-on"); d.classList.add("is-off"); }
    });
    var tc = document.querySelector('meta[name="theme-color"]'); if (tc) tc.setAttribute("content", "#0A0D14");
  }

  /* ───────── 标志性动效：切换空间 ───────── */
  var swapT = 0;
  function setSpace(id, opts) {
    if (!spaceById(id)) return;
    if (id === S.space && !(opts && opts.force)) return;
    S.space = id; store.set("space", id);
    try { history.replaceState(null, "", "#space=" + id); } catch (e) {}
    applyTheme(); markCurrent();
    var v = $("view"), obs = $("obs");
    var run = function () {
      var h = v.offsetHeight; v.style.minHeight = h + "px";
      renderView(); renderHeader(); renderObs();
      v.classList.remove("is-out");
      if (!reduced) { v.classList.add("is-in"); }
      obs.classList.remove("is-swap");
      // 内容区回到可见位置：只有当前滚动已越过分组顶部时才回滚
      var top = v.getBoundingClientRect().top + window.scrollY - 24;
      if (window.scrollY > top) window.scrollTo({ top: top, behavior: reduced ? "auto" : "smooth" });
      clearTimeout(swapT);
      swapT = setTimeout(function () { v.style.minHeight = ""; v.classList.remove("is-in"); }, reduced ? 0 : 460);
    };
    if (reduced) return run();
    v.classList.remove("is-in"); v.classList.add("is-out"); obs.classList.add("is-swap");
    setTimeout(run, 150);
  }

  /* ───────── 时钟（隐藏标签页时暂停） ───────── */
  var WK = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  var frozen = params.at && /^\d{4}$/.test(params.at) ? params.at : null;
  var lastCheck = "21:46";
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function tick() {
    var d = new Date();
    if (frozen) { d.setHours(+frozen.slice(0, 2), +frozen.slice(2), 8); }
    $("hh").textContent = pad(d.getHours()); $("mm").textContent = pad(d.getMinutes()); $("ss").textContent = pad(d.getSeconds());
    $("date").textContent = (d.getMonth() + 1) + "月" + d.getDate() + "日 " + WK[d.getDay()];
    var h = d.getHours();
    var g = h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
    $("greet").textContent = g + "，" + CONFIG.settings.name;
    var c = new Date(d.getTime() - 60000); lastCheck = pad(c.getHours()) + ":" + pad(c.getMinutes());
  }
  var clockT = 0;
  function startClock() { stopClock(); tick(); if (frozen) return; clockT = setTimeout(function loop() { tick(); clockT = setTimeout(loop, 1000 - (Date.now() % 1000) + 5); }, 1000 - (Date.now() % 1000) + 5); }
  function stopClock() { clearTimeout(clockT); }
  document.addEventListener("visibilitychange", function () { if (document.hidden) stopClock(); else startClock(); });

  /* ───────── 搜索引擎 ───────── */
  function renderEngines() {
    var box = $("engines"); box.querySelectorAll(".eng").forEach(function (b) { b.remove(); });
    box.insertAdjacentHTML("beforeend", ENGINES.map(function (e) { return '<button class="eng" type="button" data-eng="' + e[0] + '" aria-pressed="' + (S.engine === e[0]) + '">' + e[1] + "</button>"; }).join(""));
    var name = ENGINES.filter(function (e) { return e[0] === S.engine; })[0][1];
    $("q").placeholder = "用 " + name + " 搜索，或输入网址";
  }

  /* ───────── 浮层：统一打开/关闭、Esc、外部点击、焦点回收 ───────── */
  var open = null, returnFocus = null;
  function openLayer(el, opener) {
    if (open) closeLayer(true);
    returnFocus = opener || document.activeElement;
    var scrim = $("scrim"); scrim.hidden = false; el.hidden = false;
    // 强制一帧后加类，触发过渡
    void el.offsetWidth;
    scrim.classList.add("is-on"); el.classList.add("is-on");
    open = el;
    document.querySelectorAll('[aria-haspopup="dialog"]').forEach(function (b) { b.setAttribute("aria-expanded", el.id === "netmenu" && (b.id === "netbtn" || b.id === "netpill")); });
    var f = el.querySelector("input:not([readonly]), [aria-checked=true], button");
    if (f) setTimeout(function () { f.focus({ preventScroll: true }); }, reduced ? 0 : 30);
  }
  function closeLayer(silent) {
    if (!open) return;
    var el = open, scrim = $("scrim"); open = null;
    el.classList.remove("is-on"); scrim.classList.remove("is-on");
    document.querySelectorAll('[aria-haspopup="dialog"]').forEach(function (b) { b.setAttribute("aria-expanded", "false"); });
    setTimeout(function () { if (!el.classList.contains("is-on")) el.hidden = true; if (!open) scrim.hidden = true; }, reduced ? 0 : 240);
    if (!silent && returnFocus && returnFocus.focus) returnFocus.focus({ preventScroll: true });
  }
  $("scrim").addEventListener("click", function () { closeLayer(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && open) { e.preventDefault(); closeLayer(); return; }
    if (open && e.key === "Tab") { // 焦点留在浮层内
      var f = Array.prototype.filter.call(open.querySelectorAll("button, input, [tabindex]"), function (x) { return !x.disabled && x.offsetParent !== null; });
      if (!f.length) return; var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    }
    var typing = /INPUT|TEXTAREA/.test((document.activeElement || {}).tagName || "");
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); openPalette(); return; }
    if (!open && !typing && e.key === "/") { e.preventDefault(); openPalette(); return; }
    if (!open && e.altKey && /^[1-9]$/.test(e.key)) { var sp = spacesAll()[+e.key - 1]; if (sp) { e.preventDefault(); setSpace(sp.id); } }
  });

  /* 网络菜单 */
  var NETS = [["auto", "自动", "能连上内网时用内网地址，否则用外网域名"], ["lan", "内网", "始终打开 192.168.1.x 内网地址"], ["wan", "外网", "始终打开 example.com 外网域名"]];
  function renderNet() {
    var e = effNet();
    $("net-mode").textContent = "网络：" + NETS.filter(function (n) { return n[0] === S.net; })[0][1];
    $("net-eff").textContent = S.net === "auto" ? "已自动选择" + (e === "lan" ? "内网" : "外网") : (e === "lan" ? "固定使用内网" : "固定使用外网");
    $("netbtn").setAttribute("data-eff", e); $("netpill").setAttribute("data-eff", e);
    $("netpill-t").innerHTML = (e === "lan" ? "内网" : "外网") + (S.net === "auto" ? " <small>自动</small>" : "");
    $("netopts").innerHTML = NETS.map(function (n) { return '<button class="opt" type="button" role="radio" aria-checked="' + (S.net === n[0]) + '" data-net="' + n[0] + '"><span class="rd" aria-hidden="true"></span><span><b>' + n[1] + "</b><small>" + n[2] + "</small></span></button>"; }).join("");
    $("probe").innerHTML = "内网探测 192.168.1.20 可达，<b>5 ms</b><br />外网 dsm.example.com 可达，<b>74 ms</b>（模拟数据）";
  }
  function openNet(opener) {
    var m = $("netmenu");
    m.classList.toggle("at-top", opener && opener.id === "netpill");
    openLayer(m, opener);
  }

  /* ⌘K 命令面板：跨全部空间搜索，分层排序 + 别名 + '>' 操作 */
  var palSel = 0, palRows = [];
  function openPalette(prefill) { var p = $("pq"); p.value = prefill || ""; renderPalette(); openLayer($("pal")); }
  function hl(t, q) { if (!q) return esc(t); var i = t.toLowerCase().indexOf(q); if (i < 0) return esc(t); return esc(t.slice(0, i)) + "<mark>" + esc(t.slice(i, i + q.length)) + "</mark>" + esc(t.slice(i + q.length)); }
  var ICON_ACT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z"/></svg>';
  function actions() {
    var a = spacesAll().filter(function (s) { return s.id !== S.space; }).map(function (s) { return { k: "act", t: "切换到「" + s.name + "」", d: itemsOf(s).length + " 项服务", run: function () { setSpace(s.id); } }; });
    NETS.forEach(function (n) { if (n[0] !== S.net) a.push({ k: "act", t: "网络改为" + n[1], d: n[2], run: function () { setNet(n[0]); } }); });
    a.push({ k: "act", t: "管理空间", d: "勾选分组、重命名、调整顺序", run: function () { setTimeout(openManage, 260); } });
    a.push({ k: "act", t: "刷新状态", d: "重新读取最近一次检测结果", run: function () { toast("已读取最近一次检测结果（模拟数据）"); } });
    return a;
  }
  function renderPalette() {
    var raw = $("pq").value.trim(); var out = [];
    if (raw.charAt(0) === ">") {
      var q = raw.slice(1).trim().toLowerCase();
      var a = actions().filter(function (x) { return !q || x.t.toLowerCase().indexOf(q) >= 0 || x.d.toLowerCase().indexOf(q) >= 0; });
      if (a.length) out.push({ tier: "操作" }); a.forEach(function (x) { x.q = q; out.push(x); });
    } else {
      var q2 = raw.toLowerCase();
      if (!q2) {
        out.push({ tier: "最近使用" });
        RECENT.forEach(function (r) { out.push({ k: "item", it: itemById[r[0]], why: r[1] }); });
        out.push({ tier: "操作" });
        actions().slice(0, 2).forEach(function (x) { out.push(x); });
      } else {
        var t1 = [], t2 = [], t3 = [];
        CONFIG.groups.forEach(function (g) { g.items.forEach(function (it) {
          var tl = it.title.toLowerCase();
          if (tl.indexOf(q2) === 0) t1.push({ k: "item", it: it, q: q2, w: 0 });
          else if (tl.indexOf(q2) > 0) t1.push({ k: "item", it: it, q: q2, w: 1 });
          else { var al = (it.aliases || []).filter(function (x) { return x.toLowerCase().indexOf(q2) === 0; })[0];
            if (al) t2.push({ k: "item", it: it, alias: al });
            else if ((it.desc + " " + g.name).toLowerCase().indexOf(q2) >= 0) t3.push({ k: "item", it: it, why: g.name + "，" + it.desc });
            else if (/[\d.:]/.test(q2) && ((it.lan || "") + " " + (it.wan || "")).toLowerCase().indexOf(q2) >= 0) t3.push({ k: "item", it: it, why: "地址 " + hostOf(addr(it).u) });
          }
        }); });
        t1.sort(function (a, b) { return a.w - b.w; });
        if (t1.length) { out.push({ tier: "名称匹配" }); out = out.concat(t1); }
        if (t2.length) { out.push({ tier: "别名匹配" }); out = out.concat(t2); }
        if (t3.length) { out.push({ tier: "其他匹配" }); out = out.concat(t3); }
        out.push({ tier: "网页搜索" });
        var en = ENGINES.filter(function (e) { return e[0] === S.engine; })[0][1];
        out.push({ k: "act", t: "用 " + en + " 搜索「" + raw + "」", d: "在新标签页打开", run: function () { toast("预览中不跳转：将用 " + en + " 搜索「" + raw + "」"); } });
      }
    }
    palRows = out.filter(function (r) { return !r.tier; }); palSel = 0;
    var idx = -1;
    $("plist").innerHTML = out.length ? out.map(function (r) {
      if (r.tier) return '<p class="tier" role="presentation">' + r.tier + "</p>";
      idx++;
      if (r.k === "act") return '<button class="res" type="button" role="option" id="opt-' + idx + '" data-i="' + idx + '" aria-selected="' + (idx === 0) + '"><span class="mono act" aria-hidden="true">' + ICON_ACT + '</span><span class="tx"><span class="tt">' + hl(r.t, r.q) + '</span><span class="ds">' + esc(r.d) + '</span></span><span class="meta"></span></button>';
      var it = r.it, a = addr(it), g = itemGroup[it.id];
      var sub = r.alias ? "别名 " + r.alias + "，" + it.desc : (r.why || it.desc);
      return '<button class="res" type="button" role="option" id="opt-' + idx + '" data-i="' + idx + '" aria-selected="' + (idx === 0) + '">' + mono(it) + '<span class="tx"><span class="tt">' + hl(it.title, r.q) + '</span><span class="ds">' + esc(sub) + '</span></span><span class="meta">' + esc(g.name) + '<br /><span class="via">' + a.via + "</span></span></button>";
    }).join("") : '<p class="pal-empty">没有找到匹配的项目</p>';
    $("pq").setAttribute("aria-activedescendant", palRows.length ? "opt-0" : "");
  }
  function palMove(d) {
    if (!palRows.length) return; palSel = (palSel + d + palRows.length) % palRows.length;
    document.querySelectorAll("#plist .res").forEach(function (b) { b.setAttribute("aria-selected", +b.getAttribute("data-i") === palSel); });
    var el = $("opt-" + palSel); if (el) el.scrollIntoView({ block: "nearest" });
    $("pq").setAttribute("aria-activedescendant", "opt-" + palSel);
  }
  function palRun(i) {
    var r = palRows[i]; if (!r) return;
    closeLayer();
    if (r.k === "act") r.run(); else openItem(r.it);
  }
  $("pq").addEventListener("input", renderPalette);
  $("pq").addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); palMove(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); palMove(-1); }
    else if (e.key === "Enter") { e.preventDefault(); palRun(palSel); }
  });
  $("plist").addEventListener("click", function (e) { var b = e.target.closest(".res"); if (b) palRun(+b.getAttribute("data-i")); });
  $("plist").addEventListener("mousemove", function (e) { var b = e.target.closest(".res"); if (b && +b.getAttribute("data-i") !== palSel) palMove(+b.getAttribute("data-i") - palSel); });

  function openItem(it) { var a = addr(it); toast("预览中不跳转：将打开 " + hostOf(a.u) + "（" + a.via + "）"); }

  /* 管理空间（演示可用：勾选分组 / 重命名 / 排序 / 新建 / 删除，只影响本预览） */
  var draft = null, openRow = null;
  function openManage(focusId) {
    draft = JSON.parse(JSON.stringify(CONFIG.spaces)); openRow = focusId || (S.space !== "all" ? S.space : (draft[0] && draft[0].id));
    $("sh-h").textContent = "管理空间"; renderManage(); openLayer($("sheet"));
    if (focusId) setTimeout(function () { var r = document.querySelector('.ms[data-id="' + focusId + '"] .ck input'); if (r) r.focus(); }, reduced ? 0 : 60);
  }
  var ICON = {
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6.5 10.5L12 5l5.5 5.5"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6.5 13.5L12 19l5.5-5.5"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
  };
  function renderManage() {
    var allRow = '<div class="ms"><div class="ms-h"><span class="sw" style="--sw:' + THEMES.midnight + '"></span><input value="全部" readonly aria-label="空间名称：全部（固定）" /><span class="ct">' + itemsOf(ALL).length + ' 项</span></div><div class="ms-b"><p class="fixed">固定空间，始终显示全部分组和项目，不能删除。</p></div></div>';
    var rows = draft.map(function (s, i) {
      var isOpen = openRow === s.id; var n = 0; s.groupIds.forEach(function (gid) { if (groupById[gid]) n += groupById[gid].items.length; });
      var body = isOpen ? '<div class="ms-b" role="group" aria-label="包含的分组">' + CONFIG.groups.map(function (g) {
        return '<label class="ck"><input type="checkbox" data-g="' + g.id + '"' + (s.groupIds.indexOf(g.id) >= 0 ? " checked" : "") + ' /><span class="bx" aria-hidden="true">' + ICON.check + '</span><span class="n">' + esc(g.name) + '</span><span class="c">' + g.items.length + " 项</span></label>";
      }).join("") + '<button class="ms-del" type="button" data-del="' + s.id + '">删除这个空间（分组和项目不受影响）</button></div>' : "";
      return '<div class="ms' + (isOpen ? " is-open" : "") + '" data-id="' + s.id + '"><div class="ms-h"><span class="sw" style="--sw:' + THEMES[s.theme] + '"></span>' +
        '<input value="' + esc(s.name) + '" maxlength="12" aria-label="空间名称" data-rename="' + s.id + '" /><span class="ct">' + n + ' 项</span>' +
        '<button class="ib" type="button" data-mv="-1" data-id="' + s.id + '" aria-label="上移"' + (i === 0 ? " disabled" : "") + ">" + ICON.up + "</button>" +
        '<button class="ib" type="button" data-mv="1" data-id="' + s.id + '" aria-label="下移"' + (i === draft.length - 1 ? " disabled" : "") + ">" + ICON.down + "</button>" +
        '<button class="ib" type="button" data-toggle="' + s.id + '" aria-expanded="' + isOpen + '" aria-label="选择分组">' + ICON.more + "</button></div>" + body + "</div>";
    }).join("");
    $("sheet-b").innerHTML = '<p class="sheet-lead">空间是同一批分组的不同组合：只保存名称和引用的分组，不复制项目。同一个分组可以放进多个空间。</p>' + allRow + rows +
      '<div class="tpl"><h3>新建空间</h3><div class="tpl-row"><button type="button" data-new="日常">日常</button><button type="button" data-new="娱乐">娱乐</button><button type="button" data-new="NAS">NAS</button><button type="button" data-new="">空白空间</button></div><p>名称模板只帮你起名，不会自动猜测和移动项目；分组由你勾选。</p></div>';
    $("sheet-f").innerHTML = '<button class="btn" type="button" data-act="close">取消</button><button class="btn pri" type="button" data-act="save-spaces">保存修改</button>';
  }
  $("sheet-b").addEventListener("click", function (e) {
    var t = e.target.closest("button"); if (!t) return;
    if (t.hasAttribute("data-toggle")) { var id = t.getAttribute("data-toggle"); openRow = openRow === id ? null : id; renderManage(); var b = document.querySelector('[data-toggle="' + id + '"]'); if (b) b.focus(); return; }
    if (t.hasAttribute("data-mv")) { var i = draft.findIndex(function (s) { return s.id === t.getAttribute("data-id"); }), j = i + +t.getAttribute("data-mv"); if (j < 0 || j >= draft.length) return; var x = draft.splice(i, 1)[0]; draft.splice(j, 0, x); renderManage(); var nb = document.querySelector('.ib[data-id="' + x.id + '"][data-mv="' + t.getAttribute("data-mv") + '"]'); (nb && !nb.disabled ? nb : document.querySelector('[data-toggle="' + x.id + '"]')).focus(); return; }
    if (t.hasAttribute("data-del")) { draft = draft.filter(function (s) { return s.id !== t.getAttribute("data-del"); }); openRow = null; renderManage(); return; }
    if (t.hasAttribute("data-new")) {
      if (draft.length >= 12) { toast("最多 12 个空间"); return; }
      var base = t.getAttribute("data-new") || "新空间", name = base, k = 2;
      while (draft.some(function (s) { return s.name === name; })) name = base + " " + k++;
      var theme = { "日常": "dawn", "娱乐": "indigo", "NAS": "frost" }[base] || "midnight";
      var dens = { "娱乐": "poster", "NAS": "compact" }[base] || "comfortable";
      var nid = "s-" + Date.now().toString(36);
      draft.push({ id: nid, name: name, groupIds: [], theme: theme, density: dens }); openRow = nid; renderManage();
      var inp = document.querySelector('[data-rename="' + nid + '"]'); if (inp) { inp.focus(); inp.select(); }
    }
  });
  $("sheet-b").addEventListener("change", function (e) {
    var c = e.target; if (!c.hasAttribute("data-g")) return;
    var s = draft.filter(function (x) { return x.id === openRow; })[0]; if (!s) return; var g = c.getAttribute("data-g");
    if (c.checked) { if (s.groupIds.indexOf(g) < 0) s.groupIds.push(g); s.groupIds.sort(function (a, b) { return CONFIG.groups.findIndex(function (x) { return x.id === a; }) - CONFIG.groups.findIndex(function (x) { return x.id === b; }); }); }
    else s.groupIds = s.groupIds.filter(function (x) { return x !== g; });
    var ct = document.querySelector('.ms[data-id="' + s.id + '"] .ms-h .ct'); var n = 0; s.groupIds.forEach(function (gid) { n += groupById[gid].items.length; }); if (ct) ct.textContent = n + " 项";
  });
  $("sheet-b").addEventListener("input", function (e) { var id = e.target.getAttribute("data-rename"); if (!id) return; var s = draft.filter(function (x) { return x.id === id; })[0]; if (s) s.name = e.target.value; });
  function saveSpaces() {
    var bad = draft.filter(function (s) { return !s.name.trim(); })[0];
    if (bad) { toast("空间名称不能为空"); var i = document.querySelector('[data-rename="' + bad.id + '"]'); if (i) i.focus(); return; }
    var names = {}; for (var k = 0; k < draft.length; k++) { var nm = draft[k].name.trim(); if (names[nm] || nm === "全部") { toast("已有名为「" + nm + "」的空间"); return; } names[nm] = 1; draft[k].name = nm; }
    var newest = draft.filter(function (s) { return !CONFIG.spaces.some(function (o) { return o.id === s.id; }); }).pop();
    CONFIG.spaces = draft; draft = null; store.set("spaces", CONFIG.spaces);
    if (!spaceById(S.space)) S.space = "all";
    closeLayer(true); renderSpaces();
    toast("已保存空间");
    if (newest) setSpace(newest.id, { force: true }); else setSpace(S.space, { force: true });
    var cur = document.querySelector('.sp[data-space="' + S.space + '"]'); if (cur && cur.offsetParent) cur.focus({ preventScroll: true });
  }

  /* 设置（手机 dock）：最小可演示 */
  function openSettings() {
    $("sh-h").textContent = "设置";
    $("sheet-b").innerHTML = '<button class="set-row" type="button" data-act="manage"><span>管理空间</span><small>' + CONFIG.spaces.length + ' 个自定义空间</small></button>' +
      '<button class="set-row" type="button" data-act="net"><span>访问方式</span><small>' + $("net-mode").textContent.replace("网络：", "") + "</small></button>" +
      '<div class="set-row" role="group" aria-label="本设备外观"><span>本设备外观</span><span class="seg"><button type="button" aria-pressed="false" data-look="classic">经典</button><button type="button" aria-pressed="true" data-look="v2">新版</button></span></div>' +
      '<p class="sheet-lead" style="margin-top:16px">外观开关只保存在这台设备上，两种外观共用同一份数据和功能。预览中仅演示开关位置。</p>';
    $("sheet-f").innerHTML = '<button class="btn" type="button" data-act="close">完成</button>';
    openLayer($("sheet"));
  }

  function setNet(n) { S.net = n; store.set("net", n); renderNet(); renderView(); renderObs(); toast(n === "auto" ? "已改为自动：当前走内网" : "已改为" + (n === "lan" ? "内网" : "外网") + "访问"); }

  var toastT = 0;
  function toast(msg) { var t = $("toast"); t.textContent = msg; t.classList.add("is-on"); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("is-on"); }, 2600); }

  /* ───────── 事件委托 ───────── */
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-space],[data-act],[data-eng],[data-net],[data-item],[data-look]"); if (!t) return;
    if (t.hasAttribute("data-space")) { setSpace(t.getAttribute("data-space")); return; }
    if (t.hasAttribute("data-eng")) { S.engine = t.getAttribute("data-eng"); store.set("engine", S.engine); renderEngines(); return; }
    if (t.hasAttribute("data-net")) { closeLayer(); setNet(t.getAttribute("data-net")); return; }
    if (t.hasAttribute("data-look")) { if (t.getAttribute("data-look") === "classic") toast("正式版中切回经典外观；预览里保持新版"); return; }
    if (t.hasAttribute("data-item")) { e.preventDefault(); if (S.editing) { toast("编辑「" + itemById[t.getAttribute("data-item")].title + "」：正式版沿用现有编辑面板"); return; } if (suppressClick) { suppressClick = false; return; } openItem(itemById[t.getAttribute("data-item")]); return; }
    var a = t.getAttribute("data-act");
    if (a === "palette") openPalette();
    else if (a === "net") { if (open) closeLayer(true); openNet(t.id === "netbtn" || t.id === "netpill" ? t : (window.innerWidth < 900 ? $("netpill") : $("netbtn"))); }
    else if (a === "manage") { if (open) closeLayer(true); openManage(); }
    else if (a === "pick") openManage(t.getAttribute("data-sp"));
    else if (a === "close") closeLayer();
    else if (a === "save-spaces") saveSpaces();
    else if (a === "settings") openSettings();
    else if (a === "search") { var q = $("q"); q.focus(); var top = q.getBoundingClientRect().top + window.scrollY - 90; if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" }); }
    else if (a === "edit") { S.editing = !S.editing; document.body.classList.toggle("editing", S.editing); }
    else if (a === "edit-done") { S.editing = false; document.body.classList.remove("editing"); }
  });
  $("search").addEventListener("submit", function (e) { e.preventDefault(); var v = $("q").value.trim(); if (!v) return; var en = ENGINES.filter(function (x) { return x[0] === S.engine; })[0][1]; toast("预览中不跳转：将用 " + en + " 搜索「" + v + "」"); });

  /* 长按保留给编辑模式（与 V1.1 一致）；短按 = 打开 */
  var lpT = 0, suppressClick = false, lpXY = null;
  document.addEventListener("touchstart", function (e) {
    var t = e.target.closest("[data-item]"); if (!t || S.editing) return;
    lpXY = [e.touches[0].clientX, e.touches[0].clientY];
    lpT = setTimeout(function () { suppressClick = true; S.editing = true; document.body.classList.add("editing"); if (navigator.vibrate) try { navigator.vibrate(10); } catch (x) {} }, 520);
  }, { passive: true });
  document.addEventListener("touchmove", function (e) { if (!lpXY) return; var dx = e.touches[0].clientX - lpXY[0], dy = e.touches[0].clientY - lpXY[1]; if (dx * dx + dy * dy > 100) { clearTimeout(lpT); lpXY = null; } }, { passive: true });
  document.addEventListener("touchend", function () { clearTimeout(lpT); lpXY = null; }, { passive: true });
  document.addEventListener("contextmenu", function (e) { if (e.target.closest("[data-item]") && window.matchMedia("(hover: none)").matches) e.preventDefault(); });

  window.addEventListener("resize", function () { moveIndicator(); }, { passive: true });

  /* ───────── 启动 ───────── */
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  $("kbd-k").textContent = isMac ? "⌘K" : "Ctrl K";
  renderSpaces(); renderEngines(); renderNet(); applyTheme(); renderHeader(); renderView(); renderObs(); startClock();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveIndicator);
  setTimeout(function () { document.body.classList.remove("boot"); }, 1100);

  // 供截图脚本使用（预览专用）
  window.NocturneV2 = { setSpace: setSpace, openPalette: openPalette, openManage: openManage, openNet: function () { openNet(window.innerWidth < 900 ? $("netpill") : $("netbtn")); }, close: closeLayer, state: S, config: CONFIG };
})();
