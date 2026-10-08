"use strict";
/* V2.0 场景空间模型（public/spaces.js）：迁移、引用一致性、删除 / 移动 / 复制、顺序定义、清洗、校验、本机当前空间 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../public/spaces.js");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
const fresh = () => structuredClone(FIX);
const ids = (v) => v.map((x) => [x.group.id, x.items.map((i) => i.id), x.whole]);
function memStore() { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }

test("migration: a realistic V1.1 config without spaces is byte-identical after normalize/prune/view/check (only 「全部」)", () => {
  const d = fresh(), before = JSON.stringify(d);
  assert.equal(S.normalize(d), false, "normalize reports no change");
  assert.equal(S.prune(d), 0);
  assert.equal(JSON.stringify(d), before, "groups/items/settings byte-equal, no spaces field added");
  assert.ok(!("spaces" in d));
  assert.deepEqual(S.check(d), []);
  assert.deepEqual(S.list(d), []);
  assert.equal(S.resolve(d, "s-anything"), S.ALL);
  const v = S.view(d, S.ALL);
  assert.deepEqual(v.map((x) => x.group.id), FIX.groups.map((g) => g.id), "全部 = every group in global order (incl. empty group)");
  assert.equal(v.reduce((n, x) => n + x.items.length, 0), 10, "every item visible");
  v.forEach((x, i) => assert.equal(x.group, d.groups[i], "same objects, not copies"));
  assert.equal(JSON.stringify(d), before, "view does not mutate");
});

test("spaces reference ids only; same group in several spaces; editing an item is global", () => {
  const d = fresh();
  const a = S.add(d, { name: "日常", groupIds: ["chips00daily", "dl92kfa0q1z"], theme: "dawn" });
  const b = S.add(d, { name: "NAS", groupIds: ["st0rage9kq2", "dl92kfa0q1z"], itemIds: ["e7h2kq9b1m"], theme: "frost", density: "compact" });
  assert.deepEqual(S.check(d), []);
  assert.equal(JSON.stringify(d.spaces).includes("MoviePilot"), false, "no item copies inside spaces");
  assert.deepEqual(Object.keys(d.spaces[1]).sort(), ["density", "groupIds", "id", "itemIds", "name", "theme"]);
  assert.deepEqual(S.membership(d)["dl92kfa0q1z"], [a, b]);
  // edit MoviePilot once → both spaces see it
  d.groups[1].items[0].wan = "https://mp2.home.arpa"; d.groups[1].items[0].aliases = ["mp", "订阅"];
  const pa = S.view(d, a).find((x) => x.group.id === "dl92kfa0q1z").items[0], pb = S.view(d, b).find((x) => x.group.id === "dl92kfa0q1z").items[0];
  assert.equal(pa, pb, "same entity");
  assert.equal(pa.wan, "https://mp2.home.arpa");
  // ordering = global order, not groupIds order
  assert.deepEqual(ids(S.view(d, b)), [["mzq1a0lq8x2", ["e7h2kq9b1m"], false], ["dl92kfa0q1z", ["mp7r2x0k1a", "qb5t1z8w0e"], true], ["st0rage9kq2", ["syn920plus", "uk3001xyzq"], true]]);
  assert.deepEqual(ids(S.view(d, a)).map((x) => x[0]), ["dl92kfa0q1z", "chips00daily"], "groupIds order ignored; global order wins");
  // reorder groups globally → every space follows
  d.groups.reverse();
  assert.deepEqual(ids(S.view(d, a)).map((x) => x[0]), ["chips00daily", "dl92kfa0q1z"]);
});

test("delete item / delete group / move item / duplicate item keep references consistent", () => {
  const d = fresh();
  const s = S.add(d, { name: "影音", groupIds: ["mzq1a0lq8x2"], itemIds: ["mp7r2x0k1a", "syn920plus"] });
  // move pinned item MoviePilot from 下载 to 常用 → reference still works (by id)
  const mp = d.groups[1].items.splice(0, 1)[0]; d.groups[3].items.push(mp);
  assert.equal(S.prune(d), 0);
  assert.deepEqual(ids(S.view(d, s)), [["mzq1a0lq8x2", ["e7h2kq9b1m", "p1x0c4n8vz", "jf00000001"], true], ["st0rage9kq2", ["syn920plus"], false], ["chips00daily", ["mp7r2x0k1a"], false]]);
  // duplicate an item of a whole group: new id, not added to itemIds, but visible through the group
  const copy = Object.assign(structuredClone(d.groups[0].items[0]), { id: "copy000001" }); d.groups[0].items.splice(1, 0, copy);
  assert.deepEqual(S.get(d, s).itemIds, ["mp7r2x0k1a", "syn920plus"], "copy not auto-pinned");
  assert.ok(S.view(d, s)[0].items.includes(copy));
  // duplicate a pinned item (group not in space): copy not visible in the space
  const c2 = Object.assign(structuredClone(d.groups[2].items[0]), { id: "copy000002" }); d.groups[2].items.push(c2);
  assert.ok(!S.view(d, s).some((x) => x.items.includes(c2)));
  // delete pinned item
  d.groups[2].items = d.groups[2].items.filter((i) => i.id !== "syn920plus");
  assert.equal(S.prune(d), 1);
  assert.deepEqual(S.get(d, s).itemIds, ["mp7r2x0k1a"]);
  // delete a whole group that is referenced and contains a pinned item
  d.groups = d.groups.filter((g) => g.id !== "chips00daily" && g.id !== "mzq1a0lq8x2");
  assert.equal(S.prune(d), 2, "groupId + pinned item inside the deleted group");
  assert.deepEqual(S.get(d, s), { id: s, name: "影音", groupIds: [], itemIds: [] }, "space kept (empty), no dangling refs");
  assert.deepEqual(S.view(d, s), [], "empty space → empty view (UI shows 空状态)");
});

test("delete space removes only the relation; 全部 cannot be deleted; move reorders spaces", () => {
  const d = fresh(), groupsBefore = JSON.stringify(d.groups), settingsBefore = JSON.stringify(d.settings);
  const a = S.add(d, { name: "A", groupIds: ["mzq1a0lq8x2"] }), b = S.add(d, { name: "B", groupIds: ["mzq1a0lq8x2"] }), c = S.add(d, { name: "C" });
  assert.ok(S.move(d, c, 0));
  assert.deepEqual(d.spaces.map((x) => x.id), [c, a, b]);
  assert.ok(S.remove(d, a));
  assert.equal(S.remove(d, "nope"), false);
  assert.throws(() => S.remove(d, S.ALL), /不能删除/);
  assert.equal(JSON.stringify(d.groups), groupsBefore, "groups/items untouched");
  assert.equal(JSON.stringify(d.settings), settingsBefore, "wallpaper/settings untouched");
  S.remove(d, b); S.remove(d, c);
  assert.deepEqual(d.spaces, [], "deleting the last space leaves an explicit empty list");
});

test("names: required, ≤24 chars, unique (case-insensitive), 「全部」 reserved; cap 24 spaces", () => {
  const d = fresh();
  assert.throws(() => S.add(d, { name: "  " }), /不能为空/);
  assert.throws(() => S.add(d, { name: "全部" }), /保留名称/);
  assert.throws(() => S.add(d, { name: "x".repeat(25) }), /最多 24/);
  S.add(d, { name: "😀".repeat(24) }); // 24 code points OK
  const id = S.add(d, { name: "Daily" });
  assert.throws(() => S.add(d, { name: " daily " }), /已经有/);
  assert.throws(() => S.rename(d, id, "😀".repeat(24)), /已经有/);
  S.rename(d, id, "日常 ");
  assert.equal(S.get(d, id).name, "日常");
  for (let i = d.spaces.length; i < S.MAX_SPACES; i++) S.add(d, { name: "s" + i });
  assert.throws(() => S.add(d, { name: "overflow" }), /最多 24 个空间/);
  assert.deepEqual(S.check(d), []);
  assert.throws(() => S.add(fresh(), { name: "x", theme: "neon" }), /theme/);
  const e = fresh(), sid = S.add(e, { name: "x" });
  S.setLook(e, sid, { theme: "dusk", density: "poster" }); assert.equal(S.get(e, sid).density, "poster");
  S.setLook(e, sid, { theme: null }); assert.ok(!("theme" in S.get(e, sid)));
  S.pin(e, sid, "qb5t1z8w0e"); S.pin(e, sid, "qb5t1z8w0e"); assert.deepEqual(S.get(e, sid).itemIds, ["qb5t1z8w0e"]);
  S.pin(e, sid, "qb5t1z8w0e", false); assert.deepEqual(S.get(e, sid).itemIds, []);
  S.setGroups(e, sid, ["st0rage9kq2", "gone"]); assert.deepEqual(S.get(e, sid).groupIds, ["st0rage9kq2"]);
});

test("check(): rejects malformed structures (server + import)", () => {
  const base = () => Object.assign(fresh(), { spaces: [{ id: "s1", name: "A", groupIds: [] }] });
  const bad = (mut, re) => { const d = base(); mut(d); const r = S.check(d); assert.ok(r.length, "expected a problem for " + re); assert.match(r.map((x) => x.problem).join("|"), re); };
  bad((d) => { d.spaces = {}; }, /数组/);
  bad((d) => { d.spaces = "x"; }, /数组/);
  bad((d) => { d.spaces.push(null); }, /对象/);
  bad((d) => { d.spaces[0].id = "a b"; }, /id/);
  bad((d) => { d.spaces[0].id = "x".repeat(41); }, /id/);
  bad((d) => { d.spaces[0].id = 7; }, /id/);
  bad((d) => { d.spaces[0].id = "all"; }, /保留/);
  bad((d) => { d.spaces.push({ id: "s1", name: "B", groupIds: [] }); }, /id 重复/);
  bad((d) => { d.spaces.push({ id: "s2", name: "a", groupIds: [] }); }, /重复/);
  bad((d) => { d.spaces[0].name = "全部"; }, /重复/);
  bad((d) => { d.spaces[0].name = ""; }, /不能为空/);
  bad((d) => { d.spaces[0].name = 5; }, /不能为空/);
  bad((d) => { d.spaces[0].name = "x".repeat(25); }, /24/);
  bad((d) => { d.spaces[0].name = "a\u0000b"; }, /控制字符/);
  bad((d) => { delete d.spaces[0].groupIds; }, /groupIds/);
  bad((d) => { d.spaces[0].groupIds = "g1"; }, /groupIds/);
  bad((d) => { d.spaces[0].groupIds = [1]; }, /groupIds/);
  bad((d) => { d.spaces[0].groupIds = ["x".repeat(65)]; }, /groupIds/);
  bad((d) => { d.spaces[0].groupIds = Array.from({ length: 501 }, (_, i) => "g" + i); }, /500/);
  bad((d) => { d.spaces[0].itemIds = [{}]; }, /itemIds/);
  bad((d) => { d.spaces[0].theme = "<script>"; }, /theme/);
  bad((d) => { d.spaces[0].density = 3; }, /density/);
  bad((d) => { d.spaces[0].items = [{ title: "copy" }]; }, /未知字段 items（保留字段名/); // 空间不能变成第二套项目集合（阶段 2 扩展字段规则）
  /* 阶段 2：不认识的字段 = 扩展字段，限制内放行（向前兼容），畸形的照样拒绝 */
  bad((d) => { d.spaces[0]["bad-key"] = 1; }, /字段名不合法/);
  bad((d) => { d.spaces[0].accent = { title: "x" }; }, /键名不合法/);
  bad((d) => { d.spaces[0].accent = { a: { b: { c: { d: 1 } } } }; }, /嵌套/);
  bad((d) => { d.spaces[0].accent = "javascript:alert(1)"; }, /脚本/);
  bad((d) => { d.spaces[0].accent = "x".repeat(1025); }, /太长/);
  bad((d) => { d.spaces[0].accent = Array(65).fill(0); }, /数组/);
  bad((d) => { for (let i = 0; i < 17; i++) d.spaces[0]["x" + i] = i; }, /最多 16/);
  bad((d) => { for (let i = 0; i < 5; i++) d.spaces[0]["x" + i] = "y".repeat(1000); }, /4096/);
  bad((d) => { d.spacesVersion = 1.5; }, /1–999/);
  bad((d) => { d.spacesVersion = "2"; }, /1–999/);
  bad((d) => { d.spaces = Array.from({ length: 25 }, (_, i) => ({ id: "s" + i, name: "n" + i, groupIds: [] })); }, /最多 24/);
  // dangling refs are NOT a structural error (cleaned by prune)
  const ok = base(); ok.spaces[0].groupIds = ["gone"]; ok.spaces[0].itemIds = ["gone-too"]; assert.deepEqual(S.check(ok), []);
  // lenient (import): duplicate names allowed (renamed by normalize)
  const dup = base(); dup.spaces.push({ id: "s2", name: "A", groupIds: [] });
  assert.ok(S.check(dup).length); assert.deepEqual(S.check(dup, { lenient: true }), []);
});

test("normalize(): tolerant cleanup of local/imported data (never throws)", () => {
  const d = fresh();
  d.spaces = [
    { id: "s1", name: "  日常  ", groupIds: ["chips00daily", "chips00daily", "gone"], itemIds: ["mp7r2x0k1a", "gone"], theme: "dawn", junk: 1 },
    { id: "s1", name: "dup id", groupIds: [] },
    null, "x", { id: "all", name: "伪全部", groupIds: [] }, { id: "bad id!", name: "x", groupIds: [] },
    { id: "s2", name: "日常", groupIds: "nope", theme: "neon" },
    { id: "s3", name: "全部", groupIds: [] },
    { id: "s4", name: "", groupIds: [] },
    { id: "s5", name: "x".repeat(40), groupIds: [] },
  ];
  assert.equal(S.normalize(d), true);
  assert.deepEqual(d.spaces.map((s) => [s.id, s.name]), [["s1", "日常"], ["s2", "日常 2"], ["s3", "全部 2"], ["s4", "未命名空间"], ["s5", "x".repeat(24)]]);
  assert.deepEqual(d.spaces[0], { id: "s1", name: "日常", groupIds: ["chips00daily"], itemIds: ["mp7r2x0k1a"], theme: "dawn", junk: 1 }, "valid extension field kept verbatim (stage 2 forward compat)");
  assert.deepEqual(d.spaces[1], { id: "s2", name: "日常 2", groupIds: [] }, "bad theme dropped, bad groupIds → []");
  assert.deepEqual(S.check(d), [], "result passes the strict server check");
  const e = fresh(); e.spaces = "garbage"; assert.equal(S.normalize(e), true); assert.ok(!("spaces" in e));
  const f = fresh(); f.spaces = []; assert.equal(S.normalize(f), false); assert.deepEqual(f.spaces, []);
  assert.doesNotThrow(() => S.normalize({ spaces: [{ id: "s", name: "x", groupIds: [] }] }), "no groups at all");
  assert.doesNotThrow(() => S.view({ groups: [null, { id: "g", items: [null, 3] }], spaces: [{ id: "s", name: "x", groupIds: ["g"] }] }, "s"));
});

test("device-local selection: per-account key, not part of data, unknown/deleted id → 全部", () => {
  const st = memStore(), d = fresh(), before = JSON.stringify(d);
  const nas = S.add(d, { name: "NAS", groupIds: ["st0rage9kq2"] });
  const afterAdd = JSON.stringify(d);
  S.writeSel(st, "Alice", nas);
  assert.equal(JSON.stringify(d), afterAdd, "selecting writes nothing into the config");
  assert.ok(before !== afterAdd);
  assert.equal(S.selKey("Alice"), "nocturne.space:alice");
  assert.equal(st.getItem("nocturne.space:alice"), nas);
  assert.equal(S.readSel(st, "alice", d), nas, "account names are case-insensitive");
  assert.equal(S.readSel(st, "bob", d), S.ALL, "another account never sees Alice's selection");
  const bob = fresh(); assert.equal(S.readSel(st, "alice", bob), S.ALL, "Alice's id is meaningless against Bob's config");
  S.remove(d, nas); assert.equal(S.readSel(st, "Alice", d), S.ALL, "deleted space → 全部");
  st.setItem(S.selKey("alice"), "<img src=x>"); assert.equal(S.readSel(st, "alice", d), S.ALL);
  S.writeSel(st, "alice", S.ALL); assert.equal(st.getItem(S.selKey("alice")), null, "全部 = no key");
  assert.equal(S.selKey(null), "nocturne.space:~local", "static page (no account)");
  const broken = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("x"); }, removeItem() { throw new Error("x"); } };
  assert.equal(S.readSel(broken, "a", d), S.ALL); assert.doesNotThrow(() => S.writeSel(broken, "a", "x"));
});
