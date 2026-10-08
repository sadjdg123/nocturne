"use strict";
/* 代理头信任边界：TRUSTED_PROXY_CIDRS 未配置时转发头无效；配置后从可信代理正确识别客户端 IP / HTTPS */
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client } = require("./helpers");

const secure = (r) => r.setCookie.some((c) => /;\s*Secure/i.test(c));

test("no trusted proxy: forged headers change nothing", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const admin = client(srv.base);
  const s = await admin.post("/api/setup", { name: "admin", password: "admin-pass-1" }, { "X-Forwarded-Proto": "https" });
  assert.equal(s.status, 200);
  assert.equal(secure(s), false, "X-Forwarded-Proto from an untrusted peer must not set Secure");

  const h = await admin.get("/api/health", { "X-Forwarded-For": "1.2.3.4", "X-Real-IP": "5.6.7.8" });
  assert.equal(h.json.client.peer, "127.0.0.1");
  assert.equal(h.json.client.ip, "127.0.0.1");
  assert.equal(h.json.client.trustedPeer, false);
  assert.equal(h.json.client.lan, false, "forwarded headers from an untrusted peer void the LAN exemption");
  assert.equal((await client(srv.base).get("/api/health")).json.client, undefined, "diagnostic is admin-only");

  // the per-IP limiter keys on the TCP peer: rotating forged XFF / X-Real-IP does not get extra attempts
  const attacker = client(srv.base);
  const codes = [];
  for (let i = 0; i < 7; i++) {
    const r = await attacker.post("/api/login", { name: "admin", password: "nope-" + i }, { "X-Forwarded-For": "203.0.113." + i, "X-Real-IP": "198.51.100." + i });
    codes.push(r.status);
  }
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(codes[5], 429);
  assert.equal(codes[6], 429);
  // the owner's known-device cookie is exempt from the shared per-IP lock (owner not locked out behind an unconfigured proxy)
  const owner = client(srv.base);
  owner.jar.set("nocturne_dev", admin.jar.get("nocturne_dev"));
  assert.equal((await owner.post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 200);
  assert.equal((await client(srv.base).post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 429, "others stay locked");
});

test("trusted proxy: client IP from XFF (right-to-left), proto honoured", async (t) => {
  const srv = await startServer({ env: { TRUSTED_PROXY_CIDRS: "127.0.0.1/32, 10.0.0.0/8" } });
  t.after(() => srv.stop());
  const admin = client(srv.base);
  const s = await admin.post("/api/setup", { name: "admin", password: "admin-pass-1" }, { "X-Forwarded-Proto": "https" });
  assert.equal(secure(s), true, "X-Forwarded-Proto from a trusted proxy sets Secure");
  const h = (await admin.get("/api/health", { "X-Forwarded-For": "9.9.9.9, 1.2.3.4, 10.1.1.1" })).json.client;
  assert.equal(h.trustedPeer, true);
  assert.equal(h.ip, "1.2.3.4", "skip trusted hops from the right; left-most (client-supplied) value ignored");
  assert.equal((await admin.get("/api/health", { "X-Real-IP": "192.168.1.50" })).json.client.ip, "192.168.1.50");
  assert.equal((await admin.get("/api/health", { "X-Forwarded-For": "garbage, 1.2.3.4" })).json.client.ip, "1.2.3.4");
  assert.equal((await admin.get("/api/health", { "X-Forwarded-For": "1.2.3.4, garbage" })).json.client.ip, "127.0.0.1", "malformed hop stops the walk");
  const lan = (await admin.get("/api/health", { "X-Forwarded-For": "192.168.1.50" })).json.client;
  assert.equal(lan.lan, true, "LAN exemption judged on the resolved client IP");

  // limiter is per real client: client A locked, client B unaffected
  const a = client(srv.base, { headers: { "X-Forwarded-For": "1.2.3.4" } });
  for (let i = 0; i < 5; i++) assert.equal((await a.post("/api/login", { name: "admin", password: "bad-" + i })).status, 401);
  assert.equal((await a.post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 429);
  const b = client(srv.base, { headers: { "X-Forwarded-For": "1.2.3.5" } });
  assert.equal((await b.post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 200);
});
