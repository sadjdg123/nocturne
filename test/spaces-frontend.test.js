"use strict";
/* V2.0 场景空间 · 前端（jsdom 真实运行 public/index.html + nocturne.js，对着真实 server.js）：
 * 首次升级零改动、本机当前空间不产生版本、提交 / 撤销 / 删组清引用、移动 / 复制、换账户隔离、导入校验、冲突面板、恢复较早的版本 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { seedAccount, startServer, client, sleep } = require("./helpers");
const { openPage, importFile, SKIP } = require("./browser");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const opt = { skip: SKIP, timeout: 60000 };
/** jsdom 里的对象来自另一个 realm：按 JSON 比较 */
const plain = (v) => JSON.parse(JSON.stringify(v));
const deq = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);

async function seeded(t, data, version = 7) {
  const srv = await startServer({ seed: (dir) => {
    seedAccount(dir);
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "admin.json"), JSON.stringify({ version, updatedAt: "2026-10-01T00:00:00.000Z", data }));
  } });
  t.after(() => srv.stop());
  const c = client(srv.base);
  assert.equal((await c.post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 200);
  return { srv, c };
}
/** 这台设备上 V1.1 留下的本机缓存（与服务器同版本） */
function v11Device(ver = 7) { return { "yeqv.v1": JSON.stringify(FIX), "nocturne.owner": "admin", "nocturne.ver": String(ver) }; }

test("first upgrade: V1.1 device + V1.1 server config → nothing pushed, no version bump, groups byte-equal, only 全部", opt, async (t) => {
  const { srv, c } = await seeded(t, serverData());
  // (1) device has an up-to-date V1.1 cache
  const p = await openPage(srv.base, c, { storage: v11Device() });
  t.after(() => p.close());
  await p.idle(2000);
  deq(p.errors, []);
  assert.equal(p.puts().length, 0, "upgrade alone pushes nothing");
  assert.equal((await c.get("/api/config")).json.version, 7);
  assert.equal(JSON.stringify(p.A.state.groups), JSON.stringify(FIX.groups), "order / names / URLs / icons / group ids unchanged");
  assert.ok(!("spaces" in p.A.state));
  assert.equal(p.A.spaces.selected(), "all");
  deq(p.A.spaces.view("all").map((x) => x.group.id), FIX.groups.map((g) => g.id));
  assert.equal(p.A.state.settings.net, "lan", "device-local net kept"); deq(p.A.state.recent, FIX.recent);
  assert.equal(p.win.document.querySelectorAll("#x-groups .x-group").length, FIX.groups.length, "homepage still renders every group");
  // (2) a new device (empty storage) → pulls; still nothing pushed
  const c2 = client(srv.base); await c2.post("/api/login", { name: "admin", password: "admin-pass-1" });
  const q = await openPage(srv.base, c2, {});
  t.after(() => q.close());
  await q.idle(2000);
  assert.equal(q.puts().length, 0); assert.equal((await c.get("/api/config")).json.version, 7);
  assert.equal(JSON.stringify(q.A.state.groups), JSON.stringify(FIX.groups));
});

test("space edits sync through commit (caps, version+1); selecting a space is device-local (no PUT, no version)", opt, async (t) => {
  const { srv, c } = await seeded(t, serverData());
  const p = await openPage(srv.base, c, { storage: v11Device() });
  t.after(() => p.close());
  const S = p.A.spaces.model;
  let sid;
  p.A.commit((s) => { sid = S.add(s, { name: "NAS", groupIds: ["st0rage9kq2"], itemIds: ["e7h2kq9b1m"], theme: "frost" }); }, "space-add");
  await p.idle();
  const put = p.puts().at(-1);
  assert.equal(put.status, 200); deq(put.body.caps, ["spaces", "spaces:2"]); // 阶段 2：带上空间 schema 版本
  deq(put.body.data.spaces, [{ id: sid, name: "NAS", groupIds: ["st0rage9kq2"], itemIds: ["e7h2kq9b1m"], theme: "frost" }]);
  assert.ok(!("net" in put.body.data.settings) && !("recent" in put.body.data), "device-local fields still stripped");
  const v = (await c.get("/api/config")).json.version;
  assert.equal(v, 8);
  const n = p.puts().length;
  assert.equal(p.A.spaces.select(sid), sid);
  assert.equal(p.A.spaces.selected(), sid);
  await p.idle();
  assert.equal(p.puts().length, n, "switching spaces sends nothing");
  assert.equal((await c.get("/api/config")).json.version, v, "no server version");
  assert.equal(p.storage()["nocturne.space:admin"], sid);
  assert.ok(!p.storage()["yeqv.v1"].includes("nocturne.space"), "selection is not inside the synced/cached state");
  assert.equal(p.A.spaces.select("does-not-exist"), "all", "unknown id → 全部");
  // reload on the same device: selection restored; deleted space → 全部
  p.A.spaces.select(sid);
  const p2 = await openPage(srv.base, c, { storage: p.storage() });
  t.after(() => p2.close());
  assert.equal(p2.A.spaces.selected(), sid);
  p2.A.commit((s) => { S.remove(s, sid); }, "space-del");
  assert.equal(p2.A.spaces.selected(), "all");
  await p2.idle();
  const g = (await c.get("/api/config")).json;
  deq(g.data.spaces, [], "space relation removed");
  assert.equal(JSON.stringify(g.data.groups), JSON.stringify(serverData().groups), "deleting a space removed no group/item");
});

test("delete group / delete item prune refs in the same commit; undo restores them; move keeps pins; duplicate not pinned", opt, async (t) => {
  const sd = Object.assign(serverData(), { spaces: [{ id: "s-nas", name: "NAS", groupIds: ["st0rage9kq2", "dl92kfa0q1z"], itemIds: ["e7h2kq9b1m", "mp7r2x0k1a"] }] });
  const { srv, c } = await seeded(t, sd);
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  await p.idle(800);
  deq(p.A.state.spaces, sd.spaces, "pulled from server");
  // move pinned MoviePilot from 下载 to 常用 (same code path as the edit sheet / move action: same object, same id)
  p.A.commit((s) => { const from = s.groups.find((g) => g.id === "dl92kfa0q1z"), to = s.groups.find((g) => g.id === "chips00daily"); to.items.push(from.items.splice(0, 1)[0]); }, "move-item");
  const v = p.A.spaces.view("s-nas");
  assert.ok(v.find((x) => x.group.id === "chips00daily").items.some((i) => i.id === "mp7r2x0k1a"), "pin follows the item to its new group");
  // duplicate (same as dupItem: structuredClone + new uid)
  p.A.commit((s) => { const g = s.groups[0]; const cp = structuredClone(g.items[0]); cp.id = p.A.util.uid(); g.items.splice(1, 0, cp); }, "duplicate-item");
  deq(p.A.state.spaces[0].itemIds, ["e7h2kq9b1m", "mp7r2x0k1a"], "copy not auto-added");
  // delete the 下载 group (referenced) and the pinned Emby item
  p.A.commit((s) => { s.groups = s.groups.filter((g) => g.id !== "dl92kfa0q1z"); }, "delete-group");
  p.A.commit((s) => { s.groups[0].items = s.groups[0].items.filter((i) => i.id !== "e7h2kq9b1m"); }, "delete-item");
  deq(p.A.state.spaces[0], { id: "s-nas", name: "NAS", groupIds: ["st0rage9kq2"], itemIds: ["mp7r2x0k1a"] });
  await p.idle();
  const g1 = (await c.get("/api/config")).json;
  deq(g1.data.spaces[0].groupIds, ["st0rage9kq2"]); deq(g1.data.spaces[0].itemIds, ["mp7r2x0k1a"]);
  assert.ok(p.puts().every((x) => !x.res || !x.res.spacesPruned), "client already pruned; server had nothing to fix");
  // undo twice → group + item + their refs come back together
  p.A.undo(); p.A.undo();
  deq(p.A.state.spaces[0].groupIds, ["st0rage9kq2", "dl92kfa0q1z"]);
  deq(p.A.state.spaces[0].itemIds, ["e7h2kq9b1m", "mp7r2x0k1a"]);
  await p.idle();
  deq((await c.get("/api/config")).json.data.spaces[0].groupIds, ["st0rage9kq2", "dl92kfa0q1z"], "undo synced");
});

test("account switch on one device: never shows the previous account's spaces or selection", opt, async (t) => {
  const sd = Object.assign(serverData(), { spaces: [{ id: "s-secret", name: "管理员的空间", groupIds: ["st0rage9kq2"] }] });
  const { srv, c } = await seeded(t, sd);
  assert.equal((await c.post("/api/users", { name: "bob", password: "bob-pass-12" })).status, 200);
  const pa = await openPage(srv.base, c, {});
  t.after(() => pa.close());
  await pa.idle(800);
  pa.A.spaces.select("s-secret");
  const device = pa.storage();
  assert.ok(device["yeqv.v1"].includes("管理员的空间"));
  await pa.close();
  // same browser, bob signs in (admin's cache + selection are still in localStorage)
  const cb = client(srv.base); await cb.post("/api/login", { name: "bob", password: "bob-pass-12" });
  const pb = await openPage(srv.base, cb, { storage: device });
  t.after(() => pb.close());
  await pb.idle(1500);
  assert.equal(pb.A.spaces.selected(), "all");
  assert.ok(!JSON.stringify(pb.A.state).includes("管理员的空间"), "admin's spaces not in bob's state");
  assert.ok(!JSON.stringify(pb.A.state).includes("s-secret"));
  assert.ok(!(pb.storage()["yeqv.v1"] || "").includes("管理员的空间"), "admin's cached config dropped");
  assert.ok(pb.puts().every((x) => !JSON.stringify(x.body).includes("s-secret")), "nothing of admin's leaks into bob's pushes");
  assert.equal(pb.A.spaces.selKey(), "nocturne.space:bob");
  pb.A.spaces.select("s-secret");
  assert.equal(pb.A.spaces.selected(), "all", "admin's space id is meaningless for bob");
  assert.equal((await c.get("/api/config")).json.data.spaces[0].id, "s-secret", "admin's server copy untouched");
});

test("JSON import: malformed spaces rejected (state unchanged); duplicate names / dangling refs cleaned; export contains spaces", opt, async (t) => {
  const { srv, c } = await seeded(t, Object.assign(serverData(), { spaces: [{ id: "s1", name: "原空间", groupIds: ["mzq1a0lq8x2"] }] }));
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  await p.idle(800);
  const before = JSON.stringify(p.A.state);
  importFile(p, Object.assign(serverData(), { spaces: [{ id: "all", name: "x", groupIds: [] }] }));
  await sleep(300);
  const err = p.win.document.querySelector("[data-err]");
  assert.match(err.textContent, /空间定义不合法/);
  assert.equal(JSON.stringify(p.A.state), before, "nothing imported");
  importFile(p, Object.assign(serverData(), { spaces: [{ id: "a", name: "日常", groupIds: ["chips00daily", "nope"] }, { id: "b", name: "日常", groupIds: [], itemIds: ["gone"] }] }));
  await sleep(300);
  deq(p.A.state.spaces, [{ id: "a", name: "日常", groupIds: ["chips00daily"] }, { id: "b", name: "日常 2", groupIds: [], itemIds: [] }]);
  await p.idle();
  deq((await c.get("/api/config")).json.data.spaces.map((s) => s.name), ["日常", "日常 2"]);
  // export (设置 → 数据 → 导出配置) includes spaces
  p.win.document.querySelector('[data-d="export"]').click();
  await sleep(200);
  const blob = (p.win.__downloads || []).at(-1);
  const txt = await new Promise((r) => { const fr = new p.win.FileReader(); fr.onload = () => r(fr.result); fr.readAsText(blob); });
  deq(JSON.parse(txt).spaces.map((s) => s.id), ["a", "b"]);
});

test("409 conflict sheet with spaces: 「使用服务器版」 adopts the server's spaces; 「恢复较早的版本」 restores spaces", opt, async (t) => {
  const { srv, c } = await seeded(t, Object.assign(serverData(), { spaces: [{ id: "s1", name: "v7 的空间", groupIds: [] }] }));
  const pa = await openPage(srv.base, c, {});
  t.after(() => pa.close());
  await pa.idle(800);
  // another device changes the spaces
  const cur = (await c.get("/api/config")).json, d = structuredClone(cur.data); d.spaces[0].name = "另一台设备改的";
  assert.equal((await c.put("/api/config", { baseVersion: cur.version, data: d, caps: ["spaces"] })).status, 200);
  // this device edits (stale base) → 409 → conflict sheet
  pa.A.commit((s) => { s.spaces[0].name = "本机改的"; }, "space-rename");
  await pa.idle();
  assert.ok(pa.puts().some((x) => x.status === 409));
  const sheet = pa.win.document.querySelector(".nc-cfs");
  assert.ok(sheet, "conflict sheet shown");
  sheet.querySelector('[data-cf="server"]').click();
  await pa.idle(800);
  assert.equal(pa.A.state.spaces[0].name, "另一台设备改的");
  const bks = (await c.get("/api/config/backups")).json;
  const local = bks.find((x) => x.kind === "local");
  assert.ok(local && local.spaces === 1, "local version (with its spaces) stashed");
  assert.equal((await c.get("/api/config?backup=" + local.id)).json.data.spaces[0].name, "本机改的");
  // 设置 → 账户 → 恢复较早的版本 → pick the stashed local version
  const doc = pa.win.document;
  doc.querySelector('[data-tab="账户"]').click();
  doc.querySelector('[data-u="bk"]').click();
  await sleep(500);
  const row = doc.querySelector('[data-bk] [data-id="' + local.id + '"]');
  assert.ok(row, "backup row listed");
  const go = row.querySelector('[data-u="bk-go"]');
  go.click(); go.click(); // 「恢复」→「确认恢复？」
  await pa.idle(2000);
  const g = (await c.get("/api/config")).json;
  assert.equal(g.data.spaces[0].name, "本机改的", "restored through the real UI path");
  assert.ok((await c.get("/api/config/backups")).json.some((x) => x.kind === "restore" && x.spaces === 1));
});

test("「恢复较早的版本」 of a pre-V2 backup (no spaces field) keeps the current space definitions", opt, async (t) => {
  const { srv, c } = await seeded(t, serverData());
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  await p.idle(800);
  p.A.commit((s) => { p.A.spaces.model.add(s, { name: "NAS", groupIds: ["st0rage9kq2", "dl92kfa0q1z"] }); s.settings.title = "V2 标题"; }, "space-add");
  await p.idle();
  const pre = (await c.get("/api/config/backups")).json.find((x) => x.version === 7);
  assert.ok(pre && pre.spaces === null, "the V1.1 version (v7) is in the backup ring without a spaces field (null, not 0)");
  const doc = p.win.document;
  doc.querySelector('[data-tab="账户"]').click();
  doc.querySelector('[data-u="bk"]').click();
  await sleep(500);
  const go = doc.querySelector('[data-bk] [data-id="' + pre.id + '"] [data-u="bk-go"]'); go.click(); go.click();
  await p.idle(2000);
  const g = (await c.get("/api/config")).json;
  assert.equal(g.data.settings.title, "夜曲", "old version restored");
  deq(g.data.spaces.map((s) => [s.name, s.groupIds]), [["NAS", ["st0rage9kq2", "dl92kfa0q1z"]]], "space definitions kept (refs re-checked against restored groups)");
});
