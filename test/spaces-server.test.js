"use strict";
/* V2.0 场景空间 · 服务端：校验（400 bad_spaces）、悬空引用规则、旧版前端保护（无 caps）、409 / 强制覆盖 / opId / 备份恢复、
 * URL 白名单与 aliases 限制不受影响、账户隔离、/api/status 的真实延迟字段 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, client, mockServer, waitFor } = require("./helpers");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
/** 服务器上存的样子：去掉设备本地的 settings.net / recent（前端 snapshot() 就是这样推的） */
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const CAPS = ["spaces"];
const SPACES = [
  { id: "s-daily", name: "日常", groupIds: ["chips00daily", "dl92kfa0q1z"], theme: "dawn" },
  { id: "s-nas", name: "NAS", groupIds: ["st0rage9kq2", "dl92kfa0q1z"], itemIds: ["e7h2kq9b1m"], theme: "frost", density: "compact" },
];
async function boot(t, env) {
  const srv = await startServer({ env });
  t.after(() => srv.stop());
  const a = client(srv.base);
  assert.equal((await a.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  return { srv, a };
}
async function cur(c) { return (await c.get("/api/config")).json; }

test("malformed spaces → 400 bad_spaces (PUT and stash), nothing written", async (t) => {
  const { a } = await boot(t);
  const v0 = (await a.put("/api/config", { baseVersion: 0, data: serverData(), caps: CAPS })).json.version;
  const cases = [
    { spaces: "x" }, { spaces: [null] }, { spaces: [{ id: "a b", name: "x", groupIds: [] }] }, { spaces: [{ id: "all", name: "x", groupIds: [] }] },
    { spaces: [{ id: "s1", name: "x".repeat(25), groupIds: [] }] }, { spaces: [{ id: "s1", name: "", groupIds: [] }] },
    { spaces: [{ id: "s1", name: "A", groupIds: [] }, { id: "s2", name: "a", groupIds: [] }] },
    { spaces: [{ id: "s1", name: "A", groupIds: [] }, { id: "s1", name: "B", groupIds: [] }] },
    { spaces: [{ id: "s1", name: "A", groupIds: [{ $ne: 1 }] }] }, { spaces: [{ id: "s1", name: "A", groupIds: "g" }] },
    { spaces: [{ id: "s1", name: "A", groupIds: [], itemIds: Array.from({ length: 501 }, (_, i) => "i" + i) }] },
    { spaces: [{ id: "s1", name: "A", groupIds: [], theme: "javascript:alert(1)" }] }, { spaces: [{ id: "s1", name: "A", groupIds: [], density: "huge" }] },
    { spaces: [{ id: "s1", name: "A", groupIds: [], items: [{ title: "copy", wan: "https://x" }] }] },
    { spaces: Array.from({ length: 25 }, (_, i) => ({ id: "s" + i, name: "n" + i, groupIds: [] })) },
  ];
  for (const extra of cases) {
    const d = Object.assign(serverData(), extra);
    const r = await a.put("/api/config", { baseVersion: v0, data: d, caps: CAPS });
    assert.equal(r.status, 400, "must reject " + JSON.stringify(extra).slice(0, 80));
    assert.equal(r.json.code, "bad_spaces");
    assert.ok(Array.isArray(r.json.spaces) && r.json.spaces[0].problem);
    const s = await a.post("/api/config/stash", { baseVersion: v0, data: d });
    assert.equal(s.status, 400); assert.equal(s.json.code, "bad_spaces");
  }
  const after = await cur(a);
  assert.equal(after.version, v0, "no version written by any rejected request");
  assert.ok(!("spaces" in after.data));
  // 24 spaces with long-but-legal names are fine
  const ok = Object.assign(serverData(), { spaces: Array.from({ length: 24 }, (_, i) => ({ id: "s" + i, name: "空间".repeat(11) + i, groupIds: [] })) });
  assert.equal((await a.put("/api/config", { baseVersion: v0, data: ok, caps: CAPS })).status, 200);
});

test("V1.1 config without spaces stays byte-identical through the new server; spaces round-trip; dangling refs pruned", async (t) => {
  const { a } = await boot(t);
  const d0 = serverData();
  const r0 = await a.put("/api/config", { baseVersion: 0, data: d0 });
  assert.equal(r0.status, 200); assert.equal(r0.json.migrated, undefined, "no spaces work for an old config");
  const g0 = await cur(a);
  assert.equal(JSON.stringify(g0.data), JSON.stringify(d0), "byte-equal: no spaces field added, order/name/url/icon/ids unchanged");
  // add spaces (V2 client)
  const d1 = Object.assign(structuredClone(g0.data), { spaces: structuredClone(SPACES) });
  const r1 = await a.put("/api/config", { baseVersion: g0.version, data: d1, caps: CAPS });
  assert.equal(r1.status, 200); assert.equal(r1.json.version, g0.version + 1); assert.equal(r1.json.migrated, undefined);
  const g1 = await cur(a);
  assert.deepEqual(g1.data.spaces, SPACES);
  assert.equal(JSON.stringify(g1.data.groups), JSON.stringify(d0.groups), "groups/items untouched by spaces");
  // dangling refs (e.g. a group deleted by some client) → pruned before storing, client told to re-pull
  const d2 = structuredClone(g1.data);
  d2.groups = d2.groups.filter((g) => g.id !== "dl92kfa0q1z");
  const r2 = await a.put("/api/config", { baseVersion: g1.version, data: d2, caps: CAPS });
  assert.equal(r2.status, 200); assert.equal(r2.json.migrated, true); assert.equal(r2.json.spacesPruned, 2);
  const g2 = await cur(a);
  assert.deepEqual(g2.data.spaces.map((s) => s.groupIds), [["chips00daily"], ["st0rage9kq2"]]);
  assert.deepEqual(g2.data.spaces[1].itemIds, ["e7h2kq9b1m"], "item pin survives");
  // V2 client deletes every space explicitly (caps) → really gone
  const d3 = structuredClone(g2.data); delete d3.spaces;
  assert.equal((await a.put("/api/config", { baseVersion: g2.version, data: d3, caps: CAPS })).status, 200);
  assert.ok(!("spaces" in (await cur(a)).data), "caps:[spaces] + no field = intentional removal");
});

test("old-frontend protection: a save without caps and without spaces keeps the stored space definitions", async (t) => {
  const { a } = await boot(t);
  await a.put("/api/config", { baseVersion: 0, data: Object.assign(serverData(), { spaces: structuredClone(SPACES) }), caps: CAPS });
  let g = await cur(a);
  // V1.1-style body (no caps), item edited, spaces missing (e.g. stale cache from before V2)
  const d = serverData(); d.groups[0].items[0].title = "Emby 改名";
  const r = await a.put("/api/config", { baseVersion: g.version, data: d, opId: "legacyop0001" });
  assert.equal(r.status, 200); assert.equal(r.json.spacesKept, true); assert.equal(r.json.migrated, true, "old client re-pulls (gets spaces back into its state)");
  g = await cur(a);
  assert.equal(g.data.groups[0].items[0].title, "Emby 改名", "the edit is saved");
  assert.deepEqual(g.data.spaces, SPACES, "spaces preserved");
  // identical content minus spaces → unchanged, no new version
  const same = structuredClone(g.data); delete same.spaces;
  const r2 = await a.put("/api/config", { baseVersion: g.version, data: same });
  assert.equal(r2.status, 200); assert.equal(r2.json.version, g.version); assert.equal(r2.json.spacesKept, true);
  assert.equal((await cur(a)).version, g.version, "no version bump");
  // old client deletes a referenced group: kept + pruned
  const del = structuredClone(g.data); delete del.spaces; del.groups = del.groups.filter((x) => x.id !== "st0rage9kq2");
  const r3 = await a.put("/api/config", { baseVersion: g.version, data: del });
  assert.equal(r3.json.spacesKept, true); assert.equal(r3.json.spacesPruned, 1);
  assert.deepEqual((await cur(a)).data.spaces[1].groupIds, ["dl92kfa0q1z"]);
  // old client that DOES carry spaces (it loaded them from the server) → its copy is used as-is
  const g3 = await cur(a), withSp = structuredClone(g3.data); withSp.spaces[0].name = "日常2";
  assert.equal((await a.put("/api/config", { baseVersion: g3.version, data: withSp })).json.spacesKept, undefined);
  assert.equal((await cur(a)).data.spaces[0].name, "日常2");
});

test("409 conflict / force overwrite / opId dedupe / backups + restore all carry spaces", async (t) => {
  const { srv, a } = await boot(t);
  const b = client(srv.base);
  await b.post("/api/login", { name: "admin", password: "admin-pass-1" });
  const v1 = (await a.put("/api/config", { baseVersion: 0, data: Object.assign(serverData(), { spaces: structuredClone(SPACES) }), caps: CAPS, opId: "op-a-000001" })).json.version;
  // opId replay with identical content → duplicate, no new version
  const dup = await a.put("/api/config", { baseVersion: 0, data: Object.assign(serverData(), { spaces: structuredClone(SPACES) }), caps: CAPS, opId: "op-a-000001" });
  assert.equal(dup.status, 200); assert.equal(dup.json.duplicate, true); assert.equal(dup.json.version, v1);
  // same opId, different spaces → 422
  const mis = await a.put("/api/config", { baseVersion: v1, data: Object.assign(serverData(), { spaces: [SPACES[0]] }), caps: CAPS, opId: "op-a-000001" });
  assert.equal(mis.status, 422); assert.equal(mis.json.code, "opid_mismatch");
  // device B changes spaces
  const gb = await cur(b), db = structuredClone(gb.data); db.spaces[0].name = "B 的日常";
  const v2 = (await b.put("/api/config", { baseVersion: gb.version, data: db, caps: CAPS })).json.version;
  // device A, stale base → 409 (spaces count reported), nothing written
  const da = Object.assign(serverData(), { spaces: [{ id: "s-a", name: "A 的空间", groupIds: ["mzq1a0lq8x2"] }] });
  const c409 = await a.put("/api/config", { baseVersion: v1, data: da, caps: CAPS });
  assert.equal(c409.status, 409); assert.equal(c409.json.conflict, true); assert.equal(c409.json.spaces, 2);
  assert.equal((await cur(a)).data.spaces[0].name, "B 的日常");
  // A: 「用本机版覆盖」 → server version (with B's spaces) backed up first
  const f = await a.put("/api/config", { baseVersion: v1, data: da, caps: CAPS, force: true, expectVersion: v2 });
  assert.equal(f.status, 200); assert.equal(f.json.forced, true);
  assert.deepEqual((await cur(a)).data.spaces.map((s) => s.name), ["A 的空间"]);
  const list = (await a.get("/api/config/backups")).json;
  const replaced = list.find((x) => x.kind === "replaced");
  assert.ok(replaced); assert.equal(replaced.spaces, 2, "backup summary counts spaces");
  const bk = (await a.get("/api/config?backup=" + encodeURIComponent(replaced.id))).json;
  assert.deepEqual(bk.data.spaces.map((s) => s.name), ["B 的日常", "NAS"], "backup ring keeps the space definitions");
  // 恢复较早的版本 (restore:true) → current version backed up, spaces restored
  const g = await cur(a);
  const rr = await a.put("/api/config", { baseVersion: g.version, data: bk.data, caps: CAPS, restore: true });
  assert.equal(rr.status, 200);
  assert.deepEqual((await cur(a)).data.spaces.map((s) => s.name), ["B 的日常", "NAS"]);
  assert.ok((await a.get("/api/config/backups")).json.some((x) => x.kind === "restore" && x.spaces === 1));
  // stash (冲突时「使用服务器版」留下本机版) keeps spaces too
  assert.equal((await a.post("/api/config/stash", { baseVersion: 1, data: da })).status, 200);
  const local = (await a.get("/api/config/backups")).json.find((x) => x.kind === "local");
  assert.equal(local.spaces, 1);
});

test("URL allowlist and aliases limits still apply with spaces present; accounts are isolated", async (t) => {
  const { srv, a } = await boot(t);
  assert.equal((await a.post("/api/users", { name: "bob", password: "bob-pass-12" })).status, 200);
  const bob = client(srv.base);
  await bob.post("/api/login", { name: "bob", password: "bob-pass-12" });
  const v = (await a.put("/api/config", { baseVersion: 0, data: Object.assign(serverData(), { spaces: structuredClone(SPACES) }), caps: CAPS })).json.version;
  const evil = Object.assign(serverData(), { spaces: structuredClone(SPACES) });
  evil.groups[0].items.push({ id: "evil01", title: "x", lan: "", wan: "javascript:alert(1)" });
  const r = await a.put("/api/config", { baseVersion: v, data: evil, caps: CAPS });
  assert.equal(r.status, 400); assert.ok(r.json.invalid, "unsafe URL rejection unchanged");
  const al = Object.assign(serverData(), { spaces: structuredClone(SPACES) });
  al.groups[0].items[0].aliases = Array.from({ length: 11 }, (_, i) => "a" + i);
  const r2 = await a.put("/api/config", { baseVersion: v, data: al, caps: CAPS });
  assert.equal(r2.status, 400); assert.equal(r2.json.code, "bad_aliases");
  // isolation: bob sees none of admin's spaces; bob's spaces never touch admin
  const gb = await cur(bob);
  assert.equal(gb.data, null);
  assert.equal((await bob.put("/api/config", { baseVersion: 0, data: Object.assign(serverData(), { spaces: [{ id: "s-bob", name: "Bob", groupIds: [] }] }), caps: CAPS })).status, 200);
  assert.deepEqual((await cur(a)).data.spaces.map((s) => s.id), ["s-daily", "s-nas"]);
  assert.deepEqual((await cur(bob)).data.spaces.map((s) => s.id), ["s-bob"]);
  assert.equal((await bob.get("/api/users")).status, 403, "non-admin still 403");
  assert.equal((await client(srv.base).get("/api/config")).status, 401);
});

test("/api/status exposes the server-measured latency (ms) — real numbers only, null when not measured", async (t) => {
  const mock = await mockServer((q, s) => { s.writeHead(200); s.end("ok"); });
  t.after(() => mock.close());
  const { a } = await boot(t);
  await a.put("/api/config", { baseVersion: 0, data: { settings: { title: "t" }, groups: [{ id: "g", name: "g", items: [
    { id: "up", title: "up", lan: "http://127.0.0.1:" + mock.port + "/" },
    { id: "down", title: "down", lan: "http://127.0.0.1:1/" },
  ] }], spaces: [{ id: "s1", name: "NAS", groupIds: ["g"] }] }, caps: CAPS });
  const st = await waitFor(async () => { const r = (await a.get("/api/status")).json; return r.up && r.down ? r : null; }, 8000);
  assert.ok(st, "status arrived");
  assert.equal(st.up.status, "up");
  assert.equal(typeof st.up.ms, "number"); assert.ok(st.up.ms >= 0 && st.up.ms < 4000, "measured with hrtime around the real request");
  assert.ok(Date.parse(st.up.checkedAt) > 0);
  assert.equal(st.down.status, "down"); assert.equal(st.down.ms, null, "no fake latency for a failed probe");
});
