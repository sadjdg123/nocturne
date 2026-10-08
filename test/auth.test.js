"use strict";
/* 账户：初始化、登录 / 退出、改密、重置、删除、并发创建、会话失效、Docker 接口权限 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client } = require("./helpers");

test("accounts lifecycle, sessions and concurrency", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const admin = client(srv.base);

  await t.test("setup requires ≥ 8 chars, then only once", async () => {
    assert.equal((await admin.post("/api/setup", { name: "admin", password: "1234567" })).status, 400);
    const r = await admin.post("/api/setup", { name: "admin", password: "admin-pass-1" });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.admin, true);
    assert.equal((await client(srv.base).post("/api/setup", { name: "x", password: "whatever-123" })).status, 409);
  });

  await t.test("concurrent creation of the same name (any case) succeeds once", async () => {
    const names = ["Bob", "bob", "BOB", "bOb", "boB", "Bob", "bob", "BOb"];
    const rs = await Promise.all(names.map((n) => admin.post("/api/users", { name: n, password: "bob-pass-1" })));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
    assert.ok(rs.every((r) => r.status === 200 || r.status === 409));
    const list = (await admin.get("/api/users")).json;
    assert.equal(list.filter((u) => u.name.toLowerCase() === "bob").length, 1);
  });

  await t.test("concurrent creation of different users loses nothing", async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => admin.post("/api/users", { name: "u" + i, password: "pass-word-" + i })));
    assert.ok(rs.every((r) => r.status === 200));
    const list = (await admin.get("/api/users")).json.map((u) => u.name);
    for (let i = 0; i < 8; i++) assert.ok(list.includes("u" + i));
    assert.equal(list.length, 10);
  });

  await t.test("new user password min 8", async () => {
    assert.equal((await admin.post("/api/users", { name: "short", password: "1234567" })).status, 400);
  });

  await t.test("login, docker permission, logout", async () => {
    const bob = client(srv.base);
    assert.equal((await bob.post("/api/login", { name: "bob", password: "wrong-pass" })).status, 401);
    const r = await bob.post("/api/login", { name: "BOB", password: "bob-pass-1" });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.name, "Bob");
    assert.equal((await bob.get("/api/docker")).status, 403, "non-admin must not list containers");
    const d = await admin.get("/api/docker");
    assert.equal(d.status, 200);
    assert.equal(d.json.available, false, "no docker.sock mounted → graceful");
    assert.equal((await bob.post("/api/logout")).status, 200);
    assert.equal((await bob.get("/api/config")).status, 401);
  });

  await t.test("password change drops other sessions; new password ≥ 8", async () => {
    const d1 = client(srv.base), d2 = client(srv.base);
    await d1.post("/api/login", { name: "u1", password: "pass-word-1" });
    await d2.post("/api/login", { name: "u1", password: "pass-word-1" });
    assert.equal((await d1.post("/api/password", { old: "pass-word-1", password: "short" })).status, 400);
    assert.equal((await d1.post("/api/password", { old: "wrong", password: "new-pass-word" })).status, 400);
    assert.equal((await d1.post("/api/password", { old: "pass-word-1", password: "new-pass-word" })).status, 200);
    assert.equal((await d1.get("/api/config")).status, 200, "the device that changed it stays signed in");
    assert.equal((await d2.get("/api/config")).status, 401, "other sessions are dropped");
    assert.equal((await client(srv.base).post("/api/login", { name: "u1", password: "pass-word-1" })).status, 401);
    assert.equal((await client(srv.base).post("/api/login", { name: "u1", password: "new-pass-word" })).status, 200);
  });

  await t.test("admin reset and delete invalidate sessions", async () => {
    const u2 = client(srv.base), u3 = client(srv.base);
    await u2.post("/api/login", { name: "u2", password: "pass-word-2" });
    await u3.post("/api/login", { name: "u3", password: "pass-word-3" });
    assert.equal((await admin.post("/api/users/u2/password", { password: "1234" })).status, 400);
    assert.equal((await admin.post("/api/users/u2/password", { password: "reset-pass-2" })).status, 200);
    assert.equal((await u2.get("/api/config")).status, 401);
    assert.equal((await u3.put("/api/config", { baseVersion: 0, data: { settings: {}, groups: [] } })).status, 200);
    assert.equal((await admin.del("/api/users/u3")).status, 200);
    assert.equal((await u3.get("/api/config")).status, 401);
    assert.equal((await u3.put("/api/config", { baseVersion: 1, data: { settings: { t: 1 }, groups: [] } })).status, 401);
    assert.equal((await admin.del("/api/users/admin")).status, 400, "cannot delete yourself");
  });

  await t.test("concurrent delete + reset of the same user stays consistent", async () => {
    const rs = await Promise.all([admin.del("/api/users/u4"), admin.post("/api/users/u4/password", { password: "another-pass" }), admin.del("/api/users/u4")]);
    assert.equal([rs[0], rs[2]].filter((r) => r.status === 200).length, 1, "exactly one delete wins");
    assert.ok(rs.every((r) => r.status === 200 || r.status === 404));
    const list = (await admin.get("/api/users")).json.map((u) => u.name);
    assert.ok(!list.includes("u4"));
    assert.equal((await client(srv.base).post("/api/login", { name: "u4", password: "another-pass" })).status, 401);
  });
});
