"use strict";
/* 复查修正 B：「没有 spaces 字段」（只有「全部」，从没建过空间）和 spaces: []（用户明确删光了自定义空间）是两种不同的状态，
 * 在存储、旧版前端保存（无 caps）、备份环 / 备份列表 / 409、恢复较早的版本、前端载入（adopt / 本机缓存）里都要分开，不能把 [] 当成缺失。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, client } = require("./helpers");
const { openPage, SKIP } = require("./browser");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const CAPS = ["spaces"];
const plain = (v) => JSON.parse(JSON.stringify(v));
const deq = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);
async function boot(t) {
  const srv = await startServer({});
  t.after(() => srv.stop());
  const a = client(srv.base);
  assert.equal((await a.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  return { srv, a };
}
async function cur(c) { return (await c.get("/api/config")).json; }
const stored = (srv) => JSON.parse(fs.readFileSync(path.join(srv.dataDir, "config", "admin.json"), "utf8"));
/** 旧版前端（V1.1）式的推送：没有 caps，data 里也没有 spaces（例如 V2 之前的本机缓存） */
function legacyPut(a, g, mutate) {
  const d = structuredClone(g.data); delete d.spaces; if (mutate) mutate(d);
  return a.put("/api/config", { baseVersion: g.version, data: d });
}

test("new client saves spaces: [] → old client saves without the field → still [] (file + GET); absent stays absent", async (t) => {
  const { srv, a } = await boot(t);
  // V2 client creates a space, then deletes it → spaces: []
  await a.put("/api/config", { baseVersion: 0, data: Object.assign(serverData(), { spaces: [{ id: "s1", name: "日常", groupIds: [] }] }), caps: CAPS });
  let g = await cur(a);
  const empty = Object.assign(structuredClone(g.data), { spaces: [] });
  assert.equal((await a.put("/api/config", { baseVersion: g.version, data: empty, caps: CAPS })).status, 200);
  g = await cur(a);
  deq(g.data.spaces, []);
  // old client edits an item (its body has no spaces / no caps)
  const r = await legacyPut(a, g, (d) => { d.groups[0].items[0].title = "旧版改名"; });
  assert.equal(r.status, 200); assert.equal(r.json.spacesKept, true);
  g = await cur(a);
  assert.equal(g.data.groups[0].items[0].title, "旧版改名", "edit saved");
  assert.ok(Array.isArray(g.data.spaces) && g.data.spaces.length === 0, "[] preserved, not turned into 'absent'");
  deq(stored(srv).data.spaces, [], "on disk too");
  // same content again from the old client → no version bump
  const r2 = await legacyPut(a, g);
  assert.equal(r2.json.version, g.version); assert.equal((await cur(a)).version, g.version);
  // a fresh account that never had spaces: old client saves → field stays absent
  assert.equal((await a.post("/api/users", { name: "bob", password: "bob-pass-12" })).status, 200);
  const b = client(srv.base); await b.post("/api/login", { name: "bob", password: "bob-pass-12" });
  assert.equal((await b.put("/api/config", { baseVersion: 0, data: serverData() })).status, 200);
  let gb = await cur(b);
  const rb = await legacyPut(b, gb, (d) => { d.settings.title = "bob"; });
  assert.equal(rb.status, 200); assert.equal(rb.json.spacesKept, undefined);
  gb = await cur(b);
  assert.ok(!("spaces" in gb.data), "absent stays absent");
  // V2 client (caps) without spaces on an account that has none → still absent (no field invented)
  assert.equal((await b.put("/api/config", { baseVersion: gb.version, data: Object.assign(structuredClone(gb.data), { settings: { title: "bob2" } }), caps: CAPS })).status, 200);
  assert.ok(!("spaces" in (await cur(b)).data));
});

test("backups keep [] vs absent: ring files, list (0 vs null), 409 body, restore round trip (V2 restore and old-client restore)", async (t) => {
  const { srv, a } = await boot(t);
  // v1: no spaces field
  await a.put("/api/config", { baseVersion: 0, data: serverData(), caps: CAPS });
  // v2: spaces [] (forced snapshot via restore:true so v1 lands in the ring), v3: one space (v2 lands in the ring)
  let g = await cur(a);
  await a.put("/api/config", { baseVersion: g.version, data: Object.assign(structuredClone(g.data), { spaces: [] }), caps: CAPS, restore: true });
  g = await cur(a);
  await a.put("/api/config", { baseVersion: g.version, data: Object.assign(structuredClone(g.data), { spaces: [{ id: "s1", name: "NAS", groupIds: ["st0rage9kq2"] }] }), caps: CAPS, restore: true });
  g = await cur(a);
  assert.equal(g.version, 3);
  const list = (await a.get("/api/config/backups")).json;
  const bv1 = list.find((x) => x.version === 1), bv2 = list.find((x) => x.version === 2);
  assert.ok(bv1 && bv2, "both versions are in the ring");
  assert.equal(bv1.spaces, null, "absent → null (only 全部)");
  assert.equal(bv2.spaces, 0, "[] → 0 (deliberately emptied)");
  // ring files on disk keep the distinction
  const files = fs.readdirSync(path.join(srv.dataDir, "backup", "admin")).filter((f) => f.endsWith(".json"));
  const docs = files.map((f) => JSON.parse(fs.readFileSync(path.join(srv.dataDir, "backup", "admin", f), "utf8")));
  assert.ok(!("spaces" in docs.find((d) => d.version === 1).data));
  deq(docs.find((d) => d.version === 2).data.spaces, []);
  // GET ?backup= returns them verbatim
  const d1 = (await a.get("/api/config?backup=" + bv1.id)).json, d2 = (await a.get("/api/config?backup=" + bv2.id)).json;
  assert.ok(!("spaces" in d1.data)); deq(d2.data.spaces, []);
  // V2 restore of the [] backup → current becomes [] (not 'absent', not the previous spaces)
  assert.equal((await a.put("/api/config", { baseVersion: g.version, data: d2.data, caps: CAPS, restore: true })).status, 200);
  g = await cur(a); deq(g.data.spaces, []);
  // old client restores the absent backup (no caps) → stored [] is kept
  const r = await a.put("/api/config", { baseVersion: g.version, data: d1.data, restore: true });
  assert.equal(r.status, 200); assert.equal(r.json.spacesKept, true);
  g = await cur(a); deq(g.data.spaces, []);
  // 409 body distinguishes too
  const c409 = await a.put("/api/config", { baseVersion: 1, data: Object.assign(structuredClone(g.data), { settings: { title: "x" } }), caps: CAPS });
  assert.equal(c409.status, 409); assert.equal(c409.json.spaces, 0);
  // V2 client explicitly drops the field (caps) → absent; 409 then says null
  assert.equal((await a.put("/api/config", { baseVersion: g.version, data: (() => { const d = structuredClone(g.data); delete d.spaces; return d; })(), caps: CAPS })).status, 200);
  g = await cur(a); assert.ok(!("spaces" in g.data));
  const n409 = await a.put("/api/config", { baseVersion: 1, data: Object.assign(structuredClone(g.data), { settings: { title: "y" } }), caps: CAPS });
  assert.equal(n409.status, 409); assert.equal(n409.json.spaces, null);
});

test("frontend: [] is never treated as missing — adopt, local cache reload, push, and UI restore of a [] backup", { skip: SKIP, timeout: 60000 }, async (t) => {
  const srv = await startServer({ seed: (dir) => {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "admin.json"), JSON.stringify({ version: 5, updatedAt: "2026-10-01T00:00:00.000Z", data: Object.assign(serverData(), { spaces: [] }) }));
  } });
  t.after(() => srv.stop());
  const a = client(srv.base);
  assert.equal((await a.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  const p = await openPage(srv.base, a, {});
  t.after(() => p.close());
  await p.idle(1000);
  assert.ok(Array.isArray(p.A.state.spaces) && p.A.state.spaces.length === 0, "adopted [] as []");
  assert.equal(p.puts().length, 0, "loading [] pushes nothing (normalize sees no change)");
  assert.equal((await cur(a)).version, 5);
  // reload from the local cache only (server unreachable path is the same normalize): still []
  const dev = p.storage();
  assert.match(dev["yeqv.v1"], /"spaces":\[\]/);
  // an ordinary edit pushes spaces: [] with caps
  p.A.commit((s) => { s.settings.title = "改标题"; }, "title");
  await p.idle();
  const put = p.puts().at(-1);
  assert.equal(put.status, 200); deq(put.body.data.spaces, []); deq(put.body.caps, CAPS);
  deq((await cur(a)).data.spaces, []);
  // create a space (so the current state is non-empty), then restore the [] version through the real UI
  p.A.commit((s) => { p.A.spaces.model.add(s, { name: "NAS", groupIds: ["st0rage9kq2"] }); }, "space-add");
  await p.idle();
  assert.equal((await cur(a)).data.spaces.length, 1);
  const list = (await a.get("/api/config/backups")).json;
  const target = list.find((x) => x.spaces === 0);
  assert.ok(target, "a backup with spaces: [] exists");
  // same code path as bkRestore: a [] backup must replace current spaces with [] (only an ABSENT field keeps the current ones)
  const p2 = await openPage(srv.base, a, { storage: p.storage() });
  t.after(() => p2.close());
  await p2.idle(800);
  assert.equal(p2.A.state.spaces.length, 1);
  await restoreViaUi(p2, target.id);
  await p2.idle();
  assert.ok(Array.isArray(p2.A.state.spaces) && p2.A.state.spaces.length === 0, "restored [] — not treated as missing");
  deq((await cur(a)).data.spaces, [], "server now holds [] again");
  // reload the page from cache + server: still []
  const p3 = await openPage(srv.base, a, { storage: p2.storage() });
  t.after(() => p3.close());
  await p3.idle(800);
  assert.ok(Array.isArray(p3.A.state.spaces) && p3.A.state.spaces.length === 0);
  deq([...p.errors, ...p2.errors, ...p3.errors], []);
});

/** 设置 → 账户 →「恢复较早的版本」→ 某个备份的「恢复」→「确认恢复？」（真实 UI 路径，同 spaces-frontend.test.js） */
async function restoreViaUi(p, id) {
  const doc = p.win.document;
  doc.querySelector('[data-tab="账户"]').click();
  doc.querySelector('[data-u="bk"]').click();
  await new Promise((r) => setTimeout(r, 600));
  const go = doc.querySelector('[data-bk] [data-id="' + id + '"] [data-u="bk-go"]');
  assert.ok(go, "backup row listed");
  go.click(); go.click();
}
