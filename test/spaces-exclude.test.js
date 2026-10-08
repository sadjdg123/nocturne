"use strict";
/* V2.0 阶段 3 · 自定义空间里的删除语义：
 *   - 模型：excludeItemIds（schema 2）—— 可见规则、hide / unhide / pin 互斥、prune、removal()、spacesWith()、check / normalize；
 *   - 服务端：schema 1 的客户端（阶段 2 前端）不认识 excludeItemIds，漏掉时服务器补回；畸形 excludeItemIds → 400 bad_spaces；
 *   - 前端（jsdom 真实页面 + 真实 server.js）：编辑模式的减号在自定义空间里绝不直接全局删除 ——
 *     「从当前空间移除」（单独加入 → 取消加入；随整组出现 → 记一条排除）为默认第一项；
 *     「从所有空间删除…」要再确认一次，说明里写明项目名和出现在几个空间；在「全部」里仍是原来的直接删除 + 撤销。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../public/spaces.js");
const { seedAccount, startServer, client } = require("./helpers");
const { openPage, SKIP, sleep, byText } = require("./browser");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const plain = (v) => JSON.parse(JSON.stringify(v));
const deq = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);
const [G_AV, G_DL, G_ST, G_CH] = FIX.groups.map((g) => g.id); // 影音 / 下载 / 存储与监控 / 常用
const withSpaces = () => Object.assign(serverData(), { spacesVersion: 1, spaces: [
  { id: "s-fun", name: "娱乐", groupIds: [G_AV, G_DL] },
  { id: "s-daily", name: "日常", groupIds: [G_CH, G_AV], itemIds: ["syn920plus"] },
] });
const ids = (v) => v.map((e) => [e.group.id, e.items.map((i) => i.id)]);

test("model: excludeItemIds hides one item of a whole group in one space only; pin / hide are mutually exclusive; prune keeps it meaningful", () => {
  const d = withSpaces();
  assert.equal(S.SCHEMA, 2);
  // removal(): what 「从当前空间移除」 would do
  deq(S.removal(d, "s-fun", "e7h2kq9b1m").action, "hide", "Emby is visible via the whole 影音 group → needs an exclusion");
  deq(S.removal(d, "s-daily", "syn920plus").action, "unpin", "白群晖 is pinned only → just unpin");
  deq(S.removal(d, "s-fun", "syn920plus").action, "none", "not visible there");
  deq(S.removal(d, "all", "e7h2kq9b1m").action, "none");
  deq(S.spacesWith(d, "e7h2kq9b1m").map((s) => s.id), ["s-fun", "s-daily"]);
  // hide via group → exclusion, other spaces untouched, item still exists
  const r = S.hide(d, "s-fun", "e7h2kq9b1m");
  assert.equal(r.action, "hide");
  deq(S.get(d, "s-fun").excludeItemIds, ["e7h2kq9b1m"]);
  assert.equal(d.spacesVersion, 2, "using a schema-2 field raises spacesVersion");
  assert.ok(!S.itemVisible(d, "s-fun", "e7h2kq9b1m") && S.itemVisible(d, "s-daily", "e7h2kq9b1m") && S.itemVisible(d, "all", "e7h2kq9b1m"));
  deq(ids(S.view(d, "s-fun"))[0], [G_AV, ["p1x0c4n8vz", "jf00000001"]]);
  assert.equal(S.view(d, "s-fun")[0].whole, true); assert.equal(S.view(d, "s-fun")[0].hidden, 1);
  deq(S.stats(d, "s-fun").items, 4);
  assert.ok(d.groups[0].items.some((i) => i.id === "e7h2kq9b1m"), "the item itself is never touched");
  deq(S.check(d), []);
  // pin (单独加入) cancels the exclusion; hide again cancels the pin
  S.pin(d, "s-fun", "e7h2kq9b1m", true);
  assert.equal(S.get(d, "s-fun").excludeItemIds, undefined, "empty exclusion list → field removed");
  assert.ok(S.get(d, "s-fun").itemIds.includes("e7h2kq9b1m"));
  S.hide(d, "s-fun", "e7h2kq9b1m");
  deq(S.get(d, "s-fun").itemIds, []); deq(S.get(d, "s-fun").excludeItemIds, ["e7h2kq9b1m"]);
  assert.equal(S.unhide(d, "s-fun", "e7h2kq9b1m"), true); assert.equal(S.unhide(d, "s-fun", "e7h2kq9b1m"), false);
  // unpin-only path
  const u = S.hide(d, "s-daily", "syn920plus");
  assert.equal(u.action, "unpin"); deq(S.get(d, "s-daily").itemIds, []); assert.equal(S.get(d, "s-daily").excludeItemIds, undefined);
  // prune: exclusion of a deleted item / of a group no longer whole in the space is dropped
  S.hide(d, "s-fun", "e7h2kq9b1m"); S.hide(d, "s-fun", "qb5t1z8w0e");
  S.setGroups(d, "s-fun", [G_AV]);
  deq(S.get(d, "s-fun").excludeItemIds, ["e7h2kq9b1m"], "下载 left the space → its exclusion is meaningless and pruned");
  d.groups[0].items = d.groups[0].items.filter((i) => i.id !== "e7h2kq9b1m"); S.prune(d);
  deq(S.get(d, "s-fun").excludeItemIds, []);
  // reorder inside a space with a hidden item keeps the hidden one (it follows its predecessor)
  const e = withSpaces(); S.hide(e, "s-fun", "p1x0c4n8vz");
  assert.equal(S.reorder(e, [{ gid: G_AV, ids: ["jf00000001", "e7h2kq9b1m"] }, { gid: G_DL, ids: ["mp7r2x0k1a", "qb5t1z8w0e"] }]), true);
  deq(e.groups[0].items.map((i) => i.id), ["jf00000001", "e7h2kq9b1m", "p1x0c4n8vz"], "hidden Plex kept, follows Emby");
});

test("model: check / normalize validate excludeItemIds like itemIds; knownKeys(1) lacks it (so the server restores it for schema-1 clients)", () => {
  const bad = (f) => { const d = withSpaces(); f(d.spaces[0]); return S.check(d); };
  assert.equal(bad((s) => { s.excludeItemIds = "x"; }).length, 1);
  assert.equal(bad((s) => { s.excludeItemIds = [1]; }).length, 1);
  assert.equal(bad((s) => { s.excludeItemIds = Array(501).fill("a"); }).length, 1);
  deq(bad((s) => { s.excludeItemIds = ["e7h2kq9b1m"]; }), []);
  const n = withSpaces(); n.spaces[0].excludeItemIds = ["e7h2kq9b1m", "gone", "e7h2kq9b1m", "syn920plus"];
  S.normalize(n); deq(n.spaces[0].excludeItemIds, ["e7h2kq9b1m"], "dangling / duplicate / not-in-a-whole-group refs cleaned");
  assert.equal(S.knownKeys(1).excludeItemIds, undefined); assert.equal(S.knownKeys(2).excludeItemIds, true);
});

async function boot(t, data, version = 7) {
  const srv = await startServer({ seed: (dir) => {
    seedAccount(dir);
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "admin.json"), JSON.stringify({ version, updatedAt: "Thu 2026-10-01 8:00 AM CST (UTC+08:00)", data }));
  } });
  t.after(() => srv.stop());
  const c = client(srv.base);
  assert.equal((await c.post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 200);
  return { srv, c };
}

test("server: a schema-1 client that drops excludeItemIds gets it restored; schema-2 client may remove it; malformed → 400 bad_spaces", async (t) => {
  const d = withSpaces(); d.spacesVersion = 2; d.spaces[0].excludeItemIds = ["e7h2kq9b1m"];
  const { c } = await boot(t, d);
  let g = (await c.get("/api/config")).json;
  deq(g.data.spaces[0].excludeItemIds, ["e7h2kq9b1m"], "stored verbatim");
  const old = structuredClone(g.data); delete old.spaces[0].excludeItemIds; old.spaces[0].name = "娱乐（旧客户端改名）";
  const r1 = await c.put("/api/config", { baseVersion: g.version, data: old, caps: ["spaces", "spaces:1"] });
  assert.equal(r1.status, 200); assert.equal(r1.json.spacesRestored, 1);
  g = (await c.get("/api/config")).json;
  deq(g.data.spaces[0].excludeItemIds, ["e7h2kq9b1m"], "restored for the stage-2 client that does not know the field");
  assert.equal(g.data.spaces[0].name, "娱乐（旧客户端改名）");
  const now = structuredClone(g.data); delete now.spaces[0].excludeItemIds;
  const r2 = await c.put("/api/config", { baseVersion: g.version, data: now, caps: ["spaces", "spaces:2"] });
  assert.equal(r2.status, 200); assert.equal(r2.json.spacesRestored, undefined);
  g = (await c.get("/api/config")).json; assert.equal(g.data.spaces[0].excludeItemIds, undefined, "this client knows the field: removal is intentional");
  const evil = structuredClone(g.data); evil.spaces[0].excludeItemIds = [{ x: 1 }];
  const r3 = await c.put("/api/config", { baseVersion: g.version, data: evil, caps: ["spaces", "spaces:2"] });
  assert.equal(r3.status, 400); assert.equal(r3.json.code, "bad_spaces");
});

test("UI: minus badge in a custom space never deletes globally; 从当前空间移除 (hide / unpin) is the default; 从所有空间删除 needs a confirm naming the item and its spaces; 全部 keeps direct delete + undo", { skip: SKIP, timeout: 90000 }, async (t) => {
  const { srv, c } = await boot(t, withSpaces());
  const p = await openPage(srv.base, c, { storage: { "nocturne.space:admin": "s-fun" } });
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  await p.idle(800);
  const M = A.spaces.model, sp = (id) => M.get(A.state, id), exists = (id) => A.state.groups.some((g) => g.items.some((i) => i.id === id));
  const sheet = () => doc.querySelector(".x-sheet");
  const badge = (id) => doc.querySelector('#x-groups [data-id="' + id + '"] .x-ebadge');
  A.emit("edit", {});
  assert.match(badge("e7h2kq9b1m").getAttribute("aria-label"), /^移除 Emby/, "the badge says 移除 in a custom space");
  // (1) whole-group item → sheet; first (focused) row = 从「娱乐」移除 with the whole-group explanation
  const puts0 = p.puts().length;
  badge("e7h2kq9b1m").click(); await sleep(30);
  assert.ok(exists("e7h2kq9b1m") && p.puts().length === puts0, "nothing deleted or saved by the badge itself");
  const rows = [...sheet().querySelectorAll(".x-row:not(.is-cancel)")];
  assert.match(rows[0].textContent, /从「娱乐」移除.*分组「影音」整组在这个空间里/);
  assert.equal(doc.activeElement, rows[0], "default action focused");
  assert.ok(rows[1].classList.contains("is-red") && /从所有空间删除/.test(rows[1].textContent));
  rows[0].click(); await sleep(30);
  deq(sp("s-fun").excludeItemIds, ["e7h2kq9b1m"]); assert.ok(exists("e7h2kq9b1m"));
  assert.ok(!doc.querySelector('#x-groups [data-id="e7h2kq9b1m"]'), "hidden from this space");
  assert.match(doc.getElementById("x-toast-msg").textContent, /已在「娱乐」隐藏「Emby」/);
  assert.match(doc.querySelector('#x-groups .x-group[data-gid="' + G_AV + '"] .x-gpart').textContent, /本空间隐藏 1 项/);
  await p.idle();
  deq((await c.get("/api/config")).json.data.spaces[0].excludeItemIds, ["e7h2kq9b1m"], "synced (one commit)");
  A.undo(); assert.equal(sp("s-fun").excludeItemIds, undefined); assert.ok(doc.querySelector('#x-groups [data-id="e7h2kq9b1m"]'), "undo brings it back");
  // (2) 从所有空间删除 → confirm step names the item and how many spaces; cancel keeps it
  badge("qb5t1z8w0e").click(); await sleep(20);
  byText(sheet(), ".x-row", "从所有空间删除").click(); await sleep(20);
  assert.match(sheet().querySelector("h3").textContent, /删除「qBittorrent」？/);
  assert.match(sheet().querySelector(".x-sdesc").textContent, /出现在 2 个空间里（全部、娱乐）/);
  assert.ok(exists("qb5t1z8w0e"), "still there at the confirm step");
  sheet().querySelector(".x-row.is-cancel").click(); await sleep(20);
  assert.ok(exists("qb5t1z8w0e"), "cancel keeps it");
  badge("qb5t1z8w0e").click(); await sleep(20);
  byText(sheet(), ".x-row", "从所有空间删除").click(); await sleep(20);
  byText(sheet(), ".x-row.is-red", "删除项目（2 个空间）").click(); await sleep(20);
  assert.ok(!exists("qb5t1z8w0e"), "deleted globally after the confirm");
  A.undo(); assert.ok(exists("qb5t1z8w0e"));
  // (3) pinned-only item in 日常 → 「从「日常」移除」 = unpin, no exclusion
  A.spaces.select("s-daily"); await sleep(20);
  badge("syn920plus").click(); await sleep(20);
  assert.match(sheet().querySelector(".x-row").textContent, /单独加进来的/);
  sheet().querySelector(".x-row").click(); await sleep(20);
  deq(sp("s-daily").itemIds, []); assert.equal(sp("s-daily").excludeItemIds, undefined); assert.ok(exists("syn920plus"));
  // Emby appears in 3 spaces (全部 + 娱乐 + 日常): the confirm says so
  badge("e7h2kq9b1m").click(); await sleep(20);
  byText(sheet(), ".x-row", "从所有空间删除").click(); await sleep(20);
  assert.match(sheet().querySelector(".x-sdesc").textContent, /出现在 3 个空间里（全部、娱乐、日常）/);
  doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(20);
  assert.ok(exists("e7h2kq9b1m"), "Esc closes the confirm without deleting");
  // (4) in 全部 the badge stays the efficient direct delete with undo
  A.spaces.select("all"); await sleep(20);
  assert.match(badge("p1x0c4n8vz").getAttribute("aria-label"), /^删除 Plex/);
  badge("p1x0c4n8vz").click(); await sleep(20);
  assert.ok(!exists("p1x0c4n8vz"), "direct delete in 全部");
  assert.equal(doc.getElementById("x-toast-act").textContent, "撤销");
  doc.getElementById("x-toast-act").click(); assert.ok(exists("p1x0c4n8vz"));
  await p.idle();
  assert.deepEqual(p.errors, []);
});
