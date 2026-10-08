/*
 * 夜曲 Nocturne V2.0 · Midnight Edition（阶段 3）—— 新版外观的行为层。只用 window.App 的公开接口；经典外观下几乎什么都不做。
 *   - 本设备外观：新版 / 经典（localStorage「nocturne.ui」，默认新版），手机列数（「nocturne.v2.cols」3 / 4，默认 3）——都只存本机、不进配置、不同步
 *   - 三层背景的「光层」：每个空间一层穹顶光（CSS 渐变），切换空间时转出 / 转入 + 一道扫过的光（只动 opacity / transform）
 *   - 空间外观：theme / density（空间字段；没设时按名称模板给默认：日常 = 晨光，娱乐 = 靛紫海报，NAS = 冷霜紧凑，其余中性）
 *   - 空间切换的内容交叉淡化（旧内容的快照淡出、新内容分层淡入；App.spaces.select 仍是同步的）
 *   - 手机：空间切换器并进底部快捷栏（一条悬浮栏）；软键盘弹出时收起底栏（visualViewport）
 *   - 当前空间标题、切换器指示条、页面分层载入
 * 没有持续运行的 requestAnimationFrame / 定时器；prefers-reduced-motion 时不做任何位移和过渡（CSS 也全部关掉）。
 */
(function () {
  "use strict";
  var A = window.App; if (!A) return;
  var de = document.documentElement, body = document.body, esc = A.util.esc;
  var SPC = A.spaces, M = SPC ? SPC.model : null;
  var UI_KEY = "nocturne.ui", COLS_KEY = "nocturne.v2.cols";
  var groupsEl = document.getElementById("x-groups");
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } return null; }
  function mq(q) { return !!(window.matchMedia && window.matchMedia(q).matches); }
  function v2() { return de.getAttribute("data-ui") !== "classic"; }
  function still() { return !mq("(prefers-reduced-motion: no-preference)"); } /* 没有 matchMedia（测试环境）也当作「减少动态效果」：同步、无动画 */
  function mobile() { return mq("(max-width: 767px)"); }

  /* ------------------------------------------------------------ 本设备外观 */
  /** 手机列数：本机设置优先；从没设过时按经典外观的「手机每行」迁移——只有明确选过 5 列（更密）的才给紧凑 4 列，其余（含默认的 4）用 3 列 */
  function cols() {
    var v = ls(COLS_KEY);
    if (v === "3" || v === "4") return +v;
    return (+((A.state.settings || {}).cols) || 4) >= 5 ? 4 : 3;
  }
  function applyAppearance() {
    de.setAttribute("data-mcols", String(cols()));
    if (!de.getAttribute("data-ui")) de.setAttribute("data-ui", "v2");
  }
  A.appearance = {
    KEY: UI_KEY, COLS_KEY: COLS_KEY,
    get: function () { return v2() ? "v2" : "classic"; },
    /** 切换外观：只改本机，不 commit、不同步；壁纸 / 设置原样 */
    set: function (v) {
      v = v === "classic" ? "classic" : "v2";
      ls(UI_KEY, v === "classic" ? "classic" : "v2");
      if (de.getAttribute("data-ui") === v) return v;
      de.setAttribute("data-ui", v);
      A.render();
      return v;
    },
    cols: cols,
    setCols: function (n) { n = +n === 4 ? 4 : 3; ls(COLS_KEY, String(n)); applyAppearance(); syncSettings(); return n; },
    look: function () { return look(SPC ? SPC.current() : null); }
  };
  applyAppearance();

  /* ------------------------------------------------------------ 光层 */
  var sky = document.createElement("div");
  sky.className = "mn-sky"; sky.setAttribute("aria-hidden", "true");
  sky.innerHTML = ["default", "dawn", "dusk", "frost"].map(function (t) { return '<div class="mn-dome" data-t="' + t + '"></div>'; }).join("") +
    '<div class="mn-sweep"></div><div class="mn-vig"></div><div class="mn-grain"></div>';
  var shade = document.querySelector(".x-shade");
  if (shade) shade.after(sky); else body.prepend(sky);

  /* ------------------------------------------------------------ 空间外观 */
  var BY_NAME = [
    [/日常|daily|常用|生活/i, "dawn", "comfortable"],
    [/娱乐|影音|影视|媒体|fun|media|movie/i, "dusk", "poster"],
    [/nas|存储|服务器|运维|监控|homelab|server/i, "frost", "compact"]
  ];
  function look(sp) {
    if (!sp) return { theme: "default", density: "comfortable" };
    var t = sp.theme, d = sp.density;
    if (!t || !d) for (var i = 0; i < BY_NAME.length; i++) if (BY_NAME[i][0].test(sp.name || "")) { t = t || BY_NAME[i][1]; d = d || BY_NAME[i][2]; break; }
    return { theme: t || "default", density: d || "comfortable" };
  }
  var curTheme = null;
  function applyLook(animate) {
    var cs = SPC ? SPC.current() : null, l = look(cs);
    body.setAttribute("data-theme", l.theme); body.setAttribute("data-density", l.density);
    groupsEl.setAttribute("data-density", l.density); /* 密度挂在分组区自己身上：切换时的旧内容快照带着旧密度淡出 */
    if (l.theme === curTheme) return;
    var prev = curTheme; curTheme = l.theme;
    sky.querySelectorAll(".mn-dome").forEach(function (d) {
      var t = d.getAttribute("data-t");
      d.classList.toggle("is-on", t === l.theme);
      d.classList.toggle("is-out", t === prev && animate);
    });
    if (animate && prev && v2() && !still()) { /* 一道扫过的光：重启一次 CSS 动画（不是循环） */
      sky.classList.remove("is-sweep"); void sky.offsetWidth; sky.classList.add("is-sweep");
      clearTimeout(applyLook.t); applyLook.t = setTimeout(function () { sky.classList.remove("is-sweep"); sky.querySelectorAll(".is-out").forEach(function (d) { d.classList.remove("is-out"); }); }, 900);
    }
  }

  /* ------------------------------------------------------------ 当前空间标题（hero 右侧 / 手机隐藏） */
  var hero = document.querySelector(".x-hero"), spt = document.createElement("div");
  spt.className = "mn-sp"; spt.setAttribute("aria-live", "polite");
  if (hero) hero.appendChild(spt);
  function drawTitle() {
    if (!SPC) return;
    var cs = SPC.current(), id = SPC.selected(), st = M.stats(A.state, id);
    spt.hidden = !SPC.list().length;
    spt.innerHTML = "<small>当前空间</small><b>" + esc(cs ? cs.name : M.ALL_NAME) + "</b><span>" + st.groups + " 个分组 · " + st.items + " 个项目</span>";
  }

  /* 问候与日期排成一行：把日期抄到问候的 data-date（CSS ::after 显示）；日期开关关掉时不抄 */
  var dateEl = document.getElementById("x-date"), greetEl = document.getElementById("x-greet");
  function syncDate() { if (greetEl && dateEl) greetEl.setAttribute("data-date", dateEl.hidden ? "" : dateEl.textContent); }
  if (dateEl) new MutationObserver(syncDate).observe(dateEl, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });

  /* ------------------------------------------------------------ 切换器：指示条 + 手机并进底栏 */
  var nav = document.querySelector(".x-spaces"), dock = document.querySelector(".x-dock"), navHome = groupsEl;
  var ind = document.createElement("span"); ind.className = "mn-ind"; ind.setAttribute("aria-hidden", "true");
  function placeInd(instant) {
    if (!nav) return;
    var track = nav.querySelector(".x-sp-track"), cur = track && track.querySelector('[aria-current="true"]');
    if (!track) return;
    if (ind.parentNode !== track) { track.prepend(ind); void ind.offsetWidth; } /* 切换器重画后放回去：先按旧位置排一次，过渡才会从旧位置滑过去 */
    if (!cur || !v2()) { ind.style.opacity = "0"; return; }
    if (instant) ind.classList.add("is-instant");
    ind.style.opacity = "";
    ind.style.width = cur.offsetWidth + "px"; ind.style.height = cur.offsetHeight + "px";
    ind.style.transform = "translate(" + cur.offsetLeft + "px," + cur.offsetTop + "px)";
    if (instant) { void ind.offsetWidth; ind.classList.remove("is-instant"); }
  }
  /* 横向滚动区两端的渐隐只在那一侧还有被藏住的分段时出现（is-ovl / is-ovr），渐隐只作用在滚动区自身，不压到左右按钮 */
  var fadeTrack = null;
  function syncFade() {
    var t = nav && nav.querySelector(".x-sp-track"); if (!t) return;
    var max = t.scrollWidth - t.clientWidth;
    t.classList.toggle("is-ovl", max > 1 && t.scrollLeft > 1);
    t.classList.toggle("is-ovr", max > 1 && t.scrollLeft < max - 1);
  }
  function reveal(smooth) {
    var t = nav && nav.querySelector(".x-sp-track");
    if (t && t !== fadeTrack) { fadeTrack = t; t.addEventListener("scroll", syncFade, { passive: true }); }
    if (SPC && SPC.reveal) SPC.reveal(smooth);
    syncFade();
  }
  /* 底栏后面的一层局部暗化（固定在视口底部、不接收点按）：正文 / 卡片 / 亮色壁纸从底栏下面经过时先被压暗，再被底栏材质盖住 */
  if (dock && !document.querySelector(".mn-dockscrim")) { var scrim = document.createElement("div"); scrim.className = "mn-dockscrim"; scrim.setAttribute("aria-hidden", "true"); dock.before(scrim); }
  function placeNav() {
    if (!nav || !dock) return;
    var merge = v2() && mobile();
    body.classList.toggle("mn-merged", merge && body.classList.contains("has-spaces"));
    if (merge && nav.parentNode !== dock) { var pal = dock.querySelector(".x-dk-pal"); pal.after(nav); }
    else if (!merge && nav.parentNode === dock) navHome.before(nav);
  }

  /* ------------------------------------------------------------ 空间切换：交叉淡化 */
  if (SPC) {
    var select0 = SPC.select;
    SPC.select = function (id) {
      var before = SPC.selected(), want = M.resolve(A.state, id), ghost = null;
      if (want !== before && v2() && !still() && groupsEl.offsetParent !== null && !body.classList.contains("editing")) {
        var r = groupsEl.getBoundingClientRect();
        ghost = groupsEl.cloneNode(true);
        ghost.removeAttribute("id"); ghost.querySelectorAll("[id]").forEach(function (n) { n.removeAttribute("id"); });
        ghost.className = groupsEl.className + " mn-ghost"; ghost.setAttribute("aria-hidden", "true"); ghost.inert = true;
        ghost.style.cssText = "position:fixed;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + Math.min(r.height, innerHeight - Math.max(0, r.top)) + "px;margin:0;";
        body.appendChild(ghost);
        groupsEl.style.minHeight = Math.min(r.height, innerHeight) + "px"; /* 切换时不让页面高度突然塌下去 */
      }
      var got = select0.call(SPC, id);
      if (ghost) {
        /* 重启入场动画只需要一次样式计算（不读 offsetWidth，免得在同步路径里强制整页布局） */
        groupsEl.classList.remove("mn-swap"); void getComputedStyle(groupsEl).animationName; groupsEl.classList.add("mn-swap");
        requestAnimationFrame(function () {
          ghost.classList.add("is-go");
          /* 只有已经滚过分组顶部时才回到分组顶部（下一帧再读位置，浏览器这一帧本来就要排版） */
          var top = groupsEl.getBoundingClientRect().top;
          if (top < 0) window.scrollTo({ top: Math.max(0, scrollY + top - 16), behavior: "smooth" });
        });
        setTimeout(function () { ghost.remove(); groupsEl.style.minHeight = ""; }, 320);
        setTimeout(function () { groupsEl.classList.remove("mn-swap"); }, 700);
      }
      return got;
    };
  }

  /* ------------------------------------------------------------ 软键盘（iOS：只有 visualViewport 变小） */
  var VV = window.visualViewport;
  function kb() {
    if (!VV) return;
    var t = document.activeElement, typing = t && /^(INPUT|TEXTAREA)$/.test(t.tagName) && !/^(checkbox|radio|range|file|button|submit)$/.test(t.type);
    de.classList.toggle("mn-kb", !!typing && window.innerHeight - VV.height > 120);
  }
  if (VV) { VV.addEventListener("resize", kb); }
  document.addEventListener("focusin", function () { setTimeout(kb, 60); });
  document.addEventListener("focusout", function () { setTimeout(kb, 60); });

  /* ------------------------------------------------------------ 设置：本设备外观 / 手机列数 */
  var setPane = document.querySelector('.x-set [data-pane="外观"]');
  var box = document.createElement("div");
  box.className = "mn-setui";
  box.innerHTML = '<p class="x-gt">界面</p><div class="x-gl">' +
    '<div class="x-row"><span>外观</span><div class="x-sg" role="group" aria-label="外观"><button type="button" data-ui-set="v2" aria-pressed="false">新版</button><button type="button" data-ui-set="classic" aria-pressed="false">经典</button></div></div>' +
    '<div class="x-row mn-v2only"><span>手机每行</span><div class="x-sg" role="group" aria-label="手机每行图标数（本机）"><button type="button" data-mcols="3" aria-pressed="false">3 标准</button><button type="button" data-mcols="4" aria-pressed="false">4 紧凑</button></div></div></div>' +
    '<p class="x-hint">只影响这台设备。新版和经典共用同一份分组、项目、壁纸与设置，随时可以切回。</p>';
  if (setPane) setPane.prepend(box);
  function syncSettings() {
    box.querySelectorAll("[data-ui-set]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-ui-set") === A.appearance.get())); });
    box.querySelectorAll("[data-mcols]").forEach(function (b) { b.setAttribute("aria-pressed", String(+b.getAttribute("data-mcols") === cols())); });
  }
  box.addEventListener("click", function (e) {
    var b = e.target.closest("[data-ui-set],[data-mcols]"); if (!b) return;
    if (b.hasAttribute("data-ui-set")) { var v = A.appearance.set(b.getAttribute("data-ui-set")); A.toast(v === "v2" ? "已切换到新版外观（只影响这台设备）" : "已切换到经典外观（只影响这台设备）"); }
    else A.appearance.setCols(b.getAttribute("data-mcols"));
    syncSettings();
  });

  /* ------------------------------------------------------------ 页面分层载入 */
  /* 分层载入本身是纯 CSS（首帧就开始，不等脚本、不会先闪一下再隐藏）；这里只在登录 / 载入完成约 1.3 秒后摘掉载入动画 */
  function ready() { return !de.classList.contains("nc-locked") && !de.classList.contains("nc-loading"); }
  var booted = false;
  function boot() {
    if (booted || !ready()) return;
    booted = true;
    setTimeout(function () { de.classList.add("mn-done"); }, still() ? 0 : 1300);
  }
  new MutationObserver(boot).observe(de, { attributes: true, attributeFilter: ["class"] });

  /* ------------------------------------------------------------ 接线 */
  var lastSpace = null;
  function onRender() {
    applyAppearance(); placeNav(); drawTitle(); syncDate();
    var sid = SPC ? SPC.selected() : "all";
    lastMoved = lastSpace !== null && sid !== lastSpace;
    applyLook(lastMoved); lastSpace = sid;
    syncSettings();
    /* 切换空间时，指示条与横向滚动放到下一帧再读布局（同一帧里浏览器本来就要排版），同步路径少一次强制整页布局 */
    if (lastMoved && window.requestAnimationFrame) requestAnimationFrame(function () { placeInd(false); reveal(true); });
    else { placeInd(false); reveal(false); }
  }
  var lastMoved = false;
  A.on("render", onRender);
  function relayout() { placeNav(); placeInd(true); reveal(false); }
  window.addEventListener("resize", relayout);
  if (window.matchMedia) { var m = window.matchMedia("(max-width: 767px)"); if (m.addEventListener) m.addEventListener("change", relayout); }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { placeInd(true); reveal(false); });
  onRender(); placeInd(true); reveal(false); boot();
})();
