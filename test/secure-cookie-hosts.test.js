"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startServer } = require("./helpers");
// 使用原生 HTTP，确保发送真实 Host；部分 Node fetch 版本会忽略自定义 Host。
function client(base, defaults = {}) {
  const jar = new Map();
  function req(method, p, body, extra = {}) {
    return new Promise((resolve, reject) => {
      const headers = { Host: new URL(base).host, ...defaults.headers, ...extra };
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => k + "=" + v).join("; ");
      const data = body === undefined ? undefined : JSON.stringify(body);
      if (data) headers["Content-Type"] = "application/json";
      const wireHeaders = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).flatMap(x => [k, x]));
      const q = http.request(new URL(p, base), { method, headers: wireHeaders }, r => {
        const chunks = []; r.on("data", b => chunks.push(b)); r.on("error", reject);
        r.on("end", () => {
          const setCookie = r.headers["set-cookie"] || [];
          for (const c of setCookie) {
            const kv = c.split(";")[0], i = kv.indexOf("="), name = kv.slice(0, i), value = kv.slice(i + 1);
            if (!value || /Max-Age=0\b/.test(c)) jar.delete(name); else jar.set(name, value);
          }
          let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* HTTP parser errors may have no JSON body */ }
          resolve({ status: r.statusCode, setCookie, json });
        });
      }); q.on("error", reject); q.end(data);
    });
  }
  return { get: (p, h) => req("GET", p, undefined, h), post: (p, b = {}, h) => req("POST", p, b, h) };
}
const env = { NOCTURNE_SECURE_COOKIE_HOSTS: "jingbo.men" };
const credentials = { name: "admin", password: "admin-pass-1" };
test("cookie domain parser rejects URLs, wildcards, IPs, malformed authorities and ambiguous Host", () => {
  const { secureCookieHosts, cookieHostname } = require("../server");
  assert.deepEqual([...secureCookieHosts("JINGBO.MEN, other.example\nJingbo.men.").hosts], ["jingbo.men", "other.example"]);
  assert.equal(secureCookieHosts("").hosts.size, 0);
  for (const bad of ["https://jingbo.men", "*.jingbo.men", "jingbo.men:443", "jingbo.men/path", "127.0.0.1", "[::1]", "a..men", "-bad.men", "a_.men", "localhost", ","]) assert.ok(secureCookieHosts(bad).error, bad);
  for (const bad of ["jingbo.men@evil.test", "jingbo.men,evil.test", "jingbo.men:0", "jingbo.men:65536", " jingbo.men", "jingbo.men..", "https://jingbo.men"]) assert.equal(cookieHostname(bad, true), "", bad);
});
function checkCookies(r, secure) {
  assert.ok(r.setCookie.length);
  for (const c of r.setCookie) {
    assert.match(c, /; HttpOnly/);
    assert.match(c, /; SameSite=Lax/);
    assert.equal(/; Secure(?:;|$)/.test(c), secure);
    assert.doesNotMatch(c, /; Domain=/, "cookies remain host-only");
  }
}
test("configured public host: setup/login/device/logout cookies are Secure without trusting HTTPS or IP headers", async t => {
  const srv = await startServer({ env }); t.after(() => srv.stop());
  const admin = client(srv.base, { headers: { Host: "jingbo.men", "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.9", "X-Real-IP": "192.168.1.3" } });
  const setup = await admin.post("/api/setup", credentials);
  assert.equal(setup.status, 200); assert.equal(setup.setCookie.length, 2); checkCookies(setup, true);
  const h = (await admin.get("/api/health")).json.client;
  assert.equal(h.https, false); assert.equal(h.trustedPeer, false);
  assert.equal(h.peer, "127.0.0.1"); assert.equal(h.ip, h.peer); assert.equal(h.lan, false);
  const login = await admin.post("/api/login", credentials);
  assert.equal(login.status, 200); assert.equal(login.setCookie.length, 2); checkCookies(login, true);
  const logout = await admin.post("/api/logout"); checkCookies(logout, true);
  assert.match(logout.setCookie[0], /Max-Age=0/);
});
test("public cookie policy coexists with normal LAN HTTP login and logout", async t => {
  const srv = await startServer({ env }); t.after(() => srv.stop());
  const lan = client(srv.base, { headers: { Host: "192.168.50.141:8088" } });
  const s = await lan.post("/api/setup", credentials); assert.equal(s.status, 200); checkCookies(s, false);
  assert.equal((await lan.get("/api/me")).json.user.name, "admin");
  const l = await lan.post("/api/login", credentials); assert.equal(l.status, 200); checkCookies(l, false);
  checkCookies(await lan.post("/api/logout"), false);
  assert.equal((await lan.get("/api/me")).json.user, null);
});
test("host match is exact, case-insensitive and accepts an explicit port or DNS trailing dot", async t => {
  const srv = await startServer({ env }); t.after(() => srv.stop());
  await client(srv.base).post("/api/setup", credentials);
  for (const host of ["JINGBO.MEN:443", "jingbo.men.", "jingbo.men.:8443"]) {
    const r = await client(srv.base).post("/api/login", credentials, { Host: host });
    assert.equal(r.status, 200); checkCookies(r, true);
  }
});
test("unlisted/suffix hosts and spoofed forwarding headers cannot activate public policy", async t => {
  const srv = await startServer({ env }); t.after(() => srv.stop());
  await client(srv.base).post("/api/setup", credentials);
  for (const host of ["eviljingbo.men", "jingbo.men.evil.test", "sub.jingbo.men", "192.168.50.141:8088", "jingbo.men:garbage"]) {
    const r = await client(srv.base).post("/api/login", credentials, { Host: host, "X-Forwarded-Host": "jingbo.men", "X-Forwarded-Proto": "https" });
    assert.equal(r.status, 200); checkCookies(r, false);
  }
});
test("public policy only adds Secure: trusted HTTPS remains Secure on an unlisted host", async t => {
  const srv = await startServer({ env: { ...env, TRUSTED_PROXY_CIDRS: "127.0.0.1/32" } }); t.after(() => srv.stop());
  const r = await client(srv.base).post("/api/setup", credentials, { Host: "other.example", "X-Forwarded-Proto": "https" });
  assert.equal(r.status, 200); checkCookies(r, true);
});
test("a duplicate Host header cannot remove Secure from the parsed public Host", async t => {
  const srv = await startServer({ env }); t.after(() => srv.stop());
  const r = await client(srv.base).post("/api/setup", credentials, { Host: ["jingbo.men", "other.example"] });
  assert.equal(r.status, 200); checkCookies(r, true);
});
test("public Host cannot defeat the per-peer login limiter with forged client IPs", async t => {
  const srv = await startServer({ env }); t.after(() => srv.stop());
  await client(srv.base).post("/api/setup", credentials);
  for (let i = 0; i < 7; i++) {
    const r = await client(srv.base).post("/api/login", { ...credentials, password: "incorrect" }, { Host: "jingbo.men", "X-Forwarded-For": "203.0.113." + i, "X-Forwarded-Proto": "https" });
    assert.equal(r.status, i < 5 ? 401 : 429);
  }
});
test("invalid cookie host configuration exits before writing data or opening the listener", { timeout: 15000 }, async () => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { spawn } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-cookie-host-"));
  try {
    const child = spawn(process.execPath, [path.join(__dirname, "../server.js")], { env: { ...process.env, DATA_DIR: dir, NOCTURNE_SECURE_COOKIE_HOSTS: "*.jingbo.men" }, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; child.stdout.on("data", b => log += b); child.stderr.on("data", b => log += b);
    const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(exit, 2); assert.match(log, /配置错误：NOCTURNE_SECURE_COOKIE_HOSTS/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
