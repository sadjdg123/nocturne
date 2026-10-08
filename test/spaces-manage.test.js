"use strict";
/* V2.0 阶段 2 · 管理空间 + 空间里的编辑（jsdom 真实运行 index.html + nocturne.js，对着真实 server.js）：
 * 新建（模板只填名称、不自动分组）/ 名称校验与服务器同规则 / 改名 / 排序 / 勾选分组 / 单独项目 / 删除（只删关系）/ 撤销；
 * 每次修改走 App.commit（一次 PUT、caps、版本 +1）；409 冲突面板在管理空间之上；空空间与「选择分组」；
 * 空间里添加 / 移动 / 复制 / 删除 / 新分组 / 拖动排序（全局顺序）之后的引用。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, client } = require("./helpers");
const { openPage, SKIP, sleep, byText } = require("./browser");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const opt = { skip: SKIP, timeout: 90000 };
const plain = (v) => JSON.parse(JSON.stringify(v));
const deq = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);

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
function typeIn(win, el, v) { el.value = v; el.dispatchEvent(new win.Event("input", { bubbles: true })); }
function submit(win, form) { form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); }
const err = (sh) => sh.querySelector('[data-err-for="__new"]');

test("create with templates (name only, no groups), validation mirrors the server, rename, reorder, groups, pins, delete-only-relation, undo — all via commit", opt, async (t) => {
  const { srv, c } = await seeded(t, serverData());
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  await p.idle(800);
  A.spaces.manage();
  const sh = doc.querySelector(".x-spm");
  assert.ok(!sh.hidden && sh.getAttribute("role") === "dialog" && sh.getAttribute("aria-modal") === "true");
  assert.match(sh.querySelector(".x-spm-row.is-all").textContent, /全部.*不可删除/);
  assert.ok(!sh.querySelector('.is-all [data-spm="del"]'), "全部 has no delete");
  const nameIn = () => sh.querySelector("[data-spm-new] input[name=name]");
  // template fills the NAME only
  byText(sh, "[data-tpl]", "NAS").click();
  assert.equal(nameIn().value, "NAS");
  submit(win, sh.querySelector("[data-spm-new]"));
  await p.idle();
  let put = p.puts().at(-1);
  assert.equal(put.status, 200); deq(put.body.caps, ["spaces", "spaces:1"]);
  assert.equal(put.body.data.spaces.length, 1);
  deq(put.body.data.spaces[0].groupIds, [], "template never assigns groups by name (存储与监控 not guessed)");
  assert.equal(put.body.data.spacesVersion, 1);
  const nas = put.body.data.spaces[0].id;
  assert.equal(A.spaces.selected(), nas, "new space selected (device-local) and expanded");
  assert.ok(sh.querySelector('[data-ed="' + nas + '"]'));
  assert.ok(doc.querySelector(".x-sempty"), "empty space state behind the sheet");
  // validation messages (same rules as server)
  typeIn(win, nameIn(), "nas"); assert.match(err(sh).textContent, /已经有叫「nas」/);
  typeIn(win, nameIn(), "全部"); assert.match(err(sh).textContent, /保留名称/);
  typeIn(win, nameIn(), "长".repeat(25)); assert.match(err(sh).textContent, /最多 24/);
  assert.match(sh.querySelector('[data-cnt-for="__new"]').textContent, /25\/24/);
  typeIn(win, nameIn(), "  "); submit(win, sh.querySelector("[data-spm-new]")); assert.match(err(sh).textContent, /不能为空/);
  const n0 = p.puts().length;
  typeIn(win, nameIn(), "nas"); submit(win, sh.querySelector("[data-spm-new]"));
  await p.idle(); assert.equal(p.puts().length, n0, "invalid name → nothing committed");
  // second + third space
  byText(sh, "[data-tpl]", "日常").click(); submit(win, sh.querySelector("[data-spm-new]")); await sleep(20);
  byText(sh, "[data-tpl]", "娱乐").click(); submit(win, sh.querySelector("[data-spm-new]")); await p.idle();
  let names = () => A.spaces.list().map((s) => s.name);
  deq(names(), ["NAS", "日常", "娱乐"]);
  // toggle groups on 娱乐 (expanded after create)
  const fun = A.spaces.list()[2].id;
  sh.querySelector('[data-ed="' + fun + '"] input[data-sp-group="mzq1a0lq8x2"]').click();
  sh.querySelector('[data-ed="' + fun + '"] input[data-sp-group="dl92kfa0q1z"]').click();
  await p.idle();
  deq((await c.get("/api/config")).json.data.spaces[2].groupIds, ["mzq1a0lq8x2", "dl92kfa0q1z"]);
  // pin a single item from another group
  sh.querySelector('[data-ed="' + fun + '"] input[data-sp-item="gh0000chip"]').click();
  assert.ok(sh.querySelector('[data-ed="' + fun + '"] input[data-sp-item="e7h2kq9b1m"]').disabled, "items of a whole group are covered by the group");
  await p.idle();
  deq(A.spaces.list()[2].itemIds, ["gh0000chip"]);
  deq([...doc.querySelectorAll("#x-groups .x-group")].map((s) => s.getAttribute("data-gid")), ["mzq1a0lq8x2", "dl92kfa0q1z", "chips00daily"]);
  // rename (inline form), duplicates rejected
  const ren = sh.querySelector('[data-sp-name="' + fun + '"]');
  typeIn(win, ren, "日常"); submit(win, ren.form);
  assert.match(sh.querySelector('[data-err-for="' + fun + '"]').textContent, /已经有/); assert.equal(A.spaces.list()[2].name, "娱乐");
  typeIn(win, sh.querySelector('[data-sp-name="' + fun + '"]'), "影视"); submit(win, sh.querySelector('[data-sp-name="' + fun + '"]').form);
  assert.equal(A.spaces.list()[2].name, "影视");
  // reorder with buttons
  sh.querySelector('[data-spm="up"][data-sid="' + fun + '"]').click();
  deq(names(), ["NAS", "影视", "日常"]);
  assert.ok(sh.querySelector('.x-spm-list li[data-sid] [data-spm="up"]').disabled, "first custom space cannot go up (全部 stays first)");
  await p.idle();
  deq((await c.get("/api/config")).json.data.spaces.map((s) => s.name), ["NAS", "影视", "日常"]);
  // delete with confirmation: relation only
  const groupsBefore = JSON.stringify((await c.get("/api/config")).json.data.groups);
  sh.querySelector('[data-spm="del"][data-sid="' + fun + '"]').click();
  assert.match(sh.querySelector(".x-spm-cf").textContent, /只删除这个空间，分组、项目、图标和壁纸都不会删/);
  sh.querySelector('[data-spm="del-yes"]').click();
  await p.idle();
  const after = (await c.get("/api/config")).json.data;
  deq(after.spaces.map((s) => s.name), ["NAS", "日常"]);
  assert.equal(JSON.stringify(after.groups), groupsBefore, "groups / items untouched");
  assert.equal(A.spaces.selected(), "all", "deleted current space → 全部");
  // undo brings it back (with groups, pin, position)
  A.undo(); await p.idle();
  deq(A.spaces.list().map((s) => [s.name, s.groupIds, s.itemIds || null]), [["NAS", [], null], ["影视", ["mzq1a0lq8x2", "dl92kfa0q1z"], ["gh0000chip"]], ["日常", [], null]]);
  // Esc closes and returns focus
  win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.ok(!sh.classList.contains("is-on"));
  assert.deepEqual(p.errors, []);
});

test("cap 24 spaces: create disabled with a message; 25th via API is a 400 bad_spaces", opt, async (t) => {
  const many = Array.from({ length: 24 }, (_, i) => ({ id: "s" + i, name: "空间" + i, groupIds: [] }));
  const { srv, c } = await seeded(t, Object.assign(serverData(), { spaces: many }));
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  p.A.spaces.manage();
  const sh = p.win.document.querySelector(".x-spm");
  assert.ok(sh.querySelector("[data-spm-new] input[name=name]").disabled);
  assert.match(err(sh).textContent, /最多 24 个空间/);
  const cur = (await c.get("/api/config")).json;
  const r = await c.put("/api/config", { baseVersion: cur.version, data: Object.assign(cur.data, { spaces: many.concat([{ id: "s99", name: "x", groupIds: [] }]) }), caps: ["spaces", "spaces:1"] });
  assert.equal(r.status, 400); assert.equal(r.json.code, "bad_spaces");
});

test("409 while the manage sheet is open: conflict sheet appears above it; 使用服务器版 works", opt, async (t) => {
  const { srv, c } = await seeded(t, Object.assign(serverData(), { spaces: [{ id: "s1", name: "日常", groupIds: [] }] }));
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  await p.idle(800);
  const cur = (await c.get("/api/config")).json, d = structuredClone(cur.data); d.spaces[0].name = "别的设备";
  assert.equal((await c.put("/api/config", { baseVersion: cur.version, data: d, caps: ["spaces", "spaces:1"] })).status, 200);
  A.spaces.manage("s1");
  doc.querySelector('.x-spm input[data-sp-group="chips00daily"]').click();
  await p.idle();
  assert.ok(p.puts().some((x) => x.status === 409));
  const cf = doc.querySelector(".nc-cfs");
  assert.ok(cf, "conflict sheet shown");
  win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.ok(doc.querySelector(".x-spm").classList.contains("is-on"), "Esc does not close the manage sheet under the conflict sheet");
  cf.querySelector('[data-cf="server"]').click();
  await p.idle(800);
  assert.equal(A.state.spaces[0].name, "别的设备");
  assert.equal(doc.querySelector('.x-spm [data-spm="open"][data-sid="s1"] span').textContent, "别的设备", "sheet re-rendered with the adopted state");
});

test("editing inside a space: add / move / duplicate / new group / delete / unlink / drag (global order) keep refs right; empty state when groups deleted", opt, async (t) => {
  const SP = [{ id: "s-fun", name: "娱乐", groupIds: ["mzq1a0lq8x2"], itemIds: ["qb5t1z8w0e"] }];
  const { srv, c } = await seeded(t, Object.assign(serverData(), { spaces: SP }));
  const p = await openPage(srv.base, c, { storage: { "nocturne.space:admin": "s-fun" } });
  t.after(() => p.close());
  const { win, A } = p, doc = win.document, M = A.spaces.model;
  await p.idle(800);
  const sp = () => plain(M.get(A.state, "s-fun"));
  const shown = () => [...doc.querySelectorAll("#x-groups [data-id]")].map((e) => e.getAttribute("data-id"));
  deq(shown(), ["e7h2kq9b1m", "p1x0c4n8vz", "jf00000001", "qb5t1z8w0e"]);
  A.emit("edit", {});
  // (1) add via the real add sheet into a group NOT in the space (存储与监控) → pinned so it stays visible
  doc.querySelector('#x-groups [data-add="mzq1a0lq8x2"]').click();
  await sleep(100);
  const is = doc.querySelector(".x-is");
  is.querySelector("input[name=url]").value = "https://kuma2.example.org"; is.querySelector("input[name=url]").dispatchEvent(new win.Event("input", { bubbles: true }));
  is.querySelector("input[name=nm]").value = "Kuma2"; is.querySelector("input[name=nm]").dispatchEvent(new win.Event("input", { bubbles: true }));
  is.querySelector('[data-g="st0rage9kq2"]').click();
  is.querySelector("[data-a=save]").click();
  await sleep(50);
  const st = A.state.groups.find((g) => g.id === "st0rage9kq2"), k2 = st.items.at(-1);
  assert.equal(k2.title, "Kuma2", "item lives in the chosen group (single source of truth)");
  assert.ok(sp().itemIds.includes(k2.id), "and is pinned into the current space");
  assert.ok(shown().includes(k2.id));
  assert.match(doc.getElementById("x-toast-msg").textContent, /不在本空间，已单独加入本空间/);
  // adding into a group that IS in the space → no pin
  A.commit((s) => { s.groups[0].items.push({ id: "newinfun1", title: "N", lan: "", wan: "https://n.example.org", icon: {} }); A.spaces.keepVisible(s, "newinfun1"); }, "add-item");
  assert.ok(!sp().itemIds.includes("newinfun1") && shown().includes("newinfun1"));
  // (2) move Emby to 下载 (not whole in space) → stays visible via pin
  const itemRow = (id) => { const a = doc.querySelector('#x-groups [data-id="' + id + '"]'); return { click: () => a.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true })) }; }; // <a>.click() is stubbed in browser.js
  itemRow("e7h2kq9b1m").click(); await sleep(20);
  byText(doc.querySelector(".x-sheet"), ".x-row", "移到分组").click(); await sleep(20);
  byText(doc.querySelector(".x-sheet"), ".x-row", "下载").click(); await sleep(20);
  assert.equal(A.state.groups.find((g) => g.id === "dl92kfa0q1z").items.at(-1).id, "e7h2kq9b1m");
  assert.ok(sp().itemIds.includes("e7h2kq9b1m") && shown().includes("e7h2kq9b1m"));
  // (3) duplicate a pinned-only item → the copy is pinned too
  itemRow("qb5t1z8w0e").click(); await sleep(20);
  byText(doc.querySelector(".x-sheet"), ".x-row", "复制").click(); await sleep(20);
  const dl = A.state.groups.find((g) => g.id === "dl92kfa0q1z"), copy = dl.items[dl.items.findIndex((i) => i.id === "qb5t1z8w0e") + 1];
  assert.notEqual(copy.id, "qb5t1z8w0e"); assert.ok(sp().itemIds.includes(copy.id) && shown().includes(copy.id));
  // (4) new group in edit mode → whole group joins the space
  doc.querySelector('.x-ebar [data-e="addg"]').click(); await sleep(80);
  const f = doc.querySelector(".x-sheet form"); f.querySelector("input").value = "新组"; f.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  const ng = A.state.groups.at(-1);
  assert.equal(ng.name, "新组"); assert.ok(sp().groupIds.includes(ng.id));
  // (5) unlink (从本空间移除) a pinned item: relation only
  itemRow("qb5t1z8w0e").click(); await sleep(20);
  byText(doc.querySelector(".x-sheet"), ".x-row", "从「娱乐」移除").click(); await sleep(20);
  assert.ok(!sp().itemIds.includes("qb5t1z8w0e")); assert.ok(A.state.groups.some((g) => g.items.some((i) => i.id === "qb5t1z8w0e")), "item still exists");
  A.undo(); assert.ok(sp().itemIds.includes("qb5t1z8w0e"));
  // (6) drag inside the space = global order: DOM order of the visible subset → spaces.reorder (as Sortable's onEnd does)
  const order = [...doc.querySelectorAll("#x-groups .x-group[data-gid]")].map((sec) => ({ gid: sec.getAttribute("data-gid"), ids: [...sec.querySelectorAll(".x-grid [data-id], .x-chips [data-id]")].map((e) => e.getAttribute("data-id")) }));
  const dlOrder = order.find((o) => o.gid === "dl92kfa0q1z"); dlOrder.ids.reverse();
  const hidden = A.state.groups.find((g) => g.id === "dl92kfa0q1z").items.map((i) => i.id).filter((id) => !dlOrder.ids.includes(id));
  A.commit((s) => { M.reorder(s, order); }, "reorder");
  const dlNow = A.state.groups.find((g) => g.id === "dl92kfa0q1z").items.map((i) => i.id);
  deq(dlNow.filter((id) => dlOrder.ids.includes(id)), dlOrder.ids, "visible items in the new order");
  deq(dlNow.filter((id) => hidden.includes(id)), hidden, "hidden items (MoviePilot) kept, in their relative order");
  // (7) delete an item globally → refs pruned in the same commit, undo restores both
  const del = doc.querySelector('#x-groups [data-id="e7h2kq9b1m"] .x-ebadge'); del.click();
  assert.ok(!sp().itemIds.includes("e7h2kq9b1m")); A.undo(); assert.ok(sp().itemIds.includes("e7h2kq9b1m"));
  // (8) delete every referenced group → empty-state + 选择分组 opens the sheet on this space
  A.commit((s) => { s.groups = s.groups.filter((g) => !sp().groupIds.includes(g.id) && !g.items.some((i) => sp().itemIds.includes(i.id))); }, "delete-group");
  deq(sp().groupIds, []); deq(sp().itemIds, []);
  A.emit("edit", {}); doc.querySelector('.x-ebar [data-e="done"]').click();
  const cta = doc.querySelector(".x-sempty .x-sempty-cta");
  assert.ok(cta, "empty state shown"); assert.match(doc.querySelector(".x-sempty").textContent, /只引用已有的分组和项目/);
  cta.click(); await sleep(20);
  assert.ok(doc.querySelector('.x-spm.is-on [data-ed="s-fun"]'), "sheet opened on this space");
  await p.idle();
  const saved = (await c.get("/api/config")).json.data;
  deq(saved.spaces[0].groupIds, []); assert.equal(M.check(saved).length, 0);
  assert.deepEqual(p.errors, []);
});
