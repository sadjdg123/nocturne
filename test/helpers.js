"use strict";
/* 测试工具：用临时 DATA_DIR 启动一个独立的 server.js 子进程，带 cookie 的请求客户端，本地模拟服务。只用 Node 内置模块。 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 启动服务器。opts.env 额外环境变量；opts.seed(dataDir) 在启动前往 DATA_DIR 里放文件；
 *  opts.port 固定端口（模拟原地升级：同一地址换一个版本）；opts.root 用另一份代码目录里的 server.js（回滚测试：V1.1 基线）；opts.dataDir 复用已有的数据目录（stop 时不删） */
async function startServer(opts = {}) {
  const port = opts.port || await freePort();
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-test-"));
  if (opts.seed) await opts.seed(dataDir);
  const env = Object.assign({}, process.env, { PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, STATUS_INTERVAL: "3600", TZ: "UTC", DOCKER_SOCK: path.join(dataDir, "no-docker.sock") }, opts.env || {});
  for (const k of ["TRUSTED_PROXY_CIDRS", "PROBE_ALLOW", "NOCTURNE_NO_AUTH"]) if (!opts.env || !(k in opts.env)) delete env[k];
  const child = spawn(process.execPath, [path.join(opts.root || ROOT, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + "/api/health"); if (r.ok) break; } catch (e) { /* not yet */ }
    if (child.exitCode != null) throw new Error("server exited: " + out);
    await sleep(50);
  }
  return {
    base, port, dataDir, child,
    log: () => out,
    async stop() {
      if (child.exitCode == null && child.signalCode == null) { child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r)); }
      if (!opts.dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** 带 cookie 的客户端（模拟一台设备） */
function client(base, defaults = {}) {
  const jar = new Map();
  async function req(method, p, body, headers = {}) {
    const h = Object.assign({}, defaults.headers || {}, headers);
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => k + "=" + v).join("; ");
    let payload;
    if (body !== undefined) {
      if (Buffer.isBuffer(body)) payload = body;
      else { payload = JSON.stringify(body); h["Content-Type"] = h["Content-Type"] || "application/json"; }
    }
    const r = await fetch(base + p, { method, headers: h, body: payload, redirect: "manual" });
    const setc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of setc) {
      const [kv] = c.split(";"), i = kv.indexOf("=");
      const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
      if (!v || /Max-Age=0\b/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString("utf8")); } catch (e) { /* not json */ }
    return { status: r.status, headers: r.headers, setCookie: setc, body: buf, json };
  }
  return {
    jar, req,
    get: (p, h) => req("GET", p, undefined, h),
    post: (p, b, h) => req("POST", p, b === undefined ? {} : b, h),
    put: (p, b, h) => req("PUT", p, b, h),
    del: (p, h) => req("DELETE", p, undefined, h),
  };
}

/** 本地模拟 HTTP 服务：handler(req, res)；返回 {port, hits: [url…], close()} */
async function mockServer(handler) {
  const hits = [];
  const srv = http.createServer((q, s) => { hits.push(q.url); handler(q, s); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, hits, close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); }) };
}

function cfg(title, items, extra) {
  return Object.assign({ settings: { title: title || "夜曲" }, groups: [{ id: "g1", name: "组", style: "icon", items: items || [] }] }, extra || {});
}
async function waitFor(fn, ms = 6000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(step);
  }
}

/** 旧配置夹具必须配套合法账户，不能通过在孤立配置上重新 setup 冒充已安装站点。 */
function seedAccount(dataDir, name = "admin", password = "admin-pass-1") {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  fs.writeFileSync(path.join(dataDir, "users.json"), JSON.stringify({ users: [{ name, admin: true, hash: "scrypt$" + salt.toString("base64") + "$" + key.toString("base64") }] }));
}

module.exports = { seedAccount, startServer, client, mockServer, freePort, sleep, cfg, waitFor, ROOT };
