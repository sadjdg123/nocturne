"use strict";
/* V2.0 阶段 3 · 手机底栏（Dock）修复的回归测试：
 *   - 结构：快速打开 ｜ 空间滚动区（独立 flex 子项，自己裁切，渐隐只在有被藏住的一侧）｜ 更多；左右按钮 ≥44px；
 *   - 当前空间自动滚进可见区：只改 track.scrollLeft，不用 scrollIntoView、不动页面滚动；已完整可见时不动；
 *   - 长名称：省略号（CSS）+ 完整名称在 title 与 aria-label；
 *   - 背景隔离：较不透明的材质 + 视口底部局部暗化层（aria-hidden、不接收点按、软键盘弹出时收起）；编辑模式下底栏被编辑栏替换；
 *   - 经典外观与桌面不受影响。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { seedAccount, startServer, client } = require("./helpers");
const { openPage, SKIP, sleep } = require("./browser");

const ROOT = path.join(__dirname, "..");
const CSS = fs.readFileSync(path.join(ROOT, "public", "midnight.css"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
const LONG = "一个特别特别长的空间名称用来测试省略号显示";
function data(many) {
  const d = structuredClone(FIX); delete d.settings.net; delete d.recent;
  const gids = d.groups.map((g) => g.id);
  d.spacesVersion = 2;
  d.spaces = many
    ? ["影音娱乐中心", "家庭相册与备份", "工作", "学习资料", "下载管理器", "智能家居全屋控制面板", "监控", "网络", LONG, "开发", "游戏"].map((n, i) => ({ id: "s-m" + i, name: n, groupIds: [gids[i % gids.length]] }))
    : [{ id: "s-daily", name: "日常", groupIds: [gids[0]] }, { id: "s-fun", name: "娱乐", groupIds: [gids[1]] }, { id: "s-nas", name: "NAS", groupIds: [gids[2]] }];
  return d;
}
async function boot(t, d) {
  const srv = await startServer({ seed: (dir) => {
    seedAccount(dir);
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "admin.json"), JSON.stringify({ version: 3, updatedAt: "Thu 2026-10-01 8:00 AM CST (UTC+08:00)", data: d }));
  } });
  t.after(() => srv.stop());
  const c = client(srv.base);
  assert.equal((await c.post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 200);
  return { srv, c };
}
const phone = (q) => /max-width:\s*767px/.test(q);
const opt = { skip: SKIP, timeout: 90000 };
/** 只取手机（<768）那一段新版样式 */
function mobileCss() { const i = CSS.indexOf("4c · 手机"); const j = CSS.indexOf("====", i + 20); return CSS.slice(i, j > 0 ? j : undefined); }
/** 给 jsdom 元素一个假的横向几何（jsdom 不排版） */
function fakeTrack(win, track, { vw, sw, chips }) {
  let sl = 0; const calls = [];
  Object.defineProperty(track, "clientWidth", { configurable: true, get: () => vw });
  Object.defineProperty(track, "scrollWidth", { configurable: true, get: () => sw });
  Object.defineProperty(track, "scrollLeft", { configurable: true, get: () => sl, set: (v) => { sl = v; } });
  track.getBoundingClientRect = () => ({ left: 100, right: 100 + vw, top: 0, bottom: 48, width: vw, height: 48 });
  track.scrollTo = (o) => { calls.push(o); sl = o.left; };
  [...track.querySelectorAll(".x-sp")].forEach((b, i) => { const [x, w] = chips[i]; b.getBoundingClientRect = () => ({ left: 100 + x - sl, right: 100 + x - sl + w, width: w, top: 2, bottom: 46, height: 44 }); });
  return { calls, set: (v) => { sl = v; }, get: () => sl };
}

test("dock CSS: the space region is its own clipped flex child between two ≥44px buttons; fades only on the hidden side", () => {
  const m = mobileCss();
  assert.match(m, /\.x-dock > \.x-spaces \{ position: relative; inset: auto;[^}]*min-width: 0;[^}]*overflow: hidden; overflow: clip;/, "region: relative (classic left/bottom neutralised), min-width:0, clips instead of scrolling");
  assert.match(m, /\.x-sp-track \{[^}]*overflow-x: auto;[^}]*scroll-padding-inline: 14px;[^}]*--fl: 0px; --fr: 0px;/, "track scrolls; no fade by default");
  assert.match(m, /\.x-sp-track\.is-ovl \{ --fl: 22px; \}/);
  assert.match(m, /\.x-sp-track\.is-ovr \{ --fr: 22px; \}/);
  assert.doesNotMatch(m, /mask-image: linear-gradient\(90deg, transparent 0, #000 10px/, "old always-on fade removed");
  assert.match(m, /body\.mn-merged \.x-dock > \.x-dk-pal, html\[data-ui="v2"\] body\.mn-merged \.x-dock > \.x-dk-more \{[^}]*width: 44px; min-width: 44px;/, "side buttons keep a 44px hit area");
  assert.match(m, /\.x-dock > \.x-spaces \.x-sp \{[^}]*min-width: 44px;[^}]*height: 44px;/, "chips ≥ 44×44");
  assert.match(m, /\.x-sp > span \{[^}]*max-width: 7\.5em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/, "long names ellipsize");
  assert.match(m, /\.x-sp:not\(\[aria-current="true"\]\) > small \{ display: none; \}/, "count only on the current space");
});

test("dock CSS: background isolation (opaque gradient + hairline + inner highlight + local scrim), edit bar replaces the dock", () => {
  const m = mobileCss();
  const dock = /html\[data-ui="v2"\] \.x-dock \{ display: flex;[^}]*\}/.exec(m)[0];
  const alphas = [...dock.matchAll(/linear-gradient\(180deg, rgba\(\d+, \d+, \d+, (\.\d+)\) 0%, rgba\(\d+, \d+, \d+, (\.\d+)\) 100%\)/g)].flatMap((x) => [+x[1], +x[2]]);
  assert.ok(alphas.length === 2 && Math.min(...alphas) >= 0.9, "dock base ≥ 90% opaque even if blur is unavailable: " + alphas);
  assert.match(dock, /border: 1px solid rgba\(236, 230, 218, \.13\)/);
  assert.match(dock, /inset 0 1px 0 rgba\(236, 230, 218, \.09\)/);
  assert.match(m, /\.mn-dockscrim \{ display: block; position: fixed; z-index: 19;[^}]*pointer-events: none;/, "scrim below the dock (z 20), never takes taps");
  assert.match(m, /\.mn-kb \.mn-dockscrim \{ opacity: 0; \}/, "scrim hides with the soft keyboard");
  assert.match(m, /body\.editing \.x-dock \{ display: none; \}/, "edit bar replaces the dock instead of stacking on it");
  assert.match(CSS, /^\.mn-sky, \.mn-sp, \.mn-ind, \.mn-setui, \.mn-dockscrim \{ display: none; \}/m, "scrim hidden outside 新版 mobile (classic / desktop)");
  assert.doesNotMatch(HTML.slice(HTML.indexOf("track.innerHTML = allSpaces()"), HTML.indexOf("SPC.reveal = reveal")), /\.scrollIntoView\(/, "switcher no longer uses scrollIntoView (page jump)");
});

test("revealLeft: nearest when fully visible, centre otherwise, start-align when wider than the viewport, clamped", opt, async (t) => {
  const { srv, c } = await boot(t, data());
  const p = await openPage(srv.base, c, { media: phone });
  t.after(() => p.close());
  const f = p.A.spaces.revealLeft;
  assert.equal(typeof f, "function");
  assert.equal(f(0, 200, 400, 20, 50, 12), 0, "already visible → unchanged");
  assert.equal(f(0, 200, 600, 300, 50, 12), 225, "hidden right → centred");
  assert.equal(f(0, 200, 400, 300, 50, 12), 200, "centred but clamped at max");
  assert.equal(f(300, 200, 400, 10, 50, 12), 0, "hidden left → centred, clamped at 0");
  assert.equal(f(0, 200, 400, 380, 20, 12), 200, "clamped at max");
  assert.equal(f(0, 200, 400, 150, 250, 12), 138, "wider than the viewport → start-aligned with padding");
  assert.equal(f(0, 200, 400, 180, 40, 12), 100, "partly hidden (inside the padding) → centred");
});

test("phone: switcher moves into the dock between 快速打开 and 更多; chips carry the full name in title + aria-label; scrim exists", opt, async (t) => {
  const { srv, c } = await boot(t, data(true));
  const p = await openPage(srv.base, c, { media: phone, storage: { "nocturne.space:admin": "s-m8" } });
  t.after(() => p.close());
  const doc = p.win.document;
  await p.idle(400);
  assert.ok(doc.body.classList.contains("mn-merged"));
  const kids = [...doc.querySelector(".x-dock").children].map((e) => e.className.split(" ")[0] || e.getAttribute("data-act"));
  assert.deepEqual(kids.filter((k) => /x-dk-pal|x-spaces|x-dk-more/.test(k)), ["x-dk-pal", "x-spaces", "x-dk-more"], "three separate flex children in order");
  const chips = [...doc.querySelectorAll(".x-dock .x-sp")];
  assert.equal(chips.length, 12, "全部 + 11 spaces");
  const long = doc.querySelector('.x-dock .x-sp[data-space="s-m8"]');
  assert.equal(long.getAttribute("aria-current"), "true");
  assert.equal(long.title, LONG);
  assert.match(long.getAttribute("aria-label"), new RegExp("^" + LONG + "，\\d+ 个项目$"));
  chips.forEach((b) => assert.ok(b.title && b.getAttribute("aria-label").startsWith(b.title + "，"), "title + aria-label on " + b.title));
  const scrim = doc.querySelector(".mn-dockscrim");
  assert.ok(scrim && scrim.getAttribute("aria-hidden") === "true" && scrim.nextElementSibling === doc.querySelector(".x-dock"), "scrim sits right before the dock");
  assert.deepEqual(p.errors, []);
});

test("phone: the current space is scrolled into view on load / switch / resize via scrollLeft only — no page scroll, no scrollIntoView; fade classes follow", opt, async (t) => {
  const { srv, c } = await boot(t, data(true));
  const p = await openPage(srv.base, c, { media: phone });
  t.after(() => p.close());
  const { win } = p, doc = win.document;
  await p.idle(400);
  let pageScrolls = 0, siv = 0;
  win.scrollTo = () => { pageScrolls++; }; win.HTMLElement.prototype.scrollIntoView = function () { siv++; };
  const track = doc.querySelector(".x-dock .x-sp-track");
  const geo = () => [...track.querySelectorAll(".x-sp")].map((_, i) => [i * 60, 56]); // 12 × 60px + trailing padding = 760px of chips in a 200px viewport
  let g = fakeTrack(win, track, { vw: 200, sw: 760, chips: geo() });
  p.A.spaces.reveal(false);
  assert.equal(g.calls.length, 0, "全部 at 0 is already visible → no scroll");
  // switch to the 11th space (x = 600): drawNav re-renders the chips, reveal runs on the next frame
  p.A.spaces.select("s-m9"); g = fakeTrack(win, track, { vw: 200, sw: 760, chips: geo() }); await sleep(80);
  assert.ok(g.calls.length >= 1, "scrolled after switching");
  const last = g.calls[g.calls.length - 1];
  assert.equal(last.left, Math.round(600 - (200 - 56) / 2), "active chip centred");
  assert.equal(pageScrolls, 0, "page did not scroll");
  assert.equal(siv, 0, "scrollIntoView not used");
  // fade classes: both sides hidden now
  track.dispatchEvent(new win.Event("scroll"));
  assert.ok(track.classList.contains("is-ovl") && track.classList.contains("is-ovr"), "fades on both hidden sides");
  g.set(560); track.dispatchEvent(new win.Event("scroll"));
  assert.ok(track.classList.contains("is-ovl") && !track.classList.contains("is-ovr"), "at the end: only the left fade");
  g.set(0); track.dispatchEvent(new win.Event("scroll"));
  assert.ok(!track.classList.contains("is-ovl") && track.classList.contains("is-ovr"), "at the start: only the right fade");
  // the user scrolled it away; a resize brings the current space back
  g.set(0); g.calls.length = 0;
  win.dispatchEvent(new win.Event("resize")); await sleep(30);
  assert.ok(g.calls.length >= 1 && g.calls[g.calls.length - 1].left === 528, "resize → current space back in view");
  // no overflow → no fade, no scrolling
  g = fakeTrack(win, track, { vw: 800, sw: 800, chips: geo() }); track.dispatchEvent(new win.Event("scroll"));
  p.A.spaces.reveal(false);
  assert.ok(!track.classList.contains("is-ovl") && !track.classList.contains("is-ovr") && g.calls.length === 0);
  assert.deepEqual(p.errors, []);
});

test("classic appearance and desktop keep the switcher out of the dock (no regression)", opt, async (t) => {
  const { srv, c } = await boot(t, data());
  const p = await openPage(srv.base, c, { media: phone, storage: { "nocturne.ui": "classic" } });
  t.after(() => p.close());
  const doc = p.win.document;
  await p.idle(300);
  assert.equal(doc.documentElement.getAttribute("data-ui"), "classic");
  assert.ok(!doc.body.classList.contains("mn-merged"));
  assert.ok(!doc.querySelector(".x-dock .x-spaces"), "classic: switcher stays in its own bar");
  const d = await openPage(srv.base, c, {});
  t.after(() => d.close());
  await d.idle(300);
  assert.ok(!d.win.document.querySelector(".x-dock .x-spaces"), "desktop: switcher not in the dock");
  assert.deepEqual(p.errors, []); assert.deepEqual(d.errors, []);
});
