"use strict";
/* V1.1 项目搜索别名 item.aliases：共享校验、服务器 400、旧配置兼容、多设备同步、账户隔离、备份恢复 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client, cfg } = require("./helpers");
const U = require("../public/urlcheck.js");

test("normAliases / aliasProblem / checkAliases (shared by browser + server)", () => {
  assert.deepEqual(U.normAliases("mp, 影视订阅，MP , moviepilot,,\n  x   y  "), ["mp", "影视订阅", "moviepilot", "x y"]);
  assert.deepEqual(U.normAliases(["A", "a", " b ", 3, null, ""]), ["A", "b"]);
  assert.deepEqual(U.normAliases(undefined), []);
  assert.equal(U.aliasProblem(undefined), "", "no field = fine (old items)");
  assert.equal(U.aliasProblem([]), "");
  assert.equal(U.aliasProblem(["mp", "影视订阅"]), "");
  assert.equal(U.aliasProblem(["x".repeat(32)]), "");
  assert.equal(U.aliasProblem(["影".repeat(32)]), "", "32 CJK characters allowed");
  for (const bad of ["mp", { a: 1 }, null, 1, Array(11).fill("x"), ["x".repeat(33)], [""], [" a"], ["a "], [1], [null], ["a\u0000b"], ["a\u200bb"], ["a\nb"]]) {
    assert.notEqual(U.aliasProblem(bad), "", "must reject " + JSON.stringify(bad));
  }
  const d = cfg("t", [{ id: "a", title: "A", aliases: ["ok"] }, { id: "b", title: "B", aliases: "nope" }]);
  const r = U.checkAliases(d);
  assert.equal(r.length, 1); assert.equal(r[0].id, "b");
  assert.deepEqual(U.checkAliases(cfg("t", [{ id: "x", title: "X", lan: "http://10.0.0.1" }])), [], "old configs without aliases pass");
  // aliases are never treated as URLs by the URL whitelist
  assert.deepEqual(U.checkConfig(cfg("t", [{ id: "j", title: "J", wan: "https://ok.example.com", aliases: ["javascript:alert(1)", "<img src=x onerror=alert(1)>"] }])), []);
});

test("server: aliases synced, validated (400 bad_aliases), isolated per account, restorable", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const a = client(srv.base);
  await a.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  const a2 = client(srv.base); // 同一账户的第二台设备
  await a2.post("/api/login", { name: "admin", password: "admin-pass-1" });
  await a.post("/api/users", { name: "bob", password: "bob-pass-1" });
  const bob = client(srv.base);
  await bob.post("/api/login", { name: "bob", password: "bob-pass-1" });

  // 旧 JSON（没有 aliases）照常保存，字段不被添加
  const old = cfg("旧", [{ id: "mp", title: "MoviePilot", lan: "http://192.168.1.21:3000", wan: "https://mp.example.com" }]);
  let r = await a.put("/api/config", { baseVersion: 0, opId: "op-al-000001", data: old });
  assert.equal(r.status, 200); assert.equal(r.json.version, 1);
  assert.equal("aliases" in (await a.get("/api/config")).json.data.groups[0].items[0], false);

  // 合法别名 → 200，另一台设备拉到同样的别名
  const withA = structuredClone(old); withA.groups[0].items[0].aliases = ["mp", "影视订阅", "moviepilot"];
  r = await a.put("/api/config", { baseVersion: 1, opId: "op-al-000002", data: withA });
  assert.equal(r.status, 200); assert.equal(r.json.version, 2);
  assert.deepEqual((await a2.get("/api/config")).json.data.groups[0].items[0].aliases, ["mp", "影视订阅", "moviepilot"]);
  // 账户隔离
  assert.equal(JSON.stringify((await bob.get("/api/config")).json).includes("影视订阅"), false);

  // 不合法 → 400，不写入、不升版本（PUT 与 stash 都校验）
  for (const bad of ["mp", Array(11).fill("x"), ["x".repeat(33)], [""], [1], ["a\u0000"], { 0: "a" }]) {
    const d = structuredClone(withA); d.groups[0].items[0].aliases = bad;
    r = await a.put("/api/config", { baseVersion: 2, opId: "op-al-bad-" + String(Math.random()).slice(2, 10), data: d });
    assert.equal(r.status, 400, "PUT must reject " + JSON.stringify(bad));
    assert.equal(r.json.code, "bad_aliases");
    assert.ok(Array.isArray(r.json.aliases) && r.json.aliases[0].id === "mp");
    r = await a.post("/api/config/stash", { baseVersion: 2, data: d });
    assert.equal(r.status, 400, "stash must reject " + JSON.stringify(bad));
  }
  assert.equal((await a.get("/api/config")).json.version, 2, "rejected pushes never bump the version");

  // 版本冲突保护照旧：第二台设备基于旧版本推 → 409
  r = await a2.put("/api/config", { baseVersion: 1, opId: "op-al-a2-0001", data: old });
  assert.equal(r.status, 409);

  // 删掉别名再保存，然后从备份恢复带别名的版本
  r = await a.put("/api/config", { baseVersion: 2, opId: "op-al-000003", data: old });
  assert.equal(r.status, 200); assert.equal(r.json.version, 3);
  r = await a.put("/api/config", { baseVersion: 3, opId: "op-al-000004", restore: true, data: withA });
  assert.equal(r.status, 200); assert.equal(r.json.version, 4);
  const list = (await a.get("/api/config/backups")).json;
  assert.ok(list.some((x) => x.kind === "restore" && x.version === 3));
  assert.deepEqual((await a.get("/api/config")).json.data.groups[0].items[0].aliases, ["mp", "影视订阅", "moviepilot"]);
  // 再恢复到无别名版本：服务器先把当前（带别名的 v4）存成快照 → 从这份快照取回并恢复，别名完整
  r = await a.put("/api/config", { baseVersion: 4, opId: "op-al-000005", restore: true, data: old });
  assert.equal(r.json.version, 5);
  const snap = (await a.get("/api/config/backups")).json.find((x) => x.kind === "restore" && x.version === 4);
  assert.ok(snap, "v4 snapshot exists");
  const got = (await a.get("/api/config?backup=" + snap.id)).json;
  assert.deepEqual(got.data.groups[0].items[0].aliases, ["mp", "影视订阅", "moviepilot"]);
  r = await a.put("/api/config", { baseVersion: 5, opId: "op-al-000006", restore: true, data: got.data });
  assert.equal(r.status, 200);
  assert.deepEqual((await a2.get("/api/config")).json.data.groups[0].items[0].aliases, ["mp", "影视订阅", "moviepilot"]);
});
