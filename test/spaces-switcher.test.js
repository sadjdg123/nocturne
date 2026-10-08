"use strict";
/* V2.0 阶段 2 · 空间切换器（jsdom 真实运行 index.html + nocturne.js，对着真实 server.js）：
 * 没有自定义空间时不显示（V1.1 外观不变）；切换只改展示范围与该范围的状态统计，不改 state、不发请求、不升版本；
 * 键盘（roving tabindex、方向键 / Home / End、aria-current、Alt+数字）；本机选择按账户、记住的空间不存在回落「全部」；
 * 网络三态与服务状态与空间无关（切换不重新检测、不改网络模式）。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, client } = require("./helpers");
const { openPage, SKIP, sleep } = require("./browser");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const SPACES = [
  { id: "s-daily", name: "日常", groupIds: ["chips00daily"], itemIds: ["syn920plus"] },
  { id: "s-fun", name: "娱乐", groupIds: ["mzq1a0lq8x2", "dl92kfa0q1z"] },
  { id: "s-nas", name: "NAS", groupIds: ["st0rage9kq2"] },
];
const opt = { skip: SKIP, timeout: 60000 };
const plain = (v) => JSON.parse(JSON.stringify(v));

async function seeded(t, data, version = 7) {
  const srv = await startServer({ seed: (dir) => {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "admin.json"), JSON.stringify({ version, updatedAt: "Thu 2026-10-01 8:00 AM CST (UTC+08:00)", data }));
  } });
  t.after(() => srv.stop());
  const c = client(srv.base);
  assert.equal((await c.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  return { srv, c };
}
const groupsShown = (doc) => [...doc.querySelectorAll("#x-groups .x-group")].map((s) => s.getAttribute("data-gid"));
const itemsShown = (doc) => [...doc.querySelectorAll("#x-groups [data-id]")].map((s) => s.getAttribute("data-id"));
const key = (doc, k, extra = {}) => doc.activeElement.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, extra)));

test("no custom spaces → switcher hidden, homepage identical to V1.1 (all groups); 管理空间 still reachable from ⋯ menu", opt, async (t) => {
  const { srv, c } = await seeded(t, serverData());
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  const doc = p.win.document;
  assert.deepEqual(p.errors, []);
  assert.ok(!doc.body.classList.contains("has-spaces"), "switcher hidden (CSS: body:not(.has-spaces) .x-spaces {display:none})");
  assert.deepEqual(groupsShown(doc), FIX.groups.map((g) => g.id));
  assert.ok(!doc.querySelector(".x-gpart"));
  doc.querySelector('[data-m="spaces"]').click();
  await sleep(30);
  assert.ok(!doc.querySelector(".x-spm").hidden, "⋯ → 管理空间 opens the sheet");
  assert.equal(p.puts().length, 0);
});

test("switching: scope + status counts only; never mutates state, never PUTs, never bumps version; global order kept; reload restores; deleted → 全部", opt, async (t) => {
  const { srv, c } = await seeded(t, Object.assign(serverData(), { spaces: structuredClone(SPACES) }));
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  await p.idle(800);
  assert.ok(doc.body.classList.contains("has-spaces"));
  const btns = [...doc.querySelectorAll(".x-sp[data-space]")];
  assert.deepEqual(btns.map((b) => b.querySelector("span").textContent), ["全部", "日常", "娱乐", "NAS"], "全部 always first");
  assert.equal(btns[0].getAttribute("aria-current"), "true");
  assert.deepEqual(btns.map((b) => b.querySelector("small").textContent), ["10", "4", "5", "2"], "item counts per space");
  const before = JSON.stringify(A.state), v0 = (await c.get("/api/config")).json.version, n0 = p.puts().length;
  const ring = () => doc.querySelector(".x-side .x-cnt").textContent;
  // → 日常: whole chip group + one pinned item shown under its real group, global order
  btns[1].click();
  assert.deepEqual(groupsShown(doc), ["st0rage9kq2", "chips00daily"], "global group order, not groupIds order");
  assert.deepEqual(itemsShown(doc), ["syn920plus", "gh0000chip", "cf0000chip", "ai0000chip"]);
  assert.ok(doc.querySelector('.x-group[data-gid="st0rage9kq2"][data-part] .x-gpart'), "partial group labelled");
  assert.equal(doc.querySelector('.x-sp[aria-current="true"]').getAttribute("data-space"), "s-daily");
  assert.equal(doc.querySelector(".x-side .x-card h2").textContent, "系统状态 · 日常");
  assert.match(ring(), /\/ 1|个服务/, "status counts only icon items in scope (1)");
  // → NAS
  doc.querySelector('.x-sp[data-space="s-nas"]').click();
  assert.deepEqual(itemsShown(doc), ["syn920plus", "uk3001xyzq"]); assert.match(ring(), /\/ 2/);
  doc.querySelector('.x-sp[data-space="all"]').click();
  assert.match(ring(), /\/ 7/, "全部: every icon item");
  assert.equal(JSON.stringify(A.state), before, "state byte-identical after switching");
  await p.idle();
  assert.equal(p.puts().length, n0, "no PUT"); assert.equal((await c.get("/api/config")).json.version, v0, "no version");
  // selection is device-local per account; reload restores; a dead id falls back to 全部
  A.spaces.select("s-fun");
  assert.equal(p.storage()["nocturne.space:admin"], "s-fun");
  assert.ok(!p.storage()["yeqv.v1"].includes("s-fun\"") || JSON.parse(p.storage()["yeqv.v1"]).spaces, "selection not in the cached state");
  const p2 = await openPage(srv.base, c, { storage: p.storage() });
  t.after(() => p2.close());
  assert.equal(p2.win.document.querySelector('.x-sp[aria-current="true"]').getAttribute("data-space"), "s-fun");
  assert.deepEqual(groupsShown(p2.win.document), ["mzq1a0lq8x2", "dl92kfa0q1z"]);
  const p3 = await openPage(srv.base, c, { storage: Object.assign(p.storage(), { "nocturne.space:admin": "s-gone" }) });
  t.after(() => p3.close());
  assert.equal(p3.A.spaces.selected(), "all"); assert.deepEqual(groupsShown(p3.win.document), FIX.groups.map((g) => g.id));
  assert.deepEqual(p.errors.concat(p2.errors, p3.errors), []);
});

test("keyboard: roving tabindex, arrows / Home / End move focus, Enter activates, Alt+digit switches; aria-current follows", opt, async (t) => {
  const { srv, c } = await seeded(t, Object.assign(serverData(), { spaces: structuredClone(SPACES) }));
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  const tabbable = () => [...doc.querySelectorAll(".x-sp")].filter((b) => b.tabIndex === 0).map((b) => b.getAttribute("data-space"));
  assert.deepEqual(tabbable(), ["all"], "exactly one tab stop (the current space)");
  doc.querySelector('.x-sp[data-space="all"]').focus();
  key(doc, "ArrowRight"); assert.equal(doc.activeElement.getAttribute("data-space"), "s-daily"); assert.deepEqual(tabbable(), ["s-daily"]);
  key(doc, "End"); assert.equal(doc.activeElement.getAttribute("data-space"), "s-nas");
  key(doc, "ArrowRight"); assert.equal(doc.activeElement.getAttribute("data-space"), "all", "wraps");
  key(doc, "ArrowLeft"); assert.equal(doc.activeElement.getAttribute("data-space"), "s-nas");
  assert.equal(A.spaces.selected(), "all", "moving focus does not switch");
  doc.activeElement.click(); // Enter / Space on a <button> = click
  assert.equal(A.spaces.selected(), "s-nas");
  assert.equal(doc.activeElement.getAttribute("data-space"), "s-nas", "focus kept on the re-rendered button");
  assert.equal(doc.querySelector(".x-sp[aria-current]").getAttribute("data-space"), "s-nas");
  key(doc, "Home"); assert.equal(doc.activeElement.getAttribute("data-space"), "all");
  doc.body.focus();
  doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "3", code: "Digit3", altKey: true, bubbles: true, cancelable: true }));
  assert.equal(A.spaces.selected(), "s-fun", "Alt+3 → third entry (娱乐)");
  doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "1", code: "Digit1", altKey: true, bubbles: true, cancelable: true }));
  assert.equal(A.spaces.selected(), "all");
  doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "9", code: "Digit9", altKey: true, bubbles: true, cancelable: true }));
  assert.equal(A.spaces.selected(), "all", "no 9th space → nothing");
  // the switcher lives outside #x-groups: long-press edit mode (pointerdown on tiles) is not triggered from it
  doc.querySelector('.x-sp[data-space="s-nas"]').dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
  await sleep(650);
  assert.ok(!doc.body.classList.contains("editing"), "press-and-hold on the switcher never enters edit mode");
});

test("network 3-state and service status are independent of the space (no re-check, no mode change, stat values kept)", opt, async (t) => {
  const { srv, c } = await seeded(t, Object.assign(serverData(), { spaces: structuredClone(SPACES) }));
  const p = await openPage(srv.base, c, { storage: { "nocturne.space:admin": "s-nas" } });
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  await p.idle(1200);
  A.net.set("wan", true);
  await p.idle(800);
  const dots = () => [...doc.querySelectorAll("#x-groups .x-tile[data-id] > .dot")].map((d) => d.getAttribute("data-id") || d.parentNode.getAttribute("data-id") + ":" + d.className);
  const nasDots = dots();
  let statusGets = 0; const of = win.fetch; win.fetch = (u, o) => { if (/api\/status/.test(String(u))) statusGets++; return of(u, o); };
  const nm = doc.querySelector(".x-net span").textContent;
  for (const id of ["s-fun", "all", "s-daily", "s-nas"]) A.spaces.select(id);
  await sleep(300);
  assert.equal(A.net.mode(), "wan", "space switch never changes the network mode");
  assert.equal(doc.querySelector(".x-net span").textContent, nm);
  assert.equal(statusGets, 0, "no status refresh / re-check triggered by switching");
  assert.deepEqual(dots(), nasDots, "same dots for the same items when coming back (no reset to 检测中)");
  // and the inverse: changing the network mode keeps the space
  A.net.set("lan", true);
  assert.equal(A.spaces.selected(), "s-nas");
  assert.deepEqual(plain(p.errors), []);
});
