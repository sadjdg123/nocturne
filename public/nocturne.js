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
  var KEY = "yeqv.v1", OWNER = "nocturne.owner", VER = "nocturne.ver", DIRTY = "nocturne.dirty";
  var KEEPALIVE_MAX = 60000; // 浏览器对 keepalive 请求体的上限约 64KB

  function ls(op, k, v) { try { return op === "get" ? localStorage.getItem(k) : op === "del" ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { return null; } }
  function bytes(str) { try { return new Blob([str]).size; } catch (e) { return str.length * 3; } }
  /** opts: {signal, keepalive, raw:已序列化的 body} */
  function api(method, p, body, opts) {
    opts = opts || {};
    var o = { method: method, credentials: "same-origin", cache: "no-store", headers: {} };
    if (body !== undefined) { o.headers["Content-Type"] = "application/json"; o.body = opts.raw || JSON.stringify(body); }
    if (opts.signal) o.signal = opts.signal;
    if (opts.keepalive) o.keepalive = true;
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
  /* ------------------------------------------- 上传的图标（存 NAS 文件） */
  /** 上传图标 Blob（png/jpeg/webp），成功返回配置里用的地址 "api/icons/<id>" */
  A.uploadIcon = function (blob) {
    return fetch("api/icons", { method: "POST", credentials: "same-origin", headers: { "Content-Type": blob.type || "image/png" }, body: blob }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.error || ("HTTP " + r.status)); e.status = r.status; throw e; }
        return d.url;
      });
    });
  };
  /** 导出时把 NAS 上的图标内嵌成 data URL（导入到别的实例 / 纯静态页也能显示）；壁纸文件太大，不内嵌 */
  A.exportState = function () {
    var s = structuredClone(A.state), jobs = [];
    (s.groups || []).forEach(function (g) { (g.items || []).forEach(function (i) {
      var ic = i.icon, v = ic && ic.type === "image" && String(ic.value || "");
      if (!v || !/^api\/icons\//.test(v)) return;
      jobs.push(fetch(v, { credentials: "same-origin" }).then(function (r) { if (!r.ok) throw 0; return r.blob(); }).then(function (b) {
        return new Promise(function (res) { var fr = new FileReader(); fr.onload = function () { ic.value = fr.result; res(); }; fr.onerror = function () { res(); }; fr.readAsDataURL(b); });
      }).then(null, function () {}));
    }); });
    return Promise.all(jobs).then(function () { return s; });
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
    ".nc-pw input{flex:1;min-width:0;height:36px;padding:0 10px;border:1px solid var(--x-line);border-radius:10px;background:rgba(255,255,255,.06);color:var(--x-text);font:400 16px var(--x-ui);outline:none}", /* 16px：iOS 不自动放大 */
    ".nc-form .x-row input[type=password]{flex:1;width:auto;min-width:0;height:36px;padding:0;border:0;background:none;color:var(--x-text);font:400 16px var(--x-ui);text-align:right;outline:none}",
    ".nc-form .x-acts{padding:4px 16px 12px}",
    ".nc-badge{display:inline-block;margin-left:6px;font-size:12px;color:var(--x-mist)}",
    ".nc-bk .nc-meta{display:block;margin-top:2px;font-size:12px;color:var(--x-mist);font-variant-numeric:tabular-nums}",
    ".nc-bk .x-row{gap:10px}",
    ".nc-bk .nc-mini{flex:none}",
    ".nc-cfb{z-index:70}.nc-cfs{z-index:71}",
    ".nc-cfp{margin:0 16px 14px;color:var(--x-text);font-size:14px;line-height:1.6}",
    ".nc-cfn{margin:0 16px 10px;padding-top:6px;color:var(--x-mist);font-size:12px;line-height:1.5}",
    ".nc-cfs .x-row{border-radius:0}"
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
      '<input class="nc-in" name="password" type="password" autocomplete="' + (setup ? "new-password" : "current-password") + '" placeholder="密码' + (setup ? "（至少 8 位）" : "") + '" required>' +
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
        if (pw.length < 8) { err.textContent = "密码至少 8 位"; return; }
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
  /* 乐观并发：每次推送带 baseVersion（本机基于的服务器版本）和 opId。另一台设备在这之间改过 → 服务器回 409，不覆盖，
   * 这里弹出冲突面板让用户选：使用服务器版（本机版先存入「较早的版本」）/ 用本机版覆盖（服务器版先备份）/ 导出本机版。
   * 设备本地状态不参与同步：内网/外网切换（settings.net）和「最近使用」（recent）只存在这台设备上，切换 / 点击不会产生新版本或冲突。 */
  var serverVer = N.version || 0, lastSent = null, timer = null, inflight = false, dirty = false, warned = false, bigWarned = false, badWarned = false;
  var restoreNext = false, forceNext = null, conflictInfo = null;
  var OP = "nocturne.op";
  /** 参与同步的内容：去掉设备本地的 settings.net 与 recent */
  function snapshot() {
    var st = A.state;
    return JSON.stringify(st, function (k, v) {
      if (this === st && k === "recent") return undefined;
      if (st && this === st.settings && k === "net") return undefined;
      return v;
    });
  }
  /** 拉下来的服务器配置 + 本机的设备状态 */
  function adopt(data) {
    var s = normalize(data), cur = A.state || {};
    var net = cur.settings && cur.settings.net;
    if (net) s.settings.net = net; else delete s.settings.net;
    s.recent = Array.isArray(cur.recent) ? cur.recent.slice() : [];
    return s;
  }
  function hashStr(str) { var h = 5381; for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + "." + str.length.toString(36); }
  function newOpId() {
    var a = new Uint8Array(12);
    try { crypto.getRandomValues(a); } catch (e) { for (var i = 0; i < a.length; i++) a[i] = Math.random() * 256; }
    return Array.prototype.map.call(a, function (x) { return (x < 16 ? "0" : "") + x.toString(16); }).join("");
  }
  /** 同一份内容的推送（失败重试、页面关闭前的 keepalive、下次打开的补推）共用一个 opId：服务器据此识别重复推送 */
  function opFor(raw) {
    var h = hashStr(raw), o = null;
    try { o = JSON.parse(ls("get", OP) || "null"); } catch (e) { o = null; }
    if (o && o.h === h && o.id) return o.id;
    var id = newOpId(); ls("set", OP, JSON.stringify({ id: id, h: h }));
    return id;
  }
  function opDone(raw) { try { var o = JSON.parse(ls("get", OP) || "null"); if (o && o.h === hashStr(raw)) ls("del", OP); } catch (e) { /* ignore */ } }
  /* 持久化的「本机有没推上去的修改」标记：页面被关掉 / NAS 连不上时，下次打开据此补推，而不是当成已同步 */
  function markDirty() { if (lastSent === null || snapshot() !== lastSent) ls("set", DIRTY, "1"); }
  function markSynced(ver, raw) {
    serverVer = ver; lastSent = raw;
    ls("set", VER, String(ver)); ls("set", OWNER, N.user.name);
    if (snapshot() === raw) ls("del", DIRTY);
  }
  function schedule() { if (!N.user) return; markDirty(); clearTimeout(timer); timer = setTimeout(push, 800); }
  /** opts.keepalive：页面切到后台时用，body 不超过 60KB 才带 keepalive（超过会被浏览器直接拒绝） */
  function push(opts) {
    opts = opts && opts.keepalive ? opts : {};
    if (inflight) { dirty = true; return; }
    if (conflictInfo) return; // 冲突还没处理：先不推，本机修改照常存在本机（脏标记保留）
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
    var restore = restoreNext; restoreNext = false;
    var force = forceNext; forceNext = null;
    var body = { baseVersion: serverVer, opId: opFor(raw), data: JSON.parse(raw) };
    if (restore) body.restore = true; // 恢复较早的版本：服务器先把当前版本存一份快照再写入
    if (force) { body.force = true; body.expectVersion = force.expect; } // 用户明确选择「用本机版覆盖」
    var str = JSON.stringify(body), size = bytes(str);
    if (size > 800 * 1024 && !bigWarned) { bigWarned = true; A.toast("配置已有 " + Math.round(size / 1024) + "KB，接近上限，可以删掉一些不用的上传图片"); }
    api("PUT", "config", body, { raw: str, keepalive: opts.keepalive && size < KEEPALIVE_MAX }).then(function (d) {
      warned = false; badWarned = false;
      if (d.stale) { lastSent = raw; return pull(true).then(null, function (e) { if (e && e.status === 401) expired(); }); } // 旧版服务器的补推判定
      markSynced(d.version, raw); opDone(raw);
      if (d.duplicate && d.current > d.version) pull(false).then(null, function () {}); // 这次修改其实早就同步过，之后服务器又有新版本：拉下来（本机若又改过则保留本机）
      else if (d.migrated) pull(true).then(null, function () {}); // 服务器把旧的 data URL 壁纸 / 图标转成了文件
      if (d.forced) A.toast("已用本机版本覆盖 · 服务器上原来的版本已存入「较早的版本」", { duration: 6000 });
      setTimeout(pullStatus, 4000); // 新地址由服务器尽快检测
    }, function (e) {
      if (restore) restoreNext = true;
      if (e.status === 401) return expired();
      if (e.status === 409 && e.data && e.data.conflict) return conflict(e.data);
      if (e.status === 400 && e.data && e.data.invalid) { // 有不安全的地址：改了再推，不自动重试
        if (!badWarned) { badWarned = true; A.toast("有 " + e.data.invalid.length + " 个地址无效（只支持 http/https），未同步：" + e.data.invalid.slice(0, 2).map(function (x) { return x.where; }).join("、"), { duration: 8000 }); }
        return;
      }
      if (!warned) { warned = true; A.toast(e.status === 413 ? "配置太大，未能同步到 NAS" : "暂时无法同步到 NAS，已保存在本机，稍后自动重试"); }
      setTimeout(schedule, 15000);
    }).then(function () { inflight = false; if (dirty) schedule(); });
  }
  function normalize(s) {
    s.settings = Object.assign(structuredClone(A.defaults.settings), s.settings || {});
    s.groups = Array.isArray(s.groups) ? s.groups : [];
    return s;
  }
  /** 从服务器拉取（启动时缓存过期、或切回页面时其他设备改过）。本机有未同步的修改时（非 force）不拉，绝不丢本机修改 */
  function pull(force, opts) {
    return api("GET", "config", undefined, opts).then(function (d) {
      if (!d || !d.data) return false;
      if (!force && d.version <= serverVer) return false;
      if (!force && snapshot() !== lastSent && lastSent !== null) return false; // 本机有未同步的修改：保留本机，推送时由服务器判冲突
      A.state = adopt(d.data); A.save(); A.render();
      markSynced(d.version, snapshot());
      return true;
    });
  }

  /* ------------------------------------------------------- 冲突面板 */
  var cfBack = null, cfSheet = null;
  function fmtWhen(t) {
    var d = new Date(t); if (isNaN(d)) return "";
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function stampName() { var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  function downloadJSON(name, obj) {
    var url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
    var a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function exportLocal() {
    var name = "yeqv-local-" + stampName() + ".json";
    return (A.exportState ? A.exportState() : Promise.resolve(A.state)).then(function (st) { downloadJSON(name, st); }, function () { downloadJSON(name, A.state); });
  }
  function closeConflict() {
    if (!cfSheet) return;
    var sh = cfSheet, bk = cfBack; cfSheet = cfBack = null;
    sh.classList.remove("is-on"); bk.classList.remove("is-on");
    setTimeout(function () { sh.remove(); bk.remove(); }, 300);
  }
  function conflict(info) {
    conflictInfo = info;
    if (document.hidden) return; // 页面在后台：切回来时再弹
    showConflict();
  }
  function showConflict() {
    var info = conflictInfo; if (!info || cfSheet) return;
    cfBack = document.createElement("div"); cfBack.className = "x-sback nc-cfb";
    cfSheet = document.createElement("div"); cfSheet.className = "x-sheet x-glass nc-cfs";
    cfSheet.setAttribute("role", "dialog"); cfSheet.setAttribute("aria-modal", "true"); cfSheet.setAttribute("aria-label", "配置冲突");
    var when = fmtWhen(info.updatedAt);
    cfSheet.innerHTML = "<h3>配置冲突</h3>" +
      '<p class="nc-cfp">另一台设备' + (when ? "在 " + esc(when) + " " : "") + "改过配置（服务器 v" + (+info.version || 0) + " · " + (+info.groups || 0) + " 个分组 · " + (+info.items || 0) + " 个项目），这台设备也有还没同步的修改。为免互相覆盖，已暂停同步，请选择保留哪一份：</p>" +
      '<button type="button" class="x-row" data-cf="server">使用服务器版</button>' +
      '<p class="nc-cfn">本机这份会先存入 设置 → 账户 →「恢复较早的版本」，随时可以找回。</p>' +
      '<button type="button" class="x-row" data-cf="local">用本机版覆盖</button>' +
      '<p class="nc-cfn">服务器上的版本会先备份，同样可以在「恢复较早的版本」里找回。</p>' +
      '<button type="button" class="x-row" data-cf="export">导出本机版（JSON 文件）</button>' +
      '<button type="button" class="x-row is-cancel" data-cf="later">稍后处理</button>';
    document.body.append(cfBack, cfSheet);
    void cfSheet.offsetWidth; cfBack.classList.add("is-on"); cfSheet.classList.add("is-on");
    cfSheet.querySelector('[data-cf="server"]').focus({ preventScroll: true });
    cfBack.addEventListener("click", later);
    cfSheet.addEventListener("click", function (e) {
      var b = e.target.closest("[data-cf]"); if (!b || b.disabled) return;
      var a = b.getAttribute("data-cf");
      if (a === "export") exportLocal().then(function () { A.toast("已导出本机版本"); });
      else if (a === "later") later();
      else if (a === "local") { forceNext = { expect: info.version }; conflictInfo = null; closeConflict(); lastSent = null; push(); }
      else if (a === "server") useServer(b);
    });
  }
  function later() {
    closeConflict();
    A.toast("本机修改暂未同步（已保存在本机）", { duration: 10000, action: "处理冲突", onAction: showConflict });
  }
  function useServer(btn) {
    var raw = snapshot(), all = cfSheet ? cfSheet.querySelectorAll("button") : [];
    Array.prototype.forEach.call(all, function (x) { x.disabled = true; });
    btn.textContent = "处理中…";
    var unlockBtns = function () { Array.prototype.forEach.call(all, function (x) { x.disabled = false; }); btn.textContent = "使用服务器版"; };
    api("POST", "config/stash", { baseVersion: serverVer, data: JSON.parse(raw) }).then(null, function (e) {
      if (e.status === 401) throw e;
      if (e.status === 400 || e.status === 413) return exportLocal().then(function () { A.toast("本机版本无法存到 NAS（" + e.message + "），已导出成文件", { duration: 8000 }); });
      throw e;
    }).then(function () { return api("GET", "config"); }).then(function (d) {
      if (!d || !d.data) throw new Error("服务器上没有配置");
      conflictInfo = null; closeConflict();
      A.state = adopt(d.data); A.save(); A.render();
      markSynced(d.version, snapshot()); opDone(raw);
      A.toast("已改用服务器版本 · 本机版本已存入「较早的版本」", { duration: 6000 });
    }).then(null, function (e) {
      unlockBtns();
      if (e.status === 401) return expired();
      A.toast(e.message ? "暂时拿不到服务器版本：" + e.message : "暂时拿不到服务器版本");
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

    /* 「恢复较早的版本」：列出 NAS 上的环形备份（被别的设备覆盖 / 被替换掉的配置），选一份恢复 */
    var BK_HTML = '<p class="x-gt">数据</p><div class="x-gl nc-ul nc-bk" data-bk><div class="x-row"><span>恢复较早的版本</span><button type="button" class="nc-mini" data-u="bk">查看</button></div></div>' +
      '<p class="x-hint">NAS 会定期（每 30 分钟或每 20 个版本）给配置留一份快照，冲突时被替换的版本也会先存下来，最多保留 30 份。恢复前当前版本也会先存一份，随时可以换回来。壁纸图片不在版本历史里。</p>';
    var KIND = { auto: "定期快照", replaced: "被覆盖前", restore: "恢复前", local: "冲突时的本机版本" };
    function fmtTime(t) {
      var d = new Date(t); if (isNaN(d)) return "";
      var p = function (n) { return (n < 10 ? "0" : "") + n; }, now = new Date();
      return (d.getFullYear() !== now.getFullYear() ? d.getFullYear() + "年" : "") + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + p(d.getHours()) + ":" + p(d.getMinutes());
    }
    function bkClose() {
      var box = pane.querySelector("[data-bk]"); if (!box) return;
      box.querySelectorAll("[data-id], [data-bk-msg]").forEach(function (r) { r.remove(); });
      var b = box.querySelector('[data-u="bk"]'); if (b) b.textContent = "查看";
    }
    function bkOpen() {
      var box = pane.querySelector("[data-bk]"), b = box.querySelector('[data-u="bk"]');
      bkClose(); b.textContent = "收起";
      var msg = document.createElement("div"); msg.className = "x-row"; msg.setAttribute("data-bk-msg", ""); msg.innerHTML = "<span>加载中…</span>";
      box.appendChild(msg);
      api("GET", "config/backups").then(function (list) {
        if (!box.isConnected || b.textContent !== "收起") return;
        if (!list.length) { msg.innerHTML = '<span class="nc-name">还没有较早的版本</span>'; return; }
        msg.remove();
        box.insertAdjacentHTML("beforeend", list.map(function (x) {
          return '<div class="x-row" data-id="' + esc(x.id) + '" data-label="' + esc(fmtTime(x.time || x.updatedAt || x.at) + "（v" + (+x.version || 0) + "）") + '"><span class="nc-name">' + esc(fmtTime(x.time || x.updatedAt || x.at)) +
            '<span class="nc-meta">v' + (+x.version || 0) + " · " + (+x.groups || 0) + " 个分组 · " + (+x.items || 0) + " 个项目" + (KIND[x.kind] ? " · " + KIND[x.kind] : "") + "</span></span>" +
            '<button type="button" class="nc-mini" data-u="bk-go">恢复</button></div>';
        }).join(""));
      }, function (e) {
        if (e.status === 401) return expired();
        msg.innerHTML = "<span>" + esc(e.message || "暂时拿不到备份列表") + "</span>";
      });
    }
    function bkRestore(id, label) {
      api("GET", "config?backup=" + encodeURIComponent(id)).then(function (d) {
        if (!d || !d.data) throw new Error("这个版本已经不在了");
        restoreNext = true; // 推上去时带 restore:true：当前版本先进服务器备份，可以再换回来
        A.state = adopt(d.data); A.save(); A.render(); // 内网/外网、最近使用是这台设备自己的，不跟着恢复
        bkClose();
        A.toast("已恢复到 " + label + "的版本");
      }).then(null, function (e) {
        if (e.status === 401) return expired();
        A.toast(e.message || "恢复失败");
      });
    }

    function draw() {
      var u = N.user || {};
      if (!N.auth) {
        pane.innerHTML = '<p class="x-gt">账户</p><div class="x-gl"><div class="x-row"><span>登录已关闭</span></div></div>' +
          '<p class="x-hint">当前以 NOCTURNE_NO_AUTH=1 运行，任何能访问这个地址的人都能修改配置。只建议在纯内网使用。</p>' + BK_HTML;
        return;
      }
      pane.innerHTML = '<p class="x-gt">当前账户</p><div class="x-gl"><div class="x-row"><span>' + esc(u.name) + (u.admin ? '<span class="nc-tag">管理员</span>' : "") + '</span><button type="button" class="nc-mini is-red" data-u="logout">退出登录</button></div></div>' +
        '<p class="x-gt">修改密码</p><div class="x-gl nc-form" data-f="pw">' +
        '<label class="x-row"><span>当前密码</span><input type="password" name="old" autocomplete="current-password"></label>' +
        '<label class="x-row"><span>新密码</span><input type="password" name="password" autocomplete="new-password" placeholder="至少 8 位"></label>' +
        '<label class="x-row"><span>确认新密码</span><input type="password" name="password2" autocomplete="new-password"></label>' +
        '<p class="x-err" data-err hidden></p><div class="x-acts"><button type="button" class="x-pb is-amber" data-u="chpw">修改密码</button></div></div>' +
        (u.admin ? '<p class="x-gt">所有用户</p><div class="x-gl nc-ul" data-users><div class="x-row"><span>加载中…</span></div></div>' +
          '<p class="x-gt">添加用户</p><div class="x-gl nc-form" data-f="add">' +
          '<label class="x-row"><span>用户名</span><input type="text" name="name" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="字母或数字" maxlength="32"></label>' +
          '<label class="x-row"><span>初始密码</span><input type="password" name="password" autocomplete="new-password" placeholder="至少 8 位"></label>' +
          '<label class="x-row"><span>设为管理员</span><input class="x-tg" type="checkbox" role="switch" name="admin"></label>' +
          '<p class="x-err" data-err hidden></p><div class="x-acts"><button type="button" class="x-pb is-amber" data-u="add">添加</button></div></div>' : "") +
        '<p class="x-hint">每个账户的分组和设置分别保存在 NAS 上，换设备登录即可同步；内网/外网切换和「最近使用」只保存在这台设备上。</p>' +
        (u.admin ? '<p class="x-hint" data-diag hidden></p>' : "") + BK_HTML;
      if (u.admin) { loadUsers(); loadDiag(); }
    }
    /** 管理员可见的连接诊断：帮你确认反向代理的地址该不该填进 TRUSTED_PROXY_CIDRS */
    function loadDiag() {
      var el = pane.querySelector("[data-diag]"); if (!el) return;
      api("GET", "health").then(function (h) {
        var c = h && h.client; if (!c || !el.isConnected) return;
        el.textContent = "连接诊断：服务器看到的直连地址 " + c.peer + " → 识别为客户端 " + c.ip +
          (c.trustedPeer ? "（经可信代理）" : c.forwardedHeaders ? "（收到了转发头，但 " + c.peer + " 不在 TRUSTED_PROXY_CIDRS 里，已忽略；若它是你的反向代理，请把它填进去）" : "（直连，没有经过反向代理）") +
          (c.https ? " · HTTPS" : "");
        el.hidden = false;
      }, function () {});
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
      if (a === "bk") {
        if (b.textContent === "收起") bkClose(); else bkOpen();
      } else if (a === "bk-go") {
        var br = b.closest("[data-id]");
        if (b.getAttribute("data-sure") !== "1") { b.setAttribute("data-sure", "1"); b.textContent = "确认恢复？"; setTimeout(function () { if (b.isConnected) { b.removeAttribute("data-sure"); b.textContent = "恢复"; } }, 4000); return; }
        bkRestore(br.getAttribute("data-id"), br.getAttribute("data-label"));
      } else if (a === "logout") {
        api("POST", "logout").then(null, function () {}).then(function () {
          ls("del", KEY); ls("del", VER); ls("del", OWNER); ls("del", DIRTY); ls("del", OP); location.reload();
        });
      } else if (a === "chpw") {
        var f = pane.querySelector('[data-f="pw"]'), o = f.querySelector('[name="old"]'), p1 = f.querySelector('[name="password"]'), p2 = f.querySelector('[name="password2"]');
        if (p1.value.length < 8) return formErr(f, "新密码至少 8 位");
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
        box.innerHTML = '<input type="password" autocomplete="new-password" placeholder="新密码（至少 8 位）"><button type="button" class="nc-mini" data-u="reset-ok">确定</button><button type="button" class="nc-mini" data-u="reset-no">取消</button>';
        row.appendChild(box); box.querySelector("input").focus();
      } else if (a === "reset-no") {
        b.closest(".nc-pw").remove();
      } else if (a === "reset-ok") {
        var inp = b.closest(".nc-pw").querySelector("input");
        if (inp.value.length < 8) { A.toast("密码至少 8 位"); return; }
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

    var start, localVer = +ls("get", VER) || 0;
    if (N.dirty && N.version) {
      // 本机有上次没推上去的修改：先显示本机、推上去，绝不静默用服务器版覆盖。
      //  - 服务器没变：正常推送
      //  - 服务器变了：用本机旧的 ver 作 baseVersion 推。若这份修改其实已经同步过（同一个 opId）→ 服务器认出重复，拉最新版；
      //    否则 → 409 冲突面板，由用户选择
      unlock();
      serverVer = N.stale ? localVer : N.version;
      lastSent = null;
      push();
      start = Promise.resolve();
    } else if (N.stale) {
      // 信号差时别一直只看到壁纸：5 秒拉不到就先显示本机缓存
      var ac = window.AbortController ? new AbortController() : null, to = ac && setTimeout(function () { ac.abort(); }, 5000);
      start = pull(true, ac ? { signal: ac.signal } : null).then(function () { clearTimeout(to); unlock(); }, function (e) {
        clearTimeout(to); unlock();
        lastSent = snapshot(); // 只推送之后真正的修改，避免用旧缓存覆盖服务器
        serverVer = localVer; // 本机缓存基于旧版本：之后的推送会被识别为冲突（留备份），切回页面时也会再拉
        if (e.status === 401) return expired();
        A.toast("连不上 NAS，先显示本机缓存");
      });
    } else {
      unlock();
      lastSent = snapshot();
      if (N.version) markSynced(N.version, lastSent);
      else ls("del", DIRTY);
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
        // 切到后台（iOS 划走）：立刻推，带 keepalive，页面被冻结 / 关掉也能发完
        if (document.hidden) { if (timer || snapshot() !== lastSent) { clearTimeout(timer); timer = null; push({ keepalive: true }); } return; }
        if (conflictInfo) showConflict();
        pull(false).then(null, function () {}); pullStatus();
      });
      window.addEventListener("online", function () { schedule(); pullStatus(); });
      // 从往返缓存（bfcache）恢复：serverVer 可能已过时，先刷新，避免误报冲突
      window.addEventListener("pageshow", function (e) { if (e.persisted) { pull(false).then(null, function () {}); pullStatus(); } });
      window.addEventListener("pagehide", function () {
        if (snapshot() === lastSent || conflictInfo) return; // 冲突未处理时不发；正在发的那次可能会被页面卸载中断：照样补发（同一个 opId，服务器不会重复记版本）
        var raw = snapshot(), str = JSON.stringify({ baseVersion: serverVer, opId: opFor(raw), data: JSON.parse(raw) });
        markDirty();
        if (bytes(str) >= KEEPALIVE_MAX) return; // 太大发不出 keepalive：留着脏标记，下次打开补推
        try {
          fetch("api/config", { method: "PUT", keepalive: true, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: str })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) { if (d && d.version) { markSynced(d.version, raw); opDone(raw); } }) // 页面若进了 bfcache，恢复后这里会接着跑
            .catch(function () {});
        } catch (e) { /* 同步抛错（极少数浏览器）：下次打开靠脏标记补推 */ }
      });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
