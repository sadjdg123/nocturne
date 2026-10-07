/*
 * 夜曲 Nocturne · NAS 后端接入模块
 * 只通过 window.App 的公开接口工作；作为纯静态页面打开时（没有 window.NOCTURNE）什么也不做。
 * 功能：登录 / 首次创建管理员、配置同步到 NAS、服务端状态检测、设置→账户、关联容器。
 */
(function () {
  "use strict";
  var N = window.NOCTURNE, A = window.App;
  if (!N || !N.backend || !A) return;
  var esc = A.util.esc, de = document.documentElement;
  var KEY = "yeqv.v1", OWNER = "nocturne.owner", VER = "nocturne.ver";

  function ls(op, k, v) { try { return op === "get" ? localStorage.getItem(k) : op === "del" ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { return null; } }
  function api(method, p, body) {
    var o = { method: method, credentials: "same-origin", cache: "no-store", headers: {} };
    if (body !== undefined) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
    return fetch("api/" + p, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.error || ("HTTP " + r.status)); e.status = r.status; e.data = d; throw e; }
        return d;
      });
    });
  }
  /* ---------------------------------------------- 自定义壁纸（存 NAS 文件） */
  A.wallpaperUrl = function (w) { return "api/wallpaper?v=" + encodeURIComponent(w && w.v || 0); };
  /** 上传图片 Blob（jpeg/png/webp），成功返回版本号 v */
  A.uploadWallpaper = function (blob) {
    return fetch("api/wallpaper", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": blob.type || "image/jpeg" }, body: blob }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.error || ("HTTP " + r.status)); e.status = r.status; throw e; }
        return d.v;
      });
    });
  };
  /** 旧配置里的 data URL 壁纸：先传成文件，再改写本机配置（避免把几 MB 的 JSON 推给服务器） */
  var wpMigrating = null;
  function migrateLocalWallpaper() {
    var w = A.state.settings && A.state.settings.wallpaper;
    if (!w || typeof w.url !== "string" || w.url.indexOf("data:") !== 0) return Promise.resolve(false);
    if (wpMigrating) return wpMigrating;
    var dataUrl = w.url;
    wpMigrating = fetch(dataUrl).then(function (r) { return r.blob(); }).then(A.uploadWallpaper).then(function (v) {
      var cur = A.state.settings.wallpaper;
      if (cur && cur.url === dataUrl) { A.state.settings.wallpaper = Object.assign({}, cur, { id: "custom", file: true, v: v, url: "" }); A.save(); A.render(); }
      return true;
    }).then(function (x) { wpMigrating = null; return x; }, function (e) { wpMigrating = null; throw e; });
    return wpMigrating;
  }

  function unlock() { de.classList.remove("nc-locked", "nc-loading"); }

  /* ------------------------------------------------------------ styles */
  var css = document.createElement("style");
  css.textContent = [
    ".nc-auth{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:24px 16px calc(24px + env(safe-area-inset-bottom));overflow-y:auto}",
    ".nc-card{width:100%;max-width:380px;padding:30px 24px 24px;border-radius:24px;box-shadow:0 20px 60px rgba(0,0,0,.45);animation:x-in .6s cubic-bezier(.2,.7,.2,1) both}",
    ".nc-brand{display:flex;align-items:baseline;justify-content:center;gap:10px;margin:0 0 6px;font:500 28px/1.2 var(--x-serif);letter-spacing:.1em}",
    ".nc-brand em{font:italic 400 22px/1 'Cormorant Garamond',serif;color:var(--x-amber);letter-spacing:.02em}",
    ".nc-sub{margin:0 0 22px;text-align:center;color:var(--x-mist);font-size:14px;letter-spacing:.04em}",
    ".nc-card form{display:grid;gap:12px}",
    ".nc-in{width:100%;height:48px;padding:0 16px;border-radius:14px;border:1px solid var(--x-line);background:rgba(255,255,255,.06);color:var(--x-text);font:400 16px var(--x-ui);outline:none;box-sizing:border-box}",
    ".nc-in:focus{border-color:rgba(233,178,106,.6);background:rgba(255,255,255,.09)}",
    ".nc-in::placeholder{color:var(--x-mist)}",
    ".nc-btn{height:48px;margin-top:6px;border:0;border-radius:14px;background:var(--x-amber);color:#1A1208;font:600 16px var(--x-ui);letter-spacing:.06em;cursor:pointer}",
    ".nc-btn:disabled{opacity:.55;cursor:default}",
    ".nc-err{min-height:20px;margin:2px 2px 0;color:#F29A8A;font-size:13px}",
    ".nc-foot{margin:14px 0 0;text-align:center;color:var(--x-mist);font-size:12px;opacity:.8}",
    ".nc-ul .x-row{flex-wrap:wrap}",
    ".nc-ul .nc-name{flex:1;min-width:0;color:var(--x-text)}",
    ".nc-ul .nc-tag{font-size:12px;color:var(--x-amber);margin-left:6px}",
    ".nc-mini{height:32px;padding:0 12px;border:1px solid var(--x-line);border-radius:10px;background:rgba(255,255,255,.06);color:var(--x-text);font:500 13px var(--x-ui);cursor:pointer}",
    ".nc-mini.is-red{color:#F29A8A}",
    ".nc-pw{display:flex;gap:8px;width:100%;padding:4px 0 6px}",
    ".nc-pw input{flex:1;min-width:0;height:36px;padding:0 10px;border:1px solid var(--x-line);border-radius:10px;background:rgba(255,255,255,.06);color:var(--x-text);font:400 15px var(--x-ui);outline:none}",
    ".nc-form .x-row input[type=password]{flex:1;width:auto;min-width:0;height:36px;padding:0;border:0;background:none;color:var(--x-text);font:400 16px var(--x-ui);text-align:right;outline:none}",
    ".nc-form .x-acts{padding:4px 16px 12px}",
    ".nc-badge{display:inline-block;margin-left:6px;font-size:12px;color:var(--x-mist)}"
  ].join("\n");
  document.head.appendChild(css);

  /* ------------------------------------------------------ status hook */
  var statusMap = null, statusWaiters = [];
  function statusReady() { return statusMap ? Promise.resolve(statusMap) : new Promise(function (r) { statusWaiters.push(r); }); }
  A.statusFor = function (it, local) {
    return statusReady().then(function (m) {
      var r = m[it.id];
      if (r) return { ok: !!r.up, ms: r.ms != null ? r.ms : null, code: r.code || null, auth: !!r.auth, blocked: r.status === "blocked" };
      return local(); // 服务器还没检测过（刚添加的项目）：先用浏览器探测
    });
  };
  function pullStatus() {
    if (!N.user) return Promise.resolve();
    return api("GET", "status").then(function (m) {
      statusMap = m || {};
      var w = statusWaiters; statusWaiters = []; w.forEach(function (f) { f(statusMap); });
      if (A.recheck) A.recheck(false);
    }, function (e) {
      if (e.status === 401) return expired();
      if (!statusMap) { statusMap = {}; var w = statusWaiters; statusWaiters = []; w.forEach(function (f) { f(statusMap); }); }
    });
  }

  /* ------------------------------------------------------- auth screen */
  function authScreen() {
    var setup = !!N.setup;
    var el = document.createElement("div");
    el.className = "nc-auth"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", setup ? "创建管理员" : "登录");
    el.innerHTML = '<div class="nc-card x-glass"><h1 class="nc-brand">夜曲<em>Nocturne</em></h1>' +
      '<p class="nc-sub">' + (setup ? "首次使用 · 创建管理员" : "登录到你的起始页") + "</p>" +
      '<form novalidate><input class="nc-in" name="name" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="用户名" required>' +
      '<input class="nc-in" name="password" type="password" autocomplete="' + (setup ? "new-password" : "current-password") + '" placeholder="密码' + (setup ? "（至少 6 位）" : "") + '" required>' +
      (setup ? '<input class="nc-in" name="password2" type="password" autocomplete="new-password" placeholder="再输入一次密码" required>' : "") +
      '<p class="nc-err" role="alert"></p><button class="nc-btn" type="submit">' + (setup ? "创建管理员" : "登录") + "</button></form>" +
      '<p class="nc-foot">' + (setup ? "管理员可以在 设置 → 账户 里添加其他用户" : "每个账户有自己的分组与设置") + "</p></div>";
    document.body.appendChild(el);
    var f = el.querySelector("form"), F = f.elements, err = el.querySelector(".nc-err"), btn = el.querySelector(".nc-btn");
    setTimeout(function () { F.namedItem("name").focus(); }, 50);
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = F.namedItem("name").value.trim(), pw = F.namedItem("password").value;
      err.textContent = "";
      if (!name || !pw) { err.textContent = "请输入用户名和密码"; return; }
      if (setup) {
        if (pw.length < 6) { err.textContent = "密码至少 6 位"; return; }
        if (pw !== F.namedItem("password2").value) { err.textContent = "两次输入的密码不一致"; return; }
      }
      btn.disabled = true; btn.textContent = setup ? "创建中…" : "登录中…";
      api("POST", setup ? "setup" : "login", { name: name, password: pw }).then(function () {
        location.reload();
      }, function (x) {
        btn.disabled = false; btn.textContent = setup ? "创建管理员" : "登录";
        err.textContent = x.message + (x.data && x.data.left != null && x.data.left > 0 && x.data.left < 3 ? "（还可尝试 " + x.data.left + " 次）" : "");
        if (x.status === 409) setTimeout(function () { location.reload(); }, 1200);
        F.namedItem("password").select();
      });
    });
    window.addEventListener("keydown", function (e) { if (de.classList.contains("nc-locked")) e.stopImmediatePropagation(); }, true);
  }
  function expired() {
    if (expired.done) return; expired.done = true;
    A.toast("登录已过期，请重新登录", { duration: 6000, action: "登录", onAction: function () { location.reload(); } });
  }

  /* -------------------------------------------------------- config sync */
  var serverVer = N.version || 0, lastSent = null, timer = null, inflight = false, dirty = false, warned = false;
  function snapshot() { return JSON.stringify(A.state); }
  function markSynced(ver, raw) {
    serverVer = ver; lastSent = raw;
    ls("set", VER, String(ver)); ls("set", OWNER, N.user.name);
  }
  function schedule() { if (!N.user) return; clearTimeout(timer); timer = setTimeout(push, 800); }
  function push() {
    if (inflight) { dirty = true; return; }
    if (wpMigrating) { dirty = true; return; }
    var w = A.state.settings && A.state.settings.wallpaper;
    if (w && typeof w.url === "string" && w.url.indexOf("data:") === 0) {
      migrateLocalWallpaper().then(function () { push(); }, function (e) {
        if (e && e.status === 401) return expired();
        setTimeout(schedule, 15000);
      });
      return;
    }
    var raw = snapshot();
    if (raw === lastSent) return;
    inflight = true; dirty = false;
    api("PUT", "config", { baseVersion: serverVer, data: JSON.parse(raw) }).then(function (d) {
      markSynced(d.version, raw); warned = false;
      if (d.migrated) pull(true).then(null, function () {}); // 服务器把旧的 data URL 壁纸转成了文件
      else if (d.overwrote === true) conflict();
      setTimeout(pullStatus, 4000); // 新地址由服务器尽快检测
    }, function (e) {
      if (e.status === 401) return expired();
      if (!warned) { warned = true; A.toast(e.status === 413 ? "配置太大，未能同步到 NAS" : "暂时无法同步到 NAS，已保存在本机，稍后自动重试"); }
      setTimeout(schedule, 15000);
    }).then(function () { inflight = false; if (dirty) schedule(); });
  }
  /** 另一台设备在本机上次同步之后改过配置：本机版本已覆盖，提供「改用服务器版」 */
  function conflict() {
    A.toast("另一台设备刚改过配置，已用本机版本覆盖", { duration: 10000, action: "改用服务器版", onAction: function () {
      api("GET", "config?prev=1").then(function (d) {
        if (!d || !d.data) throw new Error("没有可恢复的服务器版本");
        var net = A.state.settings && A.state.settings.net; // 内网/外网是每台设备自己的选择
        var s = normalize(d.data);
        if (net) s.settings.net = net;
        A.state = s; A.save(); A.render(); // A.save 已接上同步：作为新版本推回服务器
        A.toast("已改用另一台设备的版本");
      }).then(null, function (e) {
        if (e.status === 401) return expired();
        A.toast(e.message || "暂时拿不到服务器版本");
      });
    } });
  }
  function normalize(s) {
    s.settings = Object.assign(structuredClone(A.defaults.settings), s.settings || {});
    s.groups = Array.isArray(s.groups) ? s.groups : [];
    return s;
  }
  /** 从服务器拉取（启动时缓存过期、或切回页面时其他设备改过） */
  function pull(force) {
    return api("GET", "config").then(function (d) {
      if (!d || !d.data) return false;
      if (!force && d.version <= serverVer) return false;
      if (!force && snapshot() !== lastSent && lastSent !== null) return false; // 本机有未同步的修改：以本机为准（后写覆盖）
      var net = A.state.settings && A.state.settings.net; // 内网/外网是每台设备自己的选择
      var s = normalize(d.data);
      if (net) s.settings.net = net;
      A.state = s; A.save(); A.render();
      markSynced(d.version, snapshot());
      return true;
    });
  }

  /* ---------------------------------------------------- 设置 → 账户 */
  function accountsPane() {
    var sp = document.querySelector(".x-set"), tabs = sp && sp.querySelector('[role="tablist"]');
    if (!sp || !tabs) return;
    var tab = document.createElement("button");
    tab.type = "button"; tab.setAttribute("role", "tab"); tab.setAttribute("data-tab", "账户"); tab.setAttribute("aria-selected", "false"); tab.textContent = "账户";
    tabs.appendChild(tab);
    var pane = document.createElement("div");
    pane.className = "x-set-p"; pane.setAttribute("role", "tabpanel"); pane.setAttribute("aria-label", "账户"); pane.hidden = true;
    sp.appendChild(pane);
    sp.addEventListener("click", function (e) {
      var t = e.target.closest("[data-tab]"); if (!t) return;
      var mine = t === tab;
      pane.hidden = !mine;
      if (mine) {
        sp.querySelectorAll("[data-pane]").forEach(function (p) { p.hidden = true; });
        sp.querySelectorAll("[data-tab]").forEach(function (b) { b.setAttribute("aria-selected", String(b === tab)); });
        draw();
      }
    });

    function draw() {
      var u = N.user || {};
      if (!N.auth) {
        pane.innerHTML = '<p class="x-gt">账户</p><div class="x-gl"><div class="x-row"><span>登录已关闭</span></div></div>' +
          '<p class="x-hint">当前以 NOCTURNE_NO_AUTH=1 运行，任何能访问这个地址的人都能修改配置。只建议在纯内网使用。</p>';
        return;
      }
      pane.innerHTML = '<p class="x-gt">当前账户</p><div class="x-gl"><div class="x-row"><span>' + esc(u.name) + (u.admin ? '<span class="nc-tag">管理员</span>' : "") + '</span><button type="button" class="nc-mini is-red" data-u="logout">退出登录</button></div></div>' +
        '<p class="x-gt">修改密码</p><div class="x-gl nc-form" data-f="pw">' +
        '<label class="x-row"><span>当前密码</span><input type="password" name="old" autocomplete="current-password"></label>' +
        '<label class="x-row"><span>新密码</span><input type="password" name="password" autocomplete="new-password" placeholder="至少 6 位"></label>' +
        '<label class="x-row"><span>确认新密码</span><input type="password" name="password2" autocomplete="new-password"></label>' +
        '<p class="x-err" data-err hidden></p><div class="x-acts"><button type="button" class="x-pb is-amber" data-u="chpw">修改密码</button></div></div>' +
        (u.admin ? '<p class="x-gt">所有用户</p><div class="x-gl nc-ul" data-users><div class="x-row"><span>加载中…</span></div></div>' +
          '<p class="x-gt">添加用户</p><div class="x-gl nc-form" data-f="add">' +
          '<label class="x-row"><span>用户名</span><input type="text" name="name" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="字母或数字" maxlength="32"></label>' +
          '<label class="x-row"><span>初始密码</span><input type="password" name="password" autocomplete="new-password" placeholder="至少 6 位"></label>' +
          '<label class="x-row"><span>设为管理员</span><input class="x-tg" type="checkbox" role="switch" name="admin"></label>' +
          '<p class="x-err" data-err hidden></p><div class="x-acts"><button type="button" class="x-pb is-amber" data-u="add">添加</button></div></div>' : "") +
        '<p class="x-hint">每个账户的分组和设置分别保存在 NAS 上，换设备登录即可同步。</p>';
      if (u.admin) loadUsers();
    }
    function formErr(f, m) { var e = f.querySelector("[data-err]"); e.textContent = m || ""; e.hidden = !m; }
    function loadUsers() {
      var box = pane.querySelector("[data-users]");
      api("GET", "users").then(function (list) {
        box.innerHTML = list.map(function (x) {
          var self = x.name === N.user.name;
          return '<div class="x-row" data-name="' + esc(x.name) + '"><span class="nc-name">' + esc(x.name) + (x.admin ? '<span class="nc-tag">管理员</span>' : "") + (self ? '<span class="nc-badge">（你）</span>' : "") + "</span>" +
            '<button type="button" class="nc-mini" data-u="reset">重置密码</button>' + (self ? "" : '<button type="button" class="nc-mini is-red" data-u="del">删除</button>') + "</div>";
        }).join("");
      }, function (e) { box.innerHTML = '<div class="x-row"><span>' + esc(e.message) + "</span></div>"; });
    }
    pane.addEventListener("click", function (e) {
      var b = e.target.closest("[data-u]"); if (!b) return;
      var a = b.getAttribute("data-u"), row = b.closest("[data-name]"), name = row && row.getAttribute("data-name");
      if (a === "logout") {
        api("POST", "logout").then(null, function () {}).then(function () {
          ls("del", KEY); ls("del", VER); ls("del", OWNER); location.reload();
        });
      } else if (a === "chpw") {
        var f = pane.querySelector('[data-f="pw"]'), o = f.querySelector('[name="old"]'), p1 = f.querySelector('[name="password"]'), p2 = f.querySelector('[name="password2"]');
        if (p1.value.length < 6) return formErr(f, "新密码至少 6 位");
        if (p1.value !== p2.value) return formErr(f, "两次输入的新密码不一致");
        api("POST", "password", { old: o.value, password: p1.value }).then(function () {
          formErr(f, ""); o.value = p1.value = p2.value = ""; A.toast("密码已修改，其他设备需要重新登录");
        }, function (x) { formErr(f, x.message); });
      } else if (a === "add") {
        var g = pane.querySelector('[data-f="add"]'), n = g.querySelector('[name="name"]'), pw = g.querySelector('[name="password"]'), ad = g.querySelector('[name="admin"]');
        api("POST", "users", { name: n.value.trim(), password: pw.value, admin: ad.checked }).then(function () {
          formErr(g, ""); A.toast("已添加用户「" + n.value.trim() + "」"); n.value = pw.value = ""; ad.checked = false; loadUsers();
        }, function (x) { formErr(g, x.message); });
      } else if (a === "reset") {
        if (row.querySelector(".nc-pw")) return;
        var box = document.createElement("div"); box.className = "nc-pw";
        box.innerHTML = '<input type="password" autocomplete="new-password" placeholder="新密码（至少 6 位）"><button type="button" class="nc-mini" data-u="reset-ok">确定</button><button type="button" class="nc-mini" data-u="reset-no">取消</button>';
        row.appendChild(box); box.querySelector("input").focus();
      } else if (a === "reset-no") {
        b.closest(".nc-pw").remove();
      } else if (a === "reset-ok") {
        var inp = b.closest(".nc-pw").querySelector("input");
        if (inp.value.length < 6) { A.toast("密码至少 6 位"); return; }
        api("POST", "users/" + encodeURIComponent(name) + "/password", { password: inp.value }).then(function () {
          A.toast("已重置「" + name + "」的密码"); loadUsers();
        }, function (x) { A.toast(x.message); });
      } else if (a === "del") {
        if (b.getAttribute("data-sure") !== "1") { b.setAttribute("data-sure", "1"); b.textContent = "确认删除？"; setTimeout(function () { if (b.isConnected) { b.removeAttribute("data-sure"); b.textContent = "删除"; } }, 4000); return; }
        api("DELETE", "users/" + encodeURIComponent(name)).then(function () { A.toast("已删除用户「" + name + "」及其配置"); loadUsers(); }, function (x) { A.toast(x.message); });
      }
    });
  }

  /* --------------------------------------------------- 关联容器（可选） */
  var dockerInfo = null, editingId = null, pendingC = null;
  function containerField() {
    function fetchDocker() { return api("GET", "docker").then(function (d) { dockerInfo = d; return d; }, function () { dockerInfo = { available: false, containers: [] }; return dockerInfo; }); }
    fetchDocker();
    A.on("edit-item", function (d) { editingId = d && d.id; });
    A.on("add-item", function () { editingId = null; });
    function find(id) {
      var r = null;
      A.state.groups.forEach(function (g) { (g.items || []).forEach(function (i) { if (i.id === id) r = i; }); });
      return r;
    }
    function allIds() { var s = {}; A.state.groups.forEach(function (g) { (g.items || []).forEach(function (i) { s[i.id] = 1; }); }); return s; }
    function inject(sh) {
      var more = sh.querySelector(".x-more");
      if (!more || more.querySelector("[data-nc-c]") || !dockerInfo || !dockerInfo.available) return;
      var item = editingId ? find(editingId) : null, cur = (item && item.container) || "";
      var wrap = document.createElement("div");
      wrap.className = "x-f"; wrap.setAttribute("data-nc-c", "");
      wrap.innerHTML = '<div class="x-lab"><label for="x-f-container">关联容器</label><span>可选</span></div>' +
        '<input id="x-f-container" type="text" list="nc-containers" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="例如 emby（HTTP 检测不到时用容器状态）">' +
        '<datalist id="nc-containers">' + dockerInfo.containers.map(function (c) { return '<option value="' + esc(c.name) + '">' + esc(c.state + " · " + c.status) + "</option>"; }).join("") + "</datalist>";
      more.appendChild(wrap);
      wrap.querySelector("input").value = cur;
      if (cur) more.open = true;
    }
    function attach(sh) {
      new MutationObserver(function () { pendingC = null; inject(sh); }).observe(sh, { childList: true });
      function capture() {
        var i = sh.querySelector("#x-f-container"); if (!i) return;
        pendingC = { id: editingId, value: i.value.trim(), ids: allIds() };
      }
      sh.addEventListener("click", function (e) { if (e.target.closest("[data-a=save]")) capture(); }, true);
      sh.addEventListener("submit", capture, true);
    }
    var sh = document.querySelector(".x-is");
    if (sh) attach(sh);
    A.on("change", function (d) {
      if (!pendingC || !d || (d.label !== "add-item" && d.label !== "edit-item")) return;
      var p = pendingC; pendingC = null;
      var id = p.id;
      if (!id) { var now = allIds(); id = Object.keys(now).filter(function (k) { return !p.ids[k]; })[0]; }
      var it = id && find(id); if (!it) return;
      if ((it.container || "") === p.value) return;
      if (p.value) it.container = p.value; else delete it.container;
      A.save(); schedule();
    });
  }

  /* ------------------------------------------------------------- boot */
  function boot() {
    if (!N.user) { authScreen(); return; }
    var foot = document.querySelector(".x-foot5");
    if (foot) foot.textContent = N.auth ? "配置已同步到 NAS · 账户 " + N.user.name : "配置已同步到 NAS";
    accountsPane();
    containerField();

    var start;
    if (N.stale) {
      start = pull(true).then(unlock, function (e) {
        unlock();
        lastSent = snapshot(); // 只推送之后真正的修改，避免用旧缓存覆盖服务器
        if (e.status === 401) return expired();
        A.toast("连不上 NAS，先显示本机缓存");
      });
    } else {
      unlock();
      lastSent = snapshot();
      if (N.version) markSynced(N.version, lastSent);
      if (N.migrate) { // 首次登录：服务器为空，把这台浏览器里原有的配置传上去
        lastSent = null;
        push();
        A.toast("已把这台设备上的原有配置同步到 NAS");
      }
      start = Promise.resolve();
    }
    start.then(function () {
      A.on("change", schedule);
      A.on("render", schedule);
      var save = A.save;
      A.save = function () { save.apply(this, arguments); schedule(); };
      pullStatus();
      setInterval(function () { if (!document.hidden) pullStatus(); }, 30000);
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) { if (timer) { clearTimeout(timer); push(); } return; }
        pull(false).then(null, function () {}); pullStatus();
      });
      window.addEventListener("online", function () { schedule(); pullStatus(); });
      window.addEventListener("pagehide", function () { if (snapshot() !== lastSent) { try { fetch("api/config", { method: "PUT", keepalive: true, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseVersion: serverVer, data: A.state }) }); } catch (e) {} } });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
