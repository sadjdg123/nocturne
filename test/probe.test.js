"use strict";
/* 服务端状态探测：管理员正常探测、普通账户受 PROBE_ALLOW 限制、永久拦截目标、不跟随重定向、blocked ≠ offline */
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client, mockServer, cfg, waitFor } = require("./helpers");

async function setup(t, env) {
  const mock = await mockServer((q, s) => {
    if (q.url.startsWith("/redirect")) { s.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }); return s.end(); }
    if (q.url.startsWith("/login")) { s.writeHead(401); return s.end(); }
    if (q.url.startsWith("/broken")) { s.writeHead(503); return s.end(); }
    s.writeHead(200); s.end("ok");
  });
  const srv = await startServer({ env: Object.assign({ PROBE_TIMEOUT: "2" }, env || {}) });
  t.after(async () => { await srv.stop(); await mock.close(); });
  const admin = client(srv.base);
  await admin.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  await admin.post("/api/users", { name: "bob", password: "bob-pass-1" });
  const bob = client(srv.base);
  await bob.post("/api/login", { name: "bob", password: "bob-pass-1" });
  return { srv, mock, admin, bob };
}
const M = (mock, p) => "http://127.0.0.1:" + mock.port + (p || "/");

test("admin URLs probed; hard blocks; redirect not followed; non-admin restricted by default", async (t) => {
  const { srv, mock, admin, bob } = await setup(t);
  await admin.put("/api/config", { baseVersion: 0, data: cfg("a", [
    { id: "up", title: "up", lan: M(mock, "/ok") },
    { id: "auth", title: "auth", lan: M(mock, "/login") },
    { id: "down", title: "down", lan: M(mock, "/broken") },
    { id: "redir", title: "redir", lan: M(mock, "/redirect") },
    { id: "meta", title: "meta", lan: "http://169.254.169.254/latest/" },
    { id: "meta6", title: "meta6", lan: "http://[::ffff:169.254.169.254]/" },
    { id: "nat64", title: "nat64", lan: "http://[64:ff9b::a9fe:a9fe]/" },
    { id: "self", title: "self", lan: "http://127.0.0.1:" + srv.port + "/api/health" },
    { id: "nodns", title: "nodns", lan: "http://does-not-exist.nocturne-test-invalid-tld/" },
    { id: "reserved", title: "reserved", wan: "https://emby.example.com" },
    { id: "empty", title: "empty", lan: "", wan: "" },
  ]) });
  const st = await waitFor(async () => { const r = (await admin.get("/api/status")).json; return r.up && r.meta && r.nodns && r.redir ? r : null; }, 8000);
  assert.ok(st, "status arrived");
  assert.equal(st.up.status, "up");
  assert.equal(st.auth.status, "auth"); assert.equal(st.auth.code, 401);
  assert.equal(st.down.status, "down"); assert.equal(st.down.code, 503);
  assert.equal(st.redir.code, 302, "first response only");
  assert.ok(!mock.hits.some((h) => h.startsWith("/latest")), "redirect target never requested");
  for (const k of ["meta", "meta6", "nat64", "self"]) assert.equal(st[k].status, "blocked", k + " must be blocked, not offline");
  assert.equal(st.nodns.status, "down");
  assert.equal(st.reserved.status, "down"); assert.equal(st.reserved.error, "reserved domain");
  assert.equal(st.empty, undefined, "no address → nothing to report");

  // non-admin: same mock URL plus a private one only bob has → not probed by the server (browser falls back)
  const before = mock.hits.length;
  await bob.put("/api/config", { baseVersion: 0, data: cfg("b", [
    { id: "b-own", title: "own", lan: M(mock, "/bob-only") },
    { id: "b-shared", title: "shared", lan: M(mock, "/ok") },
    { id: "b-meta", title: "meta", lan: "http://169.254.169.254/" },
  ]) });
  await new Promise((r) => setTimeout(r, 2500));
  const bs = (await bob.get("/api/status")).json;
  assert.equal(bs["b-own"], undefined, "non-admin URL not in PROBE_ALLOW → omitted (browser probes it)");
  assert.equal(bs["b-shared"], undefined, "no result leaks from the admin's probe of the same URL");
  assert.ok(!mock.hits.slice(before).some((h) => h.startsWith("/bob-only")), "server never contacted bob's target");
  assert.equal(bs["b-meta"], undefined, "default policy: the server does not even resolve non-admin targets");
});

test("PROBE_ALLOW lets non-admin targets through; per-user cap", async (t) => {
  const { mock, bob } = await setup(t, { PROBE_ALLOW: "127.0.0.1", PROBE_MAX_PER_USER: "3" });
  const items = [{ id: "ok", title: "ok", lan: M(mock, "/ok") }, { id: "auth", title: "auth", lan: M(mock, "/login") }, { id: "ext", title: "ext", lan: "http://10.255.255.1:9/" }];
  for (let i = 0; i < 5; i++) items.push({ id: "extra" + i, title: "x" + i, lan: M(mock, "/extra" + i) });
  await bob.put("/api/config", { baseVersion: 0, data: cfg("b", items) });
  const st = await waitFor(async () => { const r = (await bob.get("/api/status")).json; return r.ok && r.auth ? r : null; }, 8000);
  assert.equal(st.ok.status, "up");
  assert.equal(st.auth.status, "auth");
  assert.equal(st.ext, undefined, "10.255.255.1 is not in PROBE_ALLOW → not probed");
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(!mock.hits.some((h) => /^\/extra/.test(h)), "beyond PROBE_MAX_PER_USER nothing is probed");
});
