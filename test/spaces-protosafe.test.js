"use strict";
/* 复查修正 C：空间模型与服务端按 id 查表不受原型链影响。
 * ID_RE（/^[A-Za-z0-9_-]{1,40}$/）和引用规则（任意 ≤64 字符的字符串）都允许 constructor / toString / __proto__ / hasOwnProperty / valueOf / prototype，
 * 分组 / 项目 id 本来就不受限制。它们作为空间 id、分组 id、项目 id、悬空引用、未知字段名时：不崩溃、不误判重复 / 存在、清理正确、服务端校验一致。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../public/spaces.js");
const { startServer, client, mockServer, waitFor } = require("./helpers");

const NAMES = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "prototype"];
const CAPS = ["spaces"];
/** 用 JSON.parse 造数据：和真实请求体一样，"__proto__" 是普通的自有属性（对象字面量里写 __proto__ 会变成设原型） */
const J = (o) => JSON.parse(JSON.stringify(o).replace(/"__PROTO__"/g, '"__proto__"'));
const P = (n) => (n === "__proto__" ? "__PROTO__" : n); // 先用占位名构造，再由 J() 换回 __proto__
const plain = (v) => JSON.parse(JSON.stringify(v));

/** 每个保留名都同时是一个分组 id 和该分组里一个项目 id 的前缀，外加一个普通分组 */
function protoData() {
  return J({
    settings: { title: "t" },
    groups: [
      ...NAMES.map((n) => ({ id: P(n), name: "组 " + n, items: [{ id: P(n), title: "项 " + n, lan: "http://192.168.1.2/" }] })),
      { id: "plain", name: "普通", items: [{ id: "i1", title: "x", lan: "http://192.168.1.3/" }] },
    ],
  });
}

test("ID_RE accepts every prototype-ish name; references accept them too (so the model must cope)", () => {
  for (const n of NAMES) assert.ok(S.ID_RE.test(n), n + " matches ID_RE");
  const d = J({ settings: {}, groups: [], spaces: NAMES.map((n, i) => ({ id: P(n), name: "空间" + i, groupIds: [P(n)], itemIds: [P(n)] })) });
  assert.deepEqual(S.check(d), [], "valid structure: no false 'duplicate id' for constructor / __proto__ / …");
  assert.equal(d.spaces[2].id, "__proto__");
  assert.equal(Object.getPrototypeOf(d), Object.prototype, "fixture really carries an own __proto__ key, not a prototype");
});

test("check(): names / ids / unknown keys named like Object.prototype members — no false positives, real duplicates still caught", () => {
  const ok = J({ groups: [], spaces: NAMES.map((n, i) => ({ id: P(n), name: n, groupIds: [] })) });
  assert.deepEqual(S.check(ok), [], "space NAMES constructor / toString / __proto__ … are not 'duplicates'");
  for (const n of NAMES) {
    const dup = J({ groups: [], spaces: [{ id: P(n), name: "a", groupIds: [] }, { id: P(n), name: "b", groupIds: [] }] });
    assert.deepEqual(S.check(dup).map((x) => x.problem), ["id 重复"], "real duplicate " + n);
    const dupName = J({ groups: [], spaces: [{ id: "a", name: n, groupIds: [] }, { id: "b", name: n.toUpperCase(), groupIds: [] }] });
    assert.equal(S.check(dupName).length, 1, "real duplicate name " + n);
    // unknown field named like a prototype member must be rejected (KEYS lookup must not see Object.prototype)
    const extra = J({ groups: [], spaces: [Object.assign({ id: "a", name: "a", groupIds: [] }, { [P(n)]: 1 })] });
    assert.ok(Object.prototype.hasOwnProperty.call(extra.spaces[0], n), "own key " + n);
    assert.deepEqual(S.check(extra).map((x) => x.problem), ["未知字段 " + n], "unknown key " + n + " rejected");
  }
});

test("prune / normalize / view / membership with prototype-ish group, item and space ids; dangling refs with those names are removed", () => {
  const d = protoData();
  d.spaces = J(NAMES.map((n, i) => ({ id: P(n), name: "空间" + i, groupIds: [P(n), "plain"], itemIds: [P(n), "i1"] })));
  assert.deepEqual(S.check(d), []);
  assert.equal(S.prune(d), 0, "every ref exists: nothing pruned");
  assert.equal(S.normalize(d), false, "nothing to fix");
  const m = S.membership(d);
  for (const n of NAMES) {
    assert.deepEqual(plain(m[n]), [n], "membership of group " + n);
    const v = S.view(d, n);
    assert.deepEqual(v.map((x) => [x.group.id, x.whole]), [[n, true], ["plain", true]], "view of space " + n);
    assert.equal(S.get(d, n).id, n); assert.equal(S.resolve(d, n), n);
  }
  assert.equal(m.nope, undefined);
  // drop the groups named like prototype members → refs to them (group AND item refs) are dangling and must go
  d.groups = d.groups.filter((g) => g.id === "plain");
  assert.equal(S.prune(d), NAMES.length * 2, "one group ref + one item ref per space");
  d.spaces.forEach((s) => { assert.deepEqual(s.groupIds, ["plain"]); assert.deepEqual(s.itemIds, ["i1"]); });
  // dangling refs on a config that never had such groups: no false 'exists' via Object.prototype
  const e = J({ settings: {}, groups: [{ id: "plain", items: [{ id: "i1" }] }], spaces: [{ id: "s", name: "s", groupIds: NAMES.map(P).concat("plain"), itemIds: NAMES.map(P).concat("i1") }] });
  assert.equal(S.prune(e), NAMES.length * 2);
  assert.deepEqual(e.spaces[0].groupIds, ["plain"]); assert.deepEqual(e.spaces[0].itemIds, ["i1"]);
  // view of a space whose refs are all dangling prototype names: nothing shown, no crash
  const f = J({ settings: {}, groups: [{ id: "plain", items: [{ id: "i1" }] }], spaces: [{ id: "s", name: "s", groupIds: NAMES.map(P), itemIds: NAMES.map(P) }] });
  assert.deepEqual(S.view(f, "s"), []);
  assert.deepEqual(plain(S.membership(f).constructor), ["s"]);
  assert.deepEqual(plain(S.membership(f)), J(Object.fromEntries(NAMES.map((n) => [P(n), ["s"]]))), "membership reflects refs, prototype-safe");
  assert.equal(Object.getPrototypeOf(S.membership(f)), null);
  // normalize with duplicate prototype-ish ids keeps the first; names constructor/toString kept as-is
  const g = J({ groups: [], spaces: [{ id: P("__proto__"), name: "constructor", groupIds: [] }, { id: P("__proto__"), name: "toString", groupIds: [] }, { id: "valueOf", name: "valueOf", groupIds: [] }] });
  assert.equal(S.normalize(g), true);
  assert.deepEqual(plain(g.spaces).map((s) => [s.id, s.name]), [["__proto__", "constructor"], ["valueOf", "valueOf"]]);
  assert.equal(Object.getPrototypeOf(g), Object.prototype, "no prototype pollution on the data object");
  assert.equal({}.polluted, undefined); assert.equal(Object.prototype.constructor, Object);
});

test("mutations: add / rename / remove / move / setGroups / pin / setLook with prototype-ish ids", () => {
  const d = protoData();
  const id = S.add(d, { name: "constructor", groupIds: NAMES.slice(), itemIds: NAMES.slice() });
  assert.deepEqual(d.spaces[0].groupIds, NAMES, "existing groups named like prototype members are kept");
  assert.notEqual(S.add(d, { name: "toString" }), id);
  assert.throws(() => S.add(d, { name: "CONSTRUCTOR" }), /已经有/, "real duplicate name still rejected");
  S.rename(d, id, "hasOwnProperty");
  S.setGroups(d, id, ["__proto__", "ghost", "plain"]);
  assert.deepEqual(d.spaces[0].groupIds, ["__proto__", "plain"]);
  S.pin(d, id, "valueOf"); S.pin(d, id, "prototype"); S.pin(d, id, "toString", false);
  assert.ok(d.spaces[0].itemIds.includes("valueOf") && d.spaces[0].itemIds.includes("prototype") && !d.spaces[0].itemIds.includes("toString"));
  S.pin(d, id, "notThere"); assert.ok(!d.spaces[0].itemIds.includes("notThere"), "dangling pin pruned");
  // setLook: only own keys count (an object inheriting theme must not change anything)
  const inherited = Object.create({ theme: "frost" });
  S.setLook(d, id, inherited); assert.equal(d.spaces[0].theme, undefined);
  S.setLook(d, id, { theme: "dusk" }); assert.equal(d.spaces[0].theme, "dusk");
  // spaces with prototype-ish ids (as stored data), then remove / move
  d.spaces.push(...J([{ id: P("__proto__"), name: "p", groupIds: [] }, { id: "constructor", name: "c", groupIds: [] }]));
  assert.deepEqual(S.check(d), []);
  assert.equal(S.move(d, "__proto__", 0), true); assert.equal(d.spaces[0].id, "__proto__");
  assert.equal(S.remove(d, "constructor"), true); assert.equal(S.remove(d, "constructor"), false);
  assert.equal(S.remove(d, "toString"), false, "no space with id toString");
  assert.equal(S.get(d, "hasOwnProperty"), null); assert.equal(S.resolve(d, "valueOf"), S.ALL);
  assert.equal(S.get(d, "__proto__").name, "p");
  assert.deepEqual(S.check(d), []);
});

async function boot(t) {
  const srv = await startServer({});
  t.after(() => srv.stop());
  const a = client(srv.base);
  assert.equal((await a.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  return { srv, a };
}
const putRaw = (a, body) => a.req("PUT", "/api/config", Buffer.from(body), { "Content-Type": "application/json" });

test("server: prototype-ish space / group / item ids validate, store and prune correctly; unknown keys and duplicates rejected", async (t) => {
  const { a } = await boot(t);
  const data = protoData();
  data.spaces = J(NAMES.map((n, i) => ({ id: P(n), name: n, groupIds: [P(n), "ghostGroup"], itemIds: [P(n), "hasOwnProperty2"] })));
  // raw JSON body so "__proto__" travels as a real key
  const r = await putRaw(a, JSON.stringify({ baseVersion: 0, data, caps: CAPS }));
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.spacesPruned, NAMES.length * 2, "only the truly dangling refs pruned");
  const g = (await a.get("/api/config")).json;
  assert.deepEqual(g.data.spaces.map((s) => [s.id, s.groupIds, s.itemIds]), NAMES.map((n) => [n, [n], [n]]));
  assert.equal(g.data.groups.length, NAMES.length + 1, "groups named like prototype members stored");
  // deleting those groups (V2 client) prunes their refs server-side even if the client did not
  const d2 = structuredClone(g.data); d2.groups = d2.groups.filter((x) => x.id === "plain");
  const r2 = await putRaw(a, JSON.stringify({ baseVersion: g.version, data: d2, caps: CAPS }));
  assert.equal(r2.status, 200); assert.equal(r2.json.spacesPruned, NAMES.length * 2);
  (await a.get("/api/config")).json.data.spaces.forEach((s) => { assert.deepEqual(s.groupIds, []); assert.deepEqual(s.itemIds, []); });
  // validator: duplicate prototype-ish ids → 400; unknown key named like a prototype member → 400 bad_spaces
  const cur = (await a.get("/api/config")).json;
  for (const n of NAMES) {
    const dup = structuredClone(cur.data); dup.spaces = [{ id: n, name: "a", groupIds: [] }, { id: n, name: "b", groupIds: [] }];
    const rd = await putRaw(a, JSON.stringify({ baseVersion: cur.version, data: dup, caps: CAPS }));
    assert.equal(rd.status, 400); assert.equal(rd.json.code, "bad_spaces"); assert.match(rd.json.spaces[0].problem, /id 重复/);
    const ex = JSON.stringify({ baseVersion: cur.version, data: Object.assign(structuredClone(cur.data), { spaces: [{ id: "a", name: "a", groupIds: [] }] }), caps: CAPS })
      .replace('"groupIds":[]}', '"groupIds":[],' + JSON.stringify(n) + ':1}');
    const re = await putRaw(a, ex);
    assert.equal(re.status, 400, "unknown key " + n); assert.equal(re.json.code, "bad_spaces"); assert.equal(re.json.spaces[0].problem, "未知字段 " + n);
    const st = await a.req("POST", "/api/config/stash", Buffer.from(ex.replace('"caps"', '"x"')), { "Content-Type": "application/json" });
    assert.equal(st.status, 400, "stash validates too");
  }
  assert.equal((await a.get("/api/config")).json.version, cur.version, "nothing written by rejected requests");
  // old client (no caps, no spaces) keeps stored prototype-ish spaces
  const r3 = await putRaw(a, JSON.stringify({ baseVersion: cur.version, data: (() => { const d = structuredClone(cur.data); delete d.spaces; d.settings.title = "旧"; return d; })() }));
  assert.equal(r3.status, 200); assert.equal(r3.json.spacesKept, true);
  assert.deepEqual((await a.get("/api/config")).json.data.spaces.map((s) => s.id), NAMES);
  // server still healthy
  assert.equal((await a.get("/api/health")).status, 200);
});

test("server /api/status keyed by item id: items named __proto__ / constructor are reported, not swallowed", async (t) => {
  const mock = await mockServer((q, s) => { s.writeHead(200); s.end("ok"); });
  t.after(() => mock.close());
  const { a } = await boot(t);
  const u = "http://127.0.0.1:" + mock.port + "/";
  const body = JSON.stringify({ baseVersion: 0, caps: CAPS, data: J({ settings: { title: "t" }, groups: [{ id: "g", name: "g", items: NAMES.map((n) => ({ id: P(n), title: n, lan: u })) }] }) });
  assert.equal((await putRaw(a, body)).status, 200);
  const st = await waitFor(async () => {
    const r = await a.get("/api/status");
    const o = JSON.parse(r.body.toString("utf8"));
    return NAMES.every((n) => Object.prototype.hasOwnProperty.call(o, n) && o[n].status === "up") ? o : null;
  }, 8000);
  assert.ok(st, "every prototype-ish item id has its own status entry");
});
