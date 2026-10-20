/* 夜曲 · 核心 window.App（在 nocturne.js 之前）：原 index.html 内联脚本（顺序不变，每段仍是独立 IIFE）。改内容必须同时改 index.html 里的 ?v=（test/csp.test.js 校验为内容 sha256 前 10 位）。 */
(function () {
  "use strict";
  var KEY = "yeqv.v1";
  var $ = function (id) { return document.getElementById(id); };
  var U = window.NocturneURL; /* urlcheck.js：统一的 URL 白名单校验 */
  var SP = window.NocturneSpaces; /* spaces.js：V2.0 场景空间模型（只引用分组 / 项目 id） */
  var CS = window.NocturneConfigShape;

  /* 按 id / 地址建表一律用无原型对象（dict）或 Map / Set：项目 / 分组 id 可以是 constructor、__proto__、toString 等（手工导入的 JSON），
   * 普通对象会读到 Object.prototype 上的函数、或被 __proto__ 改掉原型。选择器里的 id 用 sel() 转义。 */
  function dict() { return Object.create(null); }
  function sel(v) { v = String(v == null ? "" : v); return window.CSS && CSS.escape ? CSS.escape(v) : v.replace(/["\\\]\[]/g, "\\$&"); }
  function uid() { return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function it(title, desc, icon, lan, wan) {
    return { id: uid(), title: title, desc: desc, lan: lan || "", wan: wan || "", icon: icon };
  }
  function ify(v) { return { type: "iconify", value: v, bg: "" }; }

  function makeDefaults() {
    return {
      settings: {
        title: "夜曲", subtitle: "Nocturne", user: "Jingbo", cols: 4, engine: "google",
        engines: [
          { id: "google", name: "Google", url: "https://www.google.com/search?q=%s", on: true },
          { id: "bing", name: "Bing", url: "https://www.bing.com/search?q=%s", on: true },
          { id: "baidu", name: "百度", url: "https://www.baidu.com/s?wd=%s", on: true },
          { id: "github", name: "GitHub", url: "https://github.com/search?q=%s", on: true }
        ]
      },
      groups: [
        { id: uid(), name: "影音", style: "icon", items: [
          it("Emby", "媒体服务器", ify("selfhst:emby"), "http://192.168.1.20:8096", "https://emby.example.com"),
          it("Plex", "媒体库", ify("selfhst:plex"), "http://192.168.1.20:32400", "https://plex.example.com")
        ] },
        { id: uid(), name: "下载", style: "icon", items: [
          it("MoviePilot", "影视订阅", { type: "emoji", value: "🧭", bg: "" }, "http://192.168.1.21:3000", "https://mp.example.com"),
          it("qBittorrent", "下载器", ify("selfhst:qbittorrent"), "http://192.168.1.21:8080", "https://qb.example.com")
        ] },
        { id: uid(), name: "存储与监控", style: "icon", items: [
          it("白群晖", "DS920+ 主存储", ify("selfhst:synology"), "http://192.168.1.10:5000", "https://nas.example.com"),
          it("黑群晖", "备份存储", ify("selfhst:synology"), "http://192.168.1.11:5000", "https://nas2.example.com"),
          it("Synology Photos", "相册", ify("arcticons:synology-photos"), "http://192.168.1.10:5000/photo", "https://photos.example.com"),
          it("Uptime Kuma", "服务监控", ify("selfhst:uptime-kuma"), "http://192.168.1.30:3001", "https://status.example.com")
        ] },
        { id: uid(), name: "常用", style: "chip", items: [
          it("Notion", "", ify("selfhst:notion"), "", "https://www.notion.so"),
          it("GitHub", "", ify("selfhst:github"), "", "https://github.com"),
          it("Cloudflare", "", ify("selfhst:cloudflare"), "", "https://dash.cloudflare.com"),
          it("ChatGPT", "", { type: "text", value: "AI", bg: "#0B6E55" }, "", "https://chatgpt.com")
        ] }
      ]
    };
  }

  var defaults = makeDefaults();
  var memory = null, rejectedCache = null;
  function load() {
    var raw = null;
    try {
      raw = memory === null ? localStorage.getItem(KEY) : memory;
      if (raw !== null) {
        var s = JSON.parse(raw);
        if (!CS.valid(s)) throw new Error("缓存格式不正确");
        s.settings = Object.assign(structuredClone(defaults.settings), s.settings);
        if (SP) SP.normalize(s); /* 本机缓存里的空间：清悬空引用 / 修复畸形条目（没有 spaces 字段时不动） */
        if (!CS.valid(s)) throw new Error("缓存格式不正确");
        return s;
      }
    } catch (e) { rejectedCache = raw; }
    return structuredClone(defaults);
  }
  var state = load();
  var undoStack = [];
  var handlers = Object.create(null);

  function save(recover) {
    if (!CS.valid(state) || (rejectedCache !== null && recover !== true)) return false;
    var raw = JSON.stringify(state);
    if (rejectedCache !== null) {
      try { localStorage.setItem("nocturne.cacheRecovery", rejectedCache); }
      catch (e) { toast("无法备份损坏的本机缓存，原始内容已保留，暂未替换配置", { duration: 12000 }); return false; }
    }
    rejectedCache = null;
    memory = raw;
    try { localStorage.setItem(KEY, raw); } catch (e) { /* storage blocked: memory only */ }
    return true;
  }
  function on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); }
  function emit(evt, d) {
    (handlers[evt] || []).slice().forEach(function (fn) {
      try { fn(d); } catch (e) { console.error(e); }
    });
  }
  function commit(fn, label, recover) {
    var before = structuredClone(state);
    fn(state);
    if (SP) SP.prune(state); /* 删项目 / 删分组后清掉空间里的悬空引用（同一次提交，可一起撤销） */
    if (save(recover) === false && recover === true) { state = before; render(); return false; }
    undoStack.push(before);
    if (undoStack.length > 50) undoStack.shift();
    render();
    emit("change", { label: label || "" });
    return true;
  }
  function undo() {
    if (!undoStack.length) { toast("没有可撤销的操作"); return false; }
    state = undoStack.pop();
    save(); render();
    emit("change", { label: "undo" });
    return true;
  }

  var SAFE_BG = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgba?|hsla?)\([0-9.,%\s\/+-]{1,48}\))$/i;
  function hue(t) { var h = 0; String(t || "").split("").forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) % 360; }); return h; }
  function iconHTML(icon, title) {
    icon = icon || {};
    var letter = esc((Array.from(String(title || "?").trim())[0] || "?").toUpperCase());
    /* --h：按名称算的色相，新版外观里给字母徽记（只在没有真实图标时出现）一个稳定、克制的底色 */
    var h = hue(title);
    var bg = ' style="--h:' + h + (icon.bg && SAFE_BG.test(String(icon.bg)) ? ";background:" + esc(icon.bg) : "") + '"';
    var fail = ' data-l="' + letter + '"'; /* 加载失败由下面 document 上捕获阶段的 error 监听处理（CSP 不允许内联 onerror） */
    var v = String(icon.value || "");
    if (icon.type === "iconify" && v.indexOf(":") > 0) {
      var p = v.split(":"), src = (window.NOCTURNE ? "api/icon/" : "https://api.iconify.design/") + encodeURIComponent(p[0]) + "/" + encodeURIComponent(p[1]) + ".svg";
      if (failed[src]) return '<span class="x-ic"' + bg + '><span class="x-fb">' + letter + "</span></span>";
      return '<span class="x-ic"' + bg + '><img src="' + src + '" loading="lazy" alt=""' + fail + "></span>";
    }
    if (icon.type === "image" && v && (failed[v] || !U.image(v))) return '<span class="x-ic"' + bg + '><span class="x-fb">' + letter + "</span></span>";
    if (icon.type === "emoji" && v) return '<span class="x-ic"' + bg + '><span class="x-emoji">' + esc(v) + "</span></span>";
    if (icon.type === "text" && v) return '<span class="x-ic"' + bg + ">" + esc(v.slice(0, 3)) + "</span>";
    if (icon.type === "image" && v) return '<span class="x-ic"' + bg + '><img class="x-full" src="' + esc(v) + '" loading="lazy" alt=""' + fail + "></span>";
    return '<span class="x-ic x-fb"' + bg + ">" + letter + "</span>";
  }
  var failed = dict();
  document.addEventListener("error", function (e) { var t = e.target; if (t && t.tagName === "IMG" && t.hasAttribute("data-l") && t.isConnected) iconFail(t); }, true);
  function iconFail(img) {
    var u = img.getAttribute("src"); if (u && !/^data:/.test(u)) failed[u] = true;
    var s = document.createElement("span");
    s.className = "x-fb";
    s.textContent = img.getAttribute("data-l") || "?";
    img.replaceWith(s);
  }

  function hostOf(item) { var u = window.App && App.url ? App.url(item) : U.safeNav(item.wan) || U.safeNav(item.lan) || ""; try { return u && u !== "#" ? new URL(u).host : ""; } catch (e) { return ""; } }
  function itemHTML(g, item) {
    var href = esc(U.safeNav(item.wan) || U.safeNav(item.lan) || "#"); /* 非 http(s) 地址一律当作没有地址，不可点击 */
    var attrs = ' href="' + href + '" target="_blank" rel="noopener" data-id="' + esc(item.id) + '" data-gid="' + esc(g.id) + '"';
    if (g.style === "chip") {
      return '<a class="x-chip x-glass"' + attrs + ">" + iconHTML(item.icon, item.title) + "<span>" + esc(item.title) + "</span></a>";
    }
    /* x-host / x-st：新版「紧凑行」显示地址与状态（经典外观里隐藏）；title 带完整名称，长名称在卡片上两行截断 */
    return '<a class="x-tile x-glass"' + attrs + ' style="--h:' + hue(item.title) + '" title="' + esc([item.title, item.desc].filter(Boolean).join(" · ")) + '">' +
      '<span class="dot" aria-hidden="true"></span>' + iconHTML(item.icon, item.title) +
      '<span class="x-name">' + esc(item.title) + "</span>" +
      (item.desc ? '<span class="x-desc">' + esc(item.desc) + "</span>" : "") +
      '<span class="x-host" aria-hidden="true">' + esc(hostOf(item)) + '</span><span class="x-st" aria-hidden="true"></span></a>';
  }

  function render() {
    var st = state.settings;
    $("x-title").textContent = st.title || "夜曲";
    $("x-subtitle").textContent = st.subtitle || "";
    $("x-subtitle").hidden = !st.subtitle;
    var engines = (st.engines || []).filter(function (e) { return e.on; });
    if (!engines.some(function (e) { return e.id === st.engine; }) && engines[0]) st.engine = engines[0].id;
    $("x-engines").innerHTML = engines.map(function (e) {
      return '<button type="button" class="x-eng" data-eng="' + esc(e.id) + '" aria-pressed="' + (e.id === st.engine) + '">' + esc(e.name) + "</button>";
    }).join("");
    $("x-groups").style.setProperty("--cols", Math.max(2, Math.min(6, +st.cols || 4)));
    /* V2.0 阶段 2：只渲染当前空间（本机选择）看得见的分组 / 项目；顺序永远是全局顺序。「全部」= 全部分组、全部项目（与 V1.1 相同） */
    var sid = curSpace(), view = SP ? SP.view(state, sid) : state.groups.map(function (g) { return { group: g, items: g.items || [], whole: true }; });
    document.body.classList.toggle("has-spaces", !!(SP && SP.list(state).length));
    document.body.setAttribute("data-space", sid);
    $("x-groups").setAttribute("data-space", sid);
    $("x-groups").innerHTML = view.map(function (e) {
      var g = e.group, items = e.items.map(function (i) { return itemHTML(g, i); }).join("");
      return '<section class="x-group" data-gid="' + esc(g.id) + '"' + (e.whole ? "" : ' data-part="1"') + ' aria-label="' + esc(g.name) + '">' +
        '<h2 class="x-gtitle"><span class="x-gname">' + esc(g.name) + '</span><span class="x-gcnt" aria-hidden="true">' + e.items.length + " 项</span>" + (e.whole ? (e.hidden ? '<small class="x-gpart">本空间隐藏 ' + e.hidden + " 项</small>" : "") : '<small class="x-gpart">单独添加的项目</small>') + "</h2>" +
        '<div class="' + (g.style === "chip" ? "x-chips" : "x-grid") + '" data-gid="' + esc(g.id) + '">' + items + "</div></section>";
    }).join("") || emptyHTML(sid);
    tick();
    emit("render");
  }

  /* 当前空间为空（没选分组 / 引用的分组已被删除）：说明 + 「选择分组」直接打开管理空间。「全部」没有分组时沿用 V1.1（编辑模式里可添加分组） */
  function emptyHTML(sid) {
    var s = SP && SP.get(state, sid);
    if (!s) return "";
    return '<div class="x-sempty" role="note"><h2>「' + esc(s.name) + '」里还没有内容</h2>' +
      "<p>空间只引用已有的分组和项目，不会复制它们。选几个分组放进来，它们在「全部」里也照样在。</p>" +
      '<button type="button" class="x-sempty-cta" data-space-pick="' + esc(s.id) + '">选择分组</button></div>';
  }
  var WEEK = "日一二三四五六";
  function greeting(h) {
    return h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function tick() {
    if (document.hidden && $("x-clock").textContent !== "--:--") return; /* 标签页在后台：不更新（回到前台立刻补一次） */
    var d = new Date();
    $("x-clock").textContent = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    $("x-date").textContent = (d.getMonth() + 1) + "月" + d.getDate() + "日 星期" + WEEK[d.getDay()];
    $("x-greet").innerHTML = greeting(d.getHours()) + "，<b>" + esc(state.settings.user || "") + "</b>";
  }

  var toastTimer = null;
  function toast(msg, opts) {
    opts = opts || {};
    var el = $("x-toast"), act = $("x-toast-act");
    $("x-toast-msg").textContent = msg;
    act.hidden = !opts.action;
    act.textContent = opts.action || "";
    act.onclick = function () { hide(); if (opts.onAction) opts.onAction(); };
    el.classList.add("is-on");
    function hide() { el.classList.remove("is-on"); }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hide, opts.duration || 4000);
  }

  $("x-engines").addEventListener("click", function (e) {
    var b = e.target.closest("[data-eng]");
    if (!b) return;
    state.settings.engine = b.getAttribute("data-eng");
    save(); render();
    $("x-q").focus();
  });
  $("x-search").addEventListener("submit", function (e) {
    e.preventDefault();
    var q = $("x-q").value.trim();
    if (!q) return;
    var eng = state.settings.engines.filter(function (x) { return x.id === state.settings.engine; })[0] || state.settings.engines[0];
    if (eng && !U.engine(eng.url)) { toast("搜索引擎「" + eng.name + "」的网址模板无效（只支持 http/https）"); return; }
    if (eng) window.open(eng.url.replace("%s", encodeURIComponent(q)), "_blank", "noopener");
    $("x-q").value = "";
  });
  function emitOrSoon(evt) {
    var d = { handled: false };
    emit(evt, d);
    if (!d.handled) toast("即将上线");
  }
  $("btn-menu").addEventListener("click", function () { emitOrSoon("menu"); });
  document.querySelector(".x-dock").addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b) return;
    var a = b.getAttribute("data-act");
    if (a === "search") {
      var bar = document.querySelector(".x-bar");
      bar.classList.add("is-pulse");
      setTimeout(function () { bar.classList.remove("is-pulse"); }, 1200);
      $("x-q").focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (a === "palette") { if (window.App && App.palette) App.palette.open(""); } /* 在这次点按里直接聚焦，iOS 软键盘才会弹出 */
    else if (a === "more") emitOrSoon("menu");
    else emitOrSoon(a);
  });

  window.App = {
    get state() { return state; },
    set state(v) { state = v; },
    get cacheRejected() { return rejectedCache !== null; },
    defaults: defaults,
    save: save, commit: commit, undo: undo, render: render,
    on: on, emit: emit, toast: toast,
    util: { esc: esc, uid: uid, iconHTML: iconHTML, _fail: iconFail, url: U, dict: dict, sel: sel },
    spaces: null
  };
  App.spaces = spacesApi();
  /* V2.0 阶段 1：空间模型的程序接口（暂无界面，首页仍显示「全部」）。修改走 commit（可撤销、会同步）；
   * 当前空间只存本机 localStorage「nocturne.space:<账户>」，不进 state、不进 snapshot、不产生服务器版本。 */
  function owner() { var N = window.NOCTURNE; return N && N.backend ? (N.user && N.user.name) || "~anon" : null; }
  var selMem = dict();
  var selStore = { getItem: function (k) { try { var v = localStorage.getItem(k); return v != null ? v : selMem[k] || null; } catch (e) { return selMem[k] || null; } },
    setItem: function (k, v) { selMem[k] = v; try { localStorage.setItem(k, v); } catch (e) { /* memory only */ } },
    removeItem: function (k) { delete selMem[k]; try { localStorage.removeItem(k); } catch (e) { /* memory only */ } } };
  /** 当前空间（本机、按账户分键；记住的空间不存在 → "all"） */
  function curSpace() { return SP ? SP.readSel(selStore, owner(), state) : "all"; }
  /* V2.0 空间的程序接口。修改走 commit（可撤销、会同步）；当前空间只存本机 localStorage「nocturne.space:<账户>」，
   * 不进 state、不进 snapshot、不产生服务器版本。切换只重新渲染（展示范围 + 该范围的状态统计），从不 commit。 */
  function spacesApi() {
    if (!SP) return null;
    return {
      model: SP, ALL: SP.ALL,
      list: function () { return SP.list(state); },
      view: function (id) { return SP.view(state, id); },
      selected: curSpace,
      select: function (id) {
        var v = SP.resolve(state, id), prev = curSpace();
        SP.writeSel(selStore, owner(), v);
        if (v !== prev) render();
        emit("space", { id: v, prev: prev });
        return v;
      },
      selKey: function () { return SP.selKey(owner()); },
      /** 当前空间看得见的项目 id（Set）；"all" → null（= 全部） */
      scope: function () {
        var sid = curSpace(); if (!SP.get(state, sid)) return null;
        var out = new Set(); SP.view(state, sid).forEach(function (e) { e.items.forEach(function (i) { if (i) out.add(String(i.id)); }); });
        return out;
      },
      /** 新项目 / 新分组默认放进哪个分组：当前空间里第一个图标分组 → 第一个看得见的分组 → 全局第一个图标分组 */
      defaultGroup: function () {
        var v = SP.view(state, curSpace()).map(function (e) { return e.group; });
        var pick = function (l) { return l.filter(function (x) { return x.style !== "chip"; })[0] || l[0]; };
        return pick(v) || pick(state.groups) || null;
      },
      /** 在 commit 里调用：项目在当前空间看不见（加到 / 移到了不在本空间的分组）→ 单独加进本空间（itemIds），返回是否加了 */
      keepVisible: function (st, itemId) {
        var sid = curSpace(); if (!SP.get(st, sid) || SP.itemVisible(st, sid, itemId)) return false;
        SP.pin(st, sid, String(itemId), true); return true;
      },
      /** 在 commit 里调用：在某个空间里新建的分组整组加进这个空间 */
      adoptGroup: function (st, groupId) {
        var sid = curSpace(), sp = SP.get(st, sid); if (!sp || SP.groupInSpace(st, sid, groupId)) return false;
        SP.setGroups(st, sid, (sp.groupIds || []).concat([String(groupId)])); return true;
      },
      current: function () { return SP.get(state, curSpace()); },
      manage: function (id) { var d = { id: id || null, handled: false }; emit("spaces-manage", d); return d.handled; }
    };
  }
  $("x-groups").addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-space-pick]");
    if (b && App.spaces) App.spaces.manage(b.getAttribute("data-space-pick"));
  });

  render();
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(); });
})();
