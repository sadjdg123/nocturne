"use strict";
/* V2.4.0 · 图标抓取/剪贴板粘贴、桌面右键菜单、搜索框 Tab/前缀、⌘K 拼音首字母、单项目不检测、头部离线列表与即时重测、分组折叠
 *  1. pinyin.js + cmdrank.js：零依赖中文拼音首字母（白群晖→bqh、多音字、中英混排、子序列）及排序/高亮集成
 *  2. server.js Favicon 抓取（POST /api/icons/fetch）：HTML link 优先级、ICO（含 DIB 位图）转 PNG、SSRF/重定向/非管理员权限拦截、拒绝 SVG
 *  3. 单项目 noProbe（不检测状态）与主动重测（POST /api/status/recheck）：服务端不请求被静音项目、即时重测实时刷新状态、冷却与普通账户隔离
 *  4. jsdom 端到端：桌面右键菜单、搜索框 Tab 切引擎与触发词、⌘K 拼音搜项目/分组/操作、分组本机折叠（不同步）、编辑窗抓取图标与不检测开关、头部胶囊离线清单与重测 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const PY = require("../public/pinyin.js");
const R = require("../public/cmdrank.js");
const ST = require("../public/status.js");
const S = require("../server.js");
const { seedAccount, startServer, client, mockServer, waitFor, sleep } = require("./helpers");
const { openPage, SKIP } = require("./browser");

/* 构造一个合法的 1x1 红色 PNG 与 1x1 32-bit DIB ICO 夹具（零外部依赖） */
function makePng1x1() {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); crcTable[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const tb = Buffer.from(t), l = Buffer.alloc(4), cb = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); cb.writeUInt32BE(crc(Buffer.concat([tb, d])), 0); return Buffer.concat([l, tb, d, cb]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.from([0, 233, 178, 106, 255]))), chunk("IEND", Buffer.alloc(0))]);
}
function makeDibIco2x2() {
  const hdr = Buffer.alloc(6); hdr.writeUInt16LE(0, 0); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(1, 4);
  const dib = Buffer.alloc(40 + 2 * 2 * 4 + 2 * 4);
  dib.writeUInt32LE(40, 0); dib.writeInt32LE(2, 4); dib.writeInt32LE(4, 8); dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14);
  for (let i = 0; i < 4; i++) { dib[40 + i * 4] = 100; dib[40 + i * 4 + 1] = 150; dib[40 + i * 4 + 2] = 220; dib[40 + i * 4 + 3] = 255; }
  const ent = Buffer.alloc(16); ent[0] = 2; ent[1] = 2; ent.writeUInt16LE(1, 4); ent.writeUInt16LE(32, 6); ent.writeUInt32LE(dib.length, 8); ent.writeUInt32LE(22, 12);
  return Buffer.concat([hdr, ent, dib]);
}
function makePngIco(png) {
  const hdr = Buffer.alloc(6); hdr.writeUInt16LE(0, 0); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(1, 4);
  const ent = Buffer.alloc(16); ent[0] = 32; ent[1] = 32; ent.writeUInt16LE(1, 4); ent.writeUInt16LE(32, 6); ent.writeUInt32LE(png.length, 8); ent.writeUInt32LE(22, 12);
  return Buffer.concat([hdr, ent, png]);
}

const PNG1 = makePng1x1();
const ICO_DIB = makeDibIco2x2();
const ICO_PNG = makePngIco(PNG1);

test("pinyin.js + cmdrank.js: Chinese pinyin initials, polyphones, mixed text, and ranking", () => {
  assert.equal(PY.available, true, "Intl.Collator zh-CN pinyin available in Node");
  let m = PY.match("白群晖", "bqh");
  assert.ok(m && m.exact && m.prefix);
  assert.deepEqual(m.hits, [0, 1, 2]);
  assert.deepEqual(PY.match("黑群晖", "qh").hits, [1, 2]);
  assert.deepEqual(PY.match("存储与监控", "ccjk").hits, [0, 1, 3, 4], "subsequence pinyin");
  assert.deepEqual(PY.match("NAS监控", "nasjk").hits, [0, 1, 2, 3, 4], "mixed ASCII + CJK");
  assert.ok(PY.match("音乐", "yy") && PY.match("音乐", "yl"), "polyphone 乐");
  assert.ok(PY.match("重新检测", "cxjc") && PY.match("重新检测", "zxjc"), "polyphone 重");
  assert.equal(PY.match("Emby", "emb"), null, "pure ASCII skipped by pinyin");
  assert.equal(PY.match("白群晖", "白"), null, "non-ASCII query skipped by pinyin");

  const items = [
    { id: "bqh", title: "白群晖", desc: "主存储" },
    { id: "hqh", title: "黑群晖", desc: "备份存储" },
    { id: "mp", title: "MoviePilot", desc: "影视订阅", aliases: ["影视订阅"] },
    { id: "yy", title: "Emby", desc: "影音服务器" },
  ].map((item) => ({ item, urls: [] }));
  assert.deepEqual(R.rank(items, "bqh", []).map((x) => x.entry.item.id), ["bqh"]);
  assert.deepEqual(R.rank(items, "qh", []).map((x) => x.entry.item.id), ["bqh", "hqh"]);
  assert.deepEqual(R.rank(items, "ysdy", []).map((x) => x.entry.item.id), ["mp"]);
  assert.equal(R.rank(items, "ysdy", [])[0].r.alias, "影视订阅");
  assert.deepEqual(R.rank(items, "yyfwq", []).map((x) => x.entry.item.id), ["yy"]);
});

test("status.js: muted (noProbe) stays excluded from totals, offline count, and unchecked note", () => {
  const m1 = ST.classify({ source: "server", status: "muted", up: false });
  const m2 = ST.classify({ source: "none", reason: "muted" });
  assert.equal(m1.s, "muted"); assert.equal(m2.s, "muted");
  assert.equal(ST.short(m1), "");
  const up = ST.classify({ source: "server", up: true, status: "up", ms: 12, checkedAt: new Date().toISOString() });
  const sm = ST.summary([up, m1, m2]);
  assert.equal(sm.total, 1); assert.equal(sm.online, 1); assert.equal(sm.counts.muted, 2);
  assert.equal(sm.note, undefined, "muted items do not inflate 未检测 note");
  assert.equal(ST.summary([m1]).line, "这些服务已关闭状态检测");
});

test("server.js favicon helpers: parseFaviconLinks ranking & icoToPng (PNG + DIB)", () => {
  const html = `<html><head>
    <link rel="icon" type="image/svg+xml" href="/logo.svg">
    <link rel="shortcut icon" href="/small.ico" sizes="16x16">
    <link rel="icon" type="image/png" sizes="32x32" href="/img/icon-32.png">
    <link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
  </head></html>`;
  const links = S.parseFaviconLinks(html, "https://app.example.com/sub/page");
  assert.equal(links[0], "https://app.example.com/apple.png", "apple-touch-icon ranked first");
  assert.equal(links[1], "https://app.example.com/img/icon-32.png", "PNG icon ranked before small ico");
  assert.ok(!links.some((u) => /\.svg/i.test(u)), "SVG skipped for bitmap icon storage");
  assert.ok(links.includes("https://app.example.com/favicon.ico"), "root /favicon.ico fallback included");

  const fromPngIco = S.icoToPng(ICO_PNG);
  assert.ok(Buffer.isBuffer(fromPngIco) && fromPngIco.equals(PNG1), "extracts embedded PNG from ICO");
  const fromDibIco = S.icoToPng(ICO_DIB);
  assert.ok(Buffer.isBuffer(fromDibIco) && fromDibIco.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "converts 32-bit DIB ICO to valid PNG");
  assert.equal(fromDibIco.readUInt32BE(16), 2, "PNG width = 2");
  assert.equal(fromDibIco.readUInt32BE(20), 2, "PNG height = 2");
  assert.equal(S.icoToPng(Buffer.from("not an ico")), null);
});

test("POST /api/icons/fetch: fetches HTML favicon & ICO fallback; blocks SSRF, redirect-to-metadata, SVG-only, and non-admin", async (t) => {
  const mock = await mockServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end('<html><head><link rel="icon" type="image/png" href="/logo.png"></head><body>hi</body></html>');
    }
    if (req.url === "/logo.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(PNG1);
    }
    if (req.url === "/ico-only") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<html><head></head><body>no link tag</body></html>");
    }
    if (req.url === "/favicon.ico") {
      res.writeHead(200, { "Content-Type": "image/x-icon" });
      return res.end(ICO_DIB);
    }
    if (req.url === "/svg-only") {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      return res.end("<svg><script>alert(1)</script></svg>");
    }
    if (req.url === "/ssrf-redir") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  const srv = await startServer();
  t.after(async () => { await srv.stop(); await mock.close(); });
  const M = (p) => "http://127.0.0.1:" + mock.port + p;
  const admin = client(srv.base), user = client(srv.base);
  assert.equal((await admin.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  assert.equal((await admin.post("/api/users", { name: "bob", password: "bob-pass-1", admin: false })).status, 200);
  assert.equal((await user.post("/api/login", { name: "bob", password: "bob-pass-1" })).status, 200);

  // 1. HTML link PNG
  const r1 = await admin.post("/api/icons/fetch", { url: M("/page") });
  assert.equal(r1.status, 200);
  assert.match(r1.json.url, /^api\/icons\/[A-Za-z0-9_-]{16,64}$/);
  const got1 = await admin.get("/" + r1.json.url);
  assert.equal(got1.status, 200);
  assert.equal(got1.headers.get("content-type"), "image/png");
  assert.equal(got1.headers.get("content-security-policy"), "default-src 'none'");
  assert.ok(got1.body.equals(PNG1));

  // 2. Fallback /favicon.ico DIB -> PNG conversion
  const r2 = await admin.post("/api/icons/fetch", { url: M("/ico-only") });
  assert.equal(r2.status, 200);
  const got2 = await admin.get("/" + r2.json.url);
  assert.equal(got2.status, 200);
  assert.equal(got2.headers.get("content-type"), "image/png");

  // 3. SSRF direct metadata / self / redirect-to-metadata blocked
  assert.equal((await admin.post("/api/icons/fetch", { url: "http://169.254.169.254/latest/meta-data/" })).status, 403);
  assert.equal((await admin.post("/api/icons/fetch", { url: srv.base + "/" })).status, 403);
  assert.equal((await admin.post("/api/icons/fetch", { url: M("/ssrf-redir") })).status, 403);

  // 4. Non-admin without PROBE_ALLOW blocked
  assert.equal((await user.post("/api/icons/fetch", { url: M("/page") })).status, 403);

  // 5. Invalid URL scheme & SVG-only target rejected
  assert.equal((await admin.post("/api/icons/fetch", { url: "javascript:alert(1)" })).status, 400);
  const svgMock = await mockServer((req, res) => { res.writeHead(200, { "Content-Type": "image/svg+xml" }); res.end("<svg/>"); });
  t.after(() => svgMock.close());
  assert.equal((await admin.post("/api/icons/fetch", { url: "http://127.0.0.1:" + svgMock.port + "/x" })).status, 404);
});

test("noProbe skips server probes & POST /api/status/recheck immediately refreshes status with cooldown and user isolation", async (t) => {
  let flakyUp = false, mutedHits = 0, adminHits = 0;
  const mock = await mockServer((req, res) => {
    if (req.url === "/flaky") { adminHits++; res.writeHead(flakyUp ? 200 : 503); return res.end(); }
    if (req.url === "/muted") { mutedHits++; res.writeHead(503); return res.end(); }
    res.writeHead(200); res.end("ok");
  });
  const srv = await startServer({ env: { PROBE_TIMEOUT: "2", RECHECK_COOLDOWN_MS: "5000" } });
  t.after(async () => { await srv.stop(); await mock.close(); });
  const M = (p) => "http://127.0.0.1:" + mock.port + p;
  const admin = client(srv.base), bob = client(srv.base);
  assert.equal((await admin.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  assert.equal((await admin.post("/api/users", { name: "bob", password: "bob-pass-1", admin: false })).status, 200);
  assert.equal((await bob.post("/api/login", { name: "bob", password: "bob-pass-1" })).status, 200);

  await admin.put("/api/config", { baseVersion: 0, data: { settings: { title: "夜曲" }, groups: [{ id: "g1", name: "服务", style: "icon", items: [
    { id: "flaky", title: "Flaky", lan: M("/flaky"), icon: { type: "text", value: "F" } },
    { id: "muted", title: "Muted", lan: M("/muted"), noProbe: true, icon: { type: "text", value: "M" } },
  ] }] } });
  const st0 = await waitFor(async () => { const r = (await admin.get("/api/status")).json; return r.flaky && r.flaky.checkedAt ? r : null; }, 8000);
  assert.equal(st0.flaky.status, "down");
  assert.equal(st0.muted.status, "muted");
  assert.equal(mutedHits, 0, "noProbe item was never probed by server");

  // Non-admin without PROBE_ALLOW cannot trigger admin probes
  const hitsBeforeBob = adminHits;
  const bobRes = await bob.post("/api/status/recheck", {});
  assert.equal(bobRes.status, 200);
  assert.equal(bobRes.json.cached, true);
  assert.equal(adminHits, hitsBeforeBob, "non-admin recheck did not probe admin URLs");

  // Flip service online and trigger real NAS recheck
  flakyUp = true;
  const r1 = await admin.post("/api/status/recheck", {});
  assert.equal(r1.status, 200);
  assert.equal(r1.json.cached, false);
  assert.equal(r1.json.status.flaky.status, "up");
  assert.equal(r1.json.status.muted.status, "muted");
  assert.equal(mutedHits, 0);

  // Immediate second call respects cooldown
  const r2 = await admin.post("/api/status/recheck", {});
  assert.equal(r2.status, 200);
  assert.equal(r2.json.cached, true);
  assert.ok(r2.json.cooldownSec >= 1);
});

const opt = { skip: SKIP, timeout: 60000 };
const desktop = (q) => /hover:\s*hover|pointer:\s*fine|min-width/.test(q);

test("jsdom V2.4 UI: context menu, search Tab & prefix, pinyin palette, group collapse, favicon fetch, noProbe, capsule offline list", opt, async (t) => {
  let downNow = true;
  const mock = await mockServer((req, res) => {
    if (req.url === "/down") { res.writeHead(downNow ? 503 : 200); return res.end(); }
    if (req.url === "/ok") { res.writeHead(200); return res.end("ok"); }
    if (req.url === "/favpage") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end('<html><head><link rel="icon" href="/icon.png"></head></html>'); }
    if (req.url === "/icon.png") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(PNG1); }
    res.writeHead(404); res.end();
  });
  const srv = await startServer({ env: { PROBE_TIMEOUT: "2", RECHECK_COOLDOWN_MS: "0" } });
  t.after(async () => { await srv.stop(); await mock.close(); });
  const M = (p) => "http://127.0.0.1:" + mock.port + p;
  const c = client(srv.base);
  assert.equal((await c.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  const data = {
    settings: { title: "夜曲", engine: "google", engines: [
      { id: "google", name: "Google", url: "https://www.google.com/search?q=%s", on: true },
      { id: "baidu", name: "百度", url: "https://www.baidu.com/s?wd=%s", on: true },
      { id: "github", name: "GitHub", url: "https://github.com/search?q=%s", on: true },
    ] },
    groups: [
      { id: "g1", name: "影音", style: "icon", items: [
        { id: "bqh", title: "白群晖", desc: "主存储", lan: M("/ok"), wan: "https://nas.example.com", icon: { type: "text", value: "群" } },
        { id: "off1", title: "挂掉的服务", desc: "", lan: M("/down"), wan: "", icon: { type: "text", value: "挂" } },
        { id: "mut1", title: "静音项", desc: "", lan: M("/down"), wan: "", noProbe: true, icon: { type: "text", value: "静" } },
      ] },
      { id: "g2", name: "下载", style: "icon", items: [
        { id: "qb", title: "qBittorrent", desc: "", lan: M("/ok"), wan: "", icon: { type: "text", value: "Q" } },
      ] },
    ],
  };
  await c.put("/api/config", { baseVersion: 0, data });
  await waitFor(async () => { const r = (await c.get("/api/status")).json; return r.bqh && r.off1 && r.bqh.checkedAt ? r : null; }, 8000);

  const p = await openPage(srv.base, c, { media: desktop });
  t.after(async () => { await p.close(); assert.deepEqual(p.errors, []); });
  const { win, A } = p, doc = win.document;
  await p.idle(800);

  // 1. Muted item has .dot.muted and does not count as offline; offline pill shows 1 个连不上
  assert.equal(doc.querySelector('#x-groups [data-id="mut1"] > .dot').className, "dot muted");
  assert.equal(doc.querySelector(".x-net .x-nst").textContent, "1 个连不上");

  // 2. Header capsule menu lists the offline service + triggers real NAS recheck
  doc.querySelector(".x-net").click();
  await sleep(30);
  const netm = doc.querySelector(".x-netm");
  assert.ok(!netm.hidden);
  assert.match(netm.querySelector(".x-netm-off").textContent, /挂掉的服务/);
  downNow = false;
  netm.querySelector("[data-recheck]").click();
  await waitFor(() => doc.querySelector(".x-net .x-nst").textContent === "", 5000, 30);
  assert.ok(p.reqs.some((r) => r.method === "POST" && r.path === "/api/status/recheck"));

  // 3. Group collapsing: click header collapses locally, zero PUTs, edit mode expands, palette jump uncollapses
  const putsBeforeCol = p.puts().length;
  const g1 = doc.querySelector('.x-group[data-gid="g1"]');
  g1.querySelector(".x-gtitle").click();
  assert.ok(g1.classList.contains("is-collapsed"));
  assert.equal(g1.querySelector(".x-gtitle").getAttribute("aria-expanded"), "false");
  assert.deepEqual(JSON.parse(p.storage()["nocturne.collapsed"]), ["g1"]);
  await sleep(100);
  assert.equal(p.puts().length, putsBeforeCol, "collapsing a group never syncs");
  // Palette search via pinyin "yy" finds group "影音" and uncollapses it on select
  A.palette.open("yy"); await sleep(30);
  const gRow = [...doc.querySelectorAll(".x-cmdk-row")].find((r) => /影音/.test(r.textContent));
  assert.ok(gRow, "pinyin yy matches group 影音");
  gRow.click(); await sleep(30);
  assert.ok(!doc.querySelector('.x-group[data-gid="g1"]').classList.contains("is-collapsed"), "jumping to collapsed group expands it");

  // 4. Palette pinyin search for Chinese item "bqh" -> "白群晖"
  A.palette.open("bqh"); await sleep(30);
  assert.match(doc.querySelector(".x-cmdk-row").textContent, /白群晖/);
  A.palette.close();

  // 5. Search box Tab engine cycling + short prefix triggers
  const opened = []; win.open = (u) => { opened.push(u); return null; };
  const qEl = doc.getElementById("x-q");
  qEl.focus();
  qEl.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  assert.equal(A.state.settings.engine, "baidu", "Tab cycled Google -> Baidu");
  qEl.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(A.state.settings.engine, "google", "Shift+Tab cycled back to Google");
  qEl.value = "gh nocturne";
  doc.getElementById("x-search").dispatchEvent(new win.Event("submit", { cancelable: true }));
  assert.equal(opened[0], "https://github.com/search?q=nocturne");
  qEl.value = "b 群晖";
  doc.getElementById("x-search").dispatchEvent(new win.Event("submit", { cancelable: true }));
  assert.equal(opened[1], "https://www.baidu.com/s?wd=%E7%BE%A4%E6%99%96");

  // 6. Desktop card context menu: shows LAN/WAN + Copy + Edit; Copy works; Edit opens item sheet
  let copied = "";
  Object.defineProperty(win.navigator, "clipboard", { value: { writeText: (t) => { copied = t; return Promise.resolve(); } }, configurable: true });
  const tile = doc.querySelector('#x-groups [data-id="bqh"]');
  tile.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 160 }));
  await sleep(30);
  const ctx = doc.querySelector(".x-ctx");
  assert.ok(!ctx.hidden && ctx.querySelector('[data-ctx="lan"]') && ctx.querySelector('[data-ctx="wan"]') && ctx.querySelector('[data-ctx="copy"]') && ctx.querySelector('[data-ctx="edit"]'));
  ctx.querySelector('[data-ctx="copy"]').click();
  await sleep(30);
  assert.ok(copied === "https://nas.example.com" || copied === M("/ok"));
  // Shift+Right-Click leaves native browser menu alone
  const shiftEv = new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, shiftKey: true, clientX: 120, clientY: 160 });
  tile.dispatchEvent(shiftEv);
  assert.equal(shiftEv.defaultPrevented, false, "Shift+contextmenu preserves native menu");

  // Reopen context menu and click 编辑项目 -> opens editor directly, then test Favicon fetch + clipboard paste + noProbe toggle
  tile.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 160 }));
  await sleep(30);
  ctx.querySelector('[data-ctx="edit"]').click();
  await sleep(50);
  const sh = doc.querySelector(".x-is");
  assert.ok(!sh.hidden && sh.classList.contains("is-on"), "context menu Edit opened item editor directly");
  // Clipboard image paste inside editor is captured; plain text paste is not intercepted
  let pasteRead = false;
  const origFR = win.FileReader;
  win.FileReader = class { readAsDataURL() { pasteRead = true; } };
  const imgPaste = new win.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(imgPaste, "clipboardData", { value: { items: [{ type: "image/png", getAsFile: () => new win.Blob([PNG1], { type: "image/png" }) }], files: [], getData: () => "" } });
  doc.dispatchEvent(imgPaste);
  assert.equal(imgPaste.defaultPrevented, true, "image paste inside editor is captured");
  assert.equal(pasteRead, true, "image paste invokes icon upload pipeline");
  const txtPaste = new win.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(txtPaste, "clipboardData", { value: { items: [], files: [], getData: () => "https://example.org" } });
  doc.dispatchEvent(txtPaste);
  assert.equal(txtPaste.defaultPrevented, false, "plain text paste inside editor stays untouched");
  win.FileReader = origFR;
  // Set URL to mock favicon page and click 抓取网站图标
  const urlIn = sh.querySelector('input[name="url"]');
  urlIn.value = M("/favpage");
  urlIn.dispatchEvent(new win.Event("input", { bubbles: true }));
  sh.querySelector("[data-fav]").click();
  await waitFor(() => sh.querySelector('[data-m="image"]').getAttribute("aria-pressed") === "true", 5000, 30);
  assert.ok(p.reqs.some((r) => r.method === "POST" && r.path === "/api/icons/fetch"));
  // Toggle 不检测状态 and save
  const np = sh.querySelector('input[name="noProbe"]');
  np.checked = true;
  sh.querySelector('[data-a="save"]').click();
  await p.idle();
  const updated = A.state.groups[0].items.find((i) => i.id === "bqh");
  assert.equal(updated.noProbe, true);
  assert.equal(updated.icon.type, "image");
  assert.match(updated.icon.value, /^api\/icons\//);

  // 7. Custom search engine trigger kw in Settings -> 搜索
  A.emit("settings", {}); await sleep(30);
  doc.querySelector('.x-set [data-tab="搜索"]').click();
  doc.querySelector('[data-s="add"]').click();
  doc.querySelector('[data-f="name"]').value = "豆瓣";
  doc.querySelector('[data-f="url"]').value = "https://www.douban.com/search?q=%s";
  doc.querySelector('[data-f="url"]').dispatchEvent(new win.Event("input", { bubbles: true }));
  doc.querySelector('[data-f="kw"]').value = "db";
  doc.querySelector('[data-s="save"]').click();
  await sleep(30);
  qEl.value = "db 三体";
  doc.getElementById("x-search").dispatchEvent(new win.Event("submit", { cancelable: true }));
  assert.equal(opened[2], "https://www.douban.com/search?q=%E4%B8%89%E4%BD%93");
});
