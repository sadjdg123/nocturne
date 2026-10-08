"use strict";
/* V2.0 阶段 2 · 向前兼容（用户决定）：较旧的 V2 客户端不得悄悄丢掉较新版本加的空间字段。
 * 模拟一个「V2.1 客户端」：给空间加扩展字段（accent 对象、pinnedAt 数字、mood 字符串）并写 spacesVersion: 2，
 * 让它经过本 V2 客户端（模型 / jsdom 真实页面：载入 → 改名 / 勾选分组 / 撤销 / 导出）和本 V2 服务端（存储、补回、限制）后原样回来。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../public/spaces.js");
const { startServer, client } = require("./helpers");
const { openPage, SKIP, sleep } = require("./browser");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const plain = (v) => JSON.parse(JSON.stringify(v));
const deq = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);
const G = FIX.groups.map((g) => g.id);
/** V2.1 客户端写的空间（扩展字段夹在已知字段中间，键顺序也要保住） */
const V21 = () => ({ id: "s-fun", name: "娱乐", accent: { hue: 268, glow: [0.2, 0.6], label: "夜紫" }, groupIds: [G[0]], pinnedAt: 1760000000, theme: "dusk", mood: "calm" });
const V21_DATA = () => Object.assign(serverData(), { spacesVersion: 2, spaces: [V21(), { id: "s-nas", name: "NAS", groupIds: [G[1]] }] });
const CAPS20 = ["spaces", "spaces:1"], CAPS21 = ["spaces", "spaces:2"];

test("model: normalize / rename / setGroups / pin / move / prune keep extension fields verbatim (values and key order)", () => {
  const d = V21_DATA(), before = JSON.stringify(d.spaces);
  assert.deepEqual(S.check(d), [], "a V2.1 config passes this V2 check");
  assert.equal(S.normalize(d), false, "nothing to clean");
  assert.equal(JSON.stringify(d.spaces), before, "byte-identical after normalize");
  S.rename(d, "s-fun", "娱乐 · 夜");
  S.setGroups(d, "s-fun", [G[0], G[2], "gone"]);
  S.pin(d, "s-fun", FIX.groups[3].items[0].id, true);
  S.move(d, "s-fun", 1);
  const s = S.get(d, "s-fun");
  deq(s.accent, V21().accent); assert.equal(s.pinnedAt, 1760000000); assert.equal(s.mood, "calm");
  deq(Object.keys(s).slice(0, 5), ["id", "name", "accent", "groupIds", "pinnedAt"], "key order kept");
  assert.equal(d.spacesVersion, 2, "spacesVersion untouched");
  S.add(d, { name: "日常" }); assert.equal(d.spacesVersion, 2, "add never lowers a newer spacesVersion");
  const e = serverData(); S.add(e, { name: "x" }); assert.equal(e.spacesVersion, S.SCHEMA, "first space writes this client's schema version");
  // malformed extension fields are dropped by normalize (the server would reject them), valid ones kept
  const m = serverData();
  m.spaces = [{ id: "s1", name: "A", groupIds: [], ok: { a: 1 }, "bad-key": 1, deep: { a: { b: { c: { d: 1 } } } }, link: "javascript:x", items: [{ title: "copy" }] }];
  m.spacesVersion = "x";
  assert.equal(S.normalize(m), true);
  deq(m.spaces[0], { id: "s1", name: "A", groupIds: [], ok: { a: 1 } });
  assert.ok(!("spacesVersion" in m), "invalid spacesVersion dropped");
  // budget: >16 extension keys → the extras are dropped in order
  const b = serverData(); b.spaces = [{ id: "s1", name: "A", groupIds: [] }];
  for (let i = 0; i < 20; i++) b.spaces[0]["k" + i] = i;
  S.normalize(b); assert.equal(Object.keys(b.spaces[0]).length, 3 + 16); assert.deepEqual(S.check(b), []);
  assert.equal(S.knownKeys(1).name, true); assert.equal(S.knownKeys(2), null, "a newer schema is unknown to this client");
});

async function boot(t) {
  const srv = await startServer(); t.after(() => srv.stop());
  const a = client(srv.base);
  assert.equal((await a.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  return { srv, a };
}
const cur = async (a) => (await a.get("/api/config")).json;

test("server: V2.1 fields are stored verbatim; an older V2 client that drops them gets them restored; V2.1 itself may delete them", async (t) => {
  const { a } = await boot(t);
  const r0 = await a.put("/api/config", { baseVersion: 0, data: V21_DATA(), caps: CAPS21 });
  assert.equal(r0.status, 200);
  let g = await cur(a);
  assert.equal(JSON.stringify(g.data.spaces), JSON.stringify(V21_DATA().spaces), "stored byte-identical");
  assert.equal(g.data.spacesVersion, 2);
  // (1) an older V2 client (stage 1: caps ["spaces"], its normalize stripped unknown keys) renames the space
  const stripped = structuredClone(g.data);
  stripped.spaces[0] = { id: "s-fun", name: "娱乐2", groupIds: [G[0]], theme: "dusk" }; delete stripped.spacesVersion;
  const r1 = await a.put("/api/config", { baseVersion: g.version, data: stripped, caps: ["spaces"] });
  assert.equal(r1.status, 200); assert.equal(r1.json.migrated, true); assert.equal(r1.json.spacesRestored, 4, "accent, pinnedAt, mood + spacesVersion");
  g = await cur(a);
  const s = g.data.spaces[0];
  assert.equal(s.name, "娱乐2", "the old client's own edit wins"); deq(s.accent, V21().accent); assert.equal(s.pinnedAt, 1760000000); assert.equal(s.mood, "calm");
  assert.equal(g.data.spacesVersion, 2, "spacesVersion never lowered");
  // (2) same with this client's caps ("spaces:1")
  const s2 = structuredClone(g.data); s2.spaces[0] = { id: "s-fun", name: "娱乐3", groupIds: [] };
  assert.equal((await a.put("/api/config", { baseVersion: g.version, data: s2, caps: CAPS20 })).json.spacesRestored, 3);
  g = await cur(a); assert.equal(g.data.spaces[0].mood, "calm"); assert.equal(g.data.spaces[0].theme, undefined, "a field the old client KNOWS (theme) is not restored: it removed it on purpose");
  // (3) the old client deletes the whole space → stays deleted (nothing to restore onto)
  const s3 = structuredClone(g.data); s3.spaces = s3.spaces.filter((x) => x.id !== "s-fun");
  assert.equal((await a.put("/api/config", { baseVersion: g.version, data: s3, caps: CAPS20 })).status, 200);
  g = await cur(a); deq(g.data.spaces.map((x) => x.id), ["s-nas"]);
  // (4) a V2.1 client (newer than this server) removes its own field → trusted, not restored
  const v = (await a.put("/api/config", { baseVersion: g.version, data: Object.assign(structuredClone(g.data), { spaces: [V21()] }), caps: CAPS21 })).json.version;
  const s4 = structuredClone((await cur(a)).data); delete s4.spaces[0].mood;
  const r4 = await a.put("/api/config", { baseVersion: v, data: s4, caps: CAPS21 });
  assert.equal(r4.status, 200); assert.equal(r4.json.spacesRestored, undefined);
  assert.ok(!("mood" in (await cur(a)).data.spaces[0]));
  // (5) a V1.1 client (no caps, no spaces) still keeps the whole definition, extension fields and spacesVersion included
  g = await cur(a);
  const old = structuredClone(g.data); delete old.spaces; delete old.spacesVersion; old.settings.title = "旧版改的";
  assert.equal((await a.put("/api/config", { baseVersion: g.version, data: old })).json.spacesKept, true);
  g = await cur(a); deq(g.data.spaces, s4.spaces); assert.equal(g.data.spacesVersion, 2); assert.equal(g.data.settings.title, "旧版改的");
  // (6) stash (冲突时「使用服务器版」先存本机版) accepts extension fields too
  assert.equal((await a.post("/api/config/stash", { baseVersion: g.version, data: g.data })).status, 200);
});

test("server: restoring never exceeds the extension budget; malformed extension fields are still 400 bad_spaces", async (t) => {
  const { a } = await boot(t);
  const big = Object.assign(serverData(), { spaces: [{ id: "s1", name: "A", groupIds: [] }] });
  for (let i = 0; i < 16; i++) big.spaces[0]["k" + i] = "v" + i;
  assert.equal((await a.put("/api/config", { baseVersion: 0, data: big, caps: CAPS21 })).status, 200);
  let g = await cur(a);
  // old client keeps 16 OTHER extension keys of its own? It cannot know them — simulate a client that sends 16 different ones (still valid alone)
  const mine = structuredClone(g.data); mine.spaces[0] = { id: "s1", name: "A", groupIds: [] };
  for (let i = 0; i < 16; i++) mine.spaces[0]["z" + i] = i;
  const r = await a.put("/api/config", { baseVersion: g.version, data: mine, caps: CAPS20 });
  assert.equal(r.status, 200); assert.equal(r.json.spacesRestored, undefined, "would exceed 16 → this space is left as sent");
  g = await cur(a); assert.ok(!("k0" in g.data.spaces[0]) && "z0" in g.data.spaces[0]);
  for (const ext of [{ "a-b": 1 }, { x: { y: { z: { w: 1 } } } }, { link: "data:text/html,x" }, { items: [] }, { constructor: 1 }]) {
    const d = structuredClone(g.data); Object.assign(d.spaces[0], ext);
    const rr = await a.put("/api/config", { baseVersion: g.version, data: d, caps: CAPS21 });
    assert.equal(rr.status, 400, JSON.stringify(ext)); assert.equal(rr.json.code, "bad_spaces");
  }
  assert.equal((await cur(a)).version, g.version, "nothing written");
});

test("jsdom: this V2 client loads V2.1 data, edits through the real UI paths (rename, group toggle, undo, export) and the fields round-trip", { skip: SKIP, timeout: 60000 }, async (t) => {
  const { srv, a } = await boot(t);
  await a.put("/api/config", { baseVersion: 0, data: V21_DATA(), caps: CAPS21 });
  const p = await openPage(srv.base, a, {});
  t.after(() => p.close());
  await p.idle(1200);
  deq(p.errors, []);
  assert.equal(p.puts().length, 0, "loading V2.1 data pushes nothing (normalize found nothing to change)");
  assert.equal(JSON.stringify(p.A.state.spaces), JSON.stringify(V21_DATA().spaces));
  // rename + toggle a group through the manage sheet
  const doc = p.win.document;
  p.A.emit("spaces-manage", { id: "s-fun" });
  await sleep(50);
  const sheet = doc.querySelector(".x-spm");
  assert.ok(sheet && !sheet.hidden, "manage sheet open");
  const name = sheet.querySelector('[data-sp-name="s-fun"]');
  name.value = "夜场";
  name.form.dispatchEvent(new p.win.Event("submit", { bubbles: true, cancelable: true }));
  const box = sheet.querySelector('input[data-sp-group="' + G[2] + '"]');
  box.click();
  await p.idle();
  const put = p.puts().at(-1);
  assert.equal(put.status, 200);
  deq(put.body.caps, CAPS20);
  const sent = put.body.data.spaces[0];
  assert.equal(sent.name, "夜场"); deq(sent.groupIds, [G[0], G[2]]);
  deq(sent.accent, V21().accent); assert.equal(sent.pinnedAt, 1760000000); assert.equal(sent.mood, "calm");
  assert.equal(put.body.data.spacesVersion, 2);
  assert.equal(put.res.spacesRestored, undefined, "nothing had to be restored: the client kept the fields itself");
  // undo keeps them too
  p.A.undo(); await p.idle();
  assert.equal(p.A.state.spaces[0].mood, "calm");
  const g = await cur(a);
  assert.equal(g.data.spaces[0].name, "夜场"); deq(g.data.spaces[0].groupIds, [G[0]]); deq(g.data.spaces[0].accent, V21().accent);
  // export JSON carries them
  doc.querySelector("[data-a=export]") && doc.querySelector("[data-a=export]").click();
  const exp = JSON.parse(JSON.stringify(p.A.state));
  deq(exp.spaces[0].accent, V21().accent); assert.equal(exp.spacesVersion, 2);
});
