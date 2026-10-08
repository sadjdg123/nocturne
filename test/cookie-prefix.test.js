"use strict";
/* V2.0 RC.2 · P-1：cookie 名前缀可配置（NOCTURNE_COOKIE_PREFIX → <前缀>sid / <前缀>dev），默认仍是 nocturne_sid / nocturne_dev。
 * 浏览器的 cookie 按主机名存、不分端口：这里用「按主机名分桶」的 cookie 罐模拟同一浏览器打开同一主机名的两个端口。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { startServer, freePort } = require("./helpers");
const S = require("../server.js");

/** 像浏览器一样：cookie 只按主机名（不含端口）存 */
function browser() {
  const jars = new Map(); // host -> Map(name -> value)
  async function req(base, method, p, body) {
    const u = new URL(base + p), jar = jars.get(u.hostname) || new Map();
    jars.set(u.hostname, jar);
    const h = {};
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => k + "=" + v).join("; ");
    if (body !== undefined) h["Content-Type"] = "application/json";
    const r = await fetch(u, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const setc = r.headers.getSetCookie();
    for (const c of setc) {
      const [kv] = c.split(";"), i = kv.indexOf("="), k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
      if (!v || /Max-Age=0\b/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    let json = null; try { json = await r.json(); } catch (e) { /* not json */ }
    return { status: r.status, setCookie: setc, json };
  }
  return { jars, req, me: async (base) => ((await req(base, "GET", "/api/me")).json || {}).user };
}
const names = (setc) => setc.map((c) => c.split("=")[0]).sort();

test("cookieNames：默认 / 合法前缀 / 不合法前缀", () => {
  assert.deepEqual(S.cookieNames(undefined), { prefix: "nocturne_", sid: "nocturne_sid", dev: "nocturne_dev" });
  assert.deepEqual(S.cookieNames(""), S.cookieNames(undefined), "空值 = 默认（compose 里写了 NOCTURNE_COOKIE_PREFIX= 也一样）");
  assert.deepEqual(S.cookieNames("  "), S.cookieNames(undefined));
  assert.deepEqual(S.cookieNames("nocturne_v2test_"), { prefix: "nocturne_v2test_", sid: "nocturne_v2test_sid", dev: "nocturne_v2test_dev" });
  assert.equal(S.cookieNames("nas2-").sid, "nas2-sid");
  assert.equal(S.cookieNames("a.b").dev, "a.bdev");
  for (const bad of ["__Host-", "__host-x_", "__Secure-n_", "_x", "-x", "x y", "x;y", "x=y", "名字", "x\"", "a".repeat(33), "x,y"]) {
    assert.ok(S.cookieNames(bad).error, "应拒绝：" + JSON.stringify(bad));
  }
  assert.match(S.cookieNames("__Host-").error, /__Host-/);
});

test("默认 cookie 名不变：nocturne_sid / nocturne_dev，HttpOnly / SameSite=Lax，HTTP 下没有 Secure；退出登录清的是同一个名字", { timeout: 30000 }, async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const b = browser();
  const r = await b.req(srv.base, "POST", "/api/setup", { name: "admin", password: "admin-pass-1" });
  assert.equal(r.status, 200);
  assert.deepEqual(names(r.setCookie), ["nocturne_dev", "nocturne_sid"]);
  for (const c of r.setCookie) { assert.match(c, /; HttpOnly/); assert.match(c, /; SameSite=Lax/); assert.match(c, /; Path=\//); assert.doesNotMatch(c, /Secure/); }
  assert.match(srv.log(), /cookies=nocturne_sid\/nocturne_dev/);
  const out = await b.req(srv.base, "POST", "/api/logout");
  assert.deepEqual(names(out.setCookie), ["nocturne_sid"]); assert.match(out.setCookie[0], /Max-Age=0/);
  assert.equal(await b.me(srv.base), null);
});

test("同一主机名、不同端口、不同前缀：两个实例的登录 / 已知设备互不覆盖，退出其中一个不影响另一个", { timeout: 30000 }, async (t) => {
  const prod = await startServer(); // 默认前缀
  const v2t = await startServer({ env: { NOCTURNE_COOKIE_PREFIX: "nocturne_v2test_" } });
  t.after(() => Promise.all([prod.stop(), v2t.stop()]));
  const b = browser();
  assert.equal((await b.req(prod.base, "POST", "/api/setup", { name: "prod", password: "prod-pass-1" })).status, 200);
  const r = await b.req(v2t.base, "POST", "/api/setup", { name: "tester", password: "test-pass-1" });
  assert.deepEqual(names(r.setCookie), ["nocturne_v2test_dev", "nocturne_v2test_sid"]);
  assert.match(v2t.log(), /cookies=nocturne_v2test_sid\/nocturne_v2test_dev/);
  assert.deepEqual([...b.jars.keys()], ["127.0.0.1"], "一个主机名一个罐（不分端口）");
  assert.deepEqual([...b.jars.get("127.0.0.1").keys()].sort(), ["nocturne_dev", "nocturne_sid", "nocturne_v2test_dev", "nocturne_v2test_sid"]);
  assert.equal((await b.me(prod.base)).name, "prod", "生产实例的登录还在");
  assert.equal((await b.me(v2t.base)).name, "tester");
  // 已知设备 cookie 也各是各的：生产实例的 users.json 里记的是 nocturne_dev 的哈希
  const crypto = require("node:crypto");
  const devHash = (v) => crypto.createHash("sha256").update(v).digest("hex");
  const pu = JSON.parse(fs.readFileSync(path.join(prod.dataDir, "users.json"), "utf8")).users[0];
  const tu = JSON.parse(fs.readFileSync(path.join(v2t.dataDir, "users.json"), "utf8")).users[0];
  assert.equal(pu.devices[0].h, devHash(b.jars.get("127.0.0.1").get("nocturne_dev")));
  assert.equal(tu.devices[0].h, devHash(b.jars.get("127.0.0.1").get("nocturne_v2test_dev")));
  // 退出测试实例：只清它自己的 cookie
  const out = await b.req(v2t.base, "POST", "/api/logout");
  assert.deepEqual(names(out.setCookie), ["nocturne_v2test_sid"]);
  assert.equal(await b.me(v2t.base), null);
  assert.equal((await b.me(prod.base)).name, "prod", "生产实例不受影响");
});

test("对照：同一主机名、两个实例都用默认前缀 → 后登录的覆盖先登录的（RC.1 的现象）", { timeout: 30000 }, async (t) => {
  const a = await startServer(), c = await startServer();
  t.after(() => Promise.all([a.stop(), c.stop()]));
  const b = browser();
  await b.req(a.base, "POST", "/api/setup", { name: "prod", password: "prod-pass-1" });
  await b.req(c.base, "POST", "/api/setup", { name: "tester", password: "test-pass-1" });
  assert.equal(await b.me(a.base), null, "第一个实例的会话 cookie 被覆盖");
});

for (const bad of ["__Host-nocturne_", "bad prefix", "a;b", "-x"]) {
  test("不合法的 NOCTURNE_COOKIE_PREFIX=" + JSON.stringify(bad) + "：启动时报清楚的错误并退出（退出码 2），不监听端口", { timeout: 15000 }, async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-cookie-"));
    try {
      const port = await freePort();
      const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: Object.assign({}, process.env, { PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, NOCTURNE_COOKIE_PREFIX: bad }), stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; child.stdout.on("data", (x) => { out += x; }); child.stderr.on("data", (x) => { out += x; });
      const code = await new Promise((r) => child.once("exit", r));
      assert.equal(code, 2, out);
      assert.match(out, /配置错误：NOCTURNE_COOKIE_PREFIX/);
      assert.equal(fs.readdirSync(dataDir).length, 0, "没有写任何数据");
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
}
