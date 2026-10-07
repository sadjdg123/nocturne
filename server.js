#!/usr/bin/env node
/*
 * 夜曲 Nocturne · 自托管起始页后端
 * 零依赖：仅使用 Node.js 22 内置模块（http / https / crypto / fs / zlib）。
 */
"use strict";

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const dns = require("node:dns");
const net = require("node:net");
const os = require("node:os");

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || "/data");
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, "public"));
const NO_AUTH = /^(1|true|yes)$/i.test(process.env.NOCTURNE_NO_AUTH || "");
const STATUS_INTERVAL = Math.max(10, +process.env.STATUS_INTERVAL || 30) * 1000;
const PROBE_TIMEOUT = Math.max(1, +process.env.PROBE_TIMEOUT || 4) * 1000;
const SESSION_DAYS = Math.max(1, +process.env.SESSION_DAYS || 30);
const DOCKER_SOCK = process.env.DOCKER_SOCK || "/var/run/docker.sock";
const flag = (v) => /^(1|true|yes|on)$/i.test(v || "");
const PROBE_PRIVATE_ONLY = flag(process.env.PROBE_PRIVATE_ONLY); // 只探测内网地址
const PROBE_TLS_STRICT = flag(process.env.PROBE_TLS_STRICT); // 校验 HTTPS 证书（默认不校验：自签名也算在线）
const ICON_UPSTREAM = "https://api.iconify.design/";
const VERSION = require("./package.json").version;
const MAX_BODY = 1024 * 1024; // JSON 请求（配置等）上限；壁纸走 /api/wallpaper 单独存文件
const MAX_WALLPAPER = 15 * 1024 * 1024;
const NO_AUTH_USER = "default";

const CONFIG_DIR = path.join(DATA_DIR, "config");
const CACHE_DIR = path.join(DATA_DIR, "cache");
const WALLPAPER_DIR = path.join(DATA_DIR, "wallpapers");
const BACKUP_DIR = path.join(DATA_DIR, "backup"); // 被另一台设备覆盖前的那一版配置
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------------------------------------------ storage */

function ensureDirs() {
  for (const d of [DATA_DIR, CONFIG_DIR, CACHE_DIR, WALLPAPER_DIR, BACKUP_DIR]) fs.mkdirSync(d, { recursive: true });
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
/** 原子写入：先写临时文件，再 rename 覆盖。按文件串行，避免并发写交错。 */
const writeQueues = new Map();
function writeJSON(file, data) {
  const body = JSON.stringify(data, null, 2);
  const prev = writeQueues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const tmp = file + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    const fh = await fsp.open(tmp, "w", 0o600);
    try { await fh.writeFile(body); await fh.sync(); } finally { await fh.close(); }
    await fsp.rename(tmp, file);
  });
  writeQueues.set(file, next);
  next.finally(() => { if (writeQueues.get(file) === next) writeQueues.delete(file); }).catch(() => {});
  return next;
}

/* -------------------------------------------------------------------- users */

let users = { users: [] };
let sessions = {};

function loadState() {
  users = readJSON(USERS_FILE, { users: [] });
  if (!Array.isArray(users.users)) users.users = [];
  sessions = readJSON(SESSIONS_FILE, {});
  const now = Date.now();
  for (const [k, s] of Object.entries(sessions)) if (!s || s.expires < now) delete sessions[k];
}
const saveUsers = () => writeJSON(USERS_FILE, users);
let sessTimer = null;
function saveSessions(now) {
  clearTimeout(sessTimer);
  if (now) return writeJSON(SESSIONS_FILE, sessions);
  sessTimer = setTimeout(() => writeJSON(SESSIONS_FILE, sessions).catch((e) => log("save sessions", e.message)), 2000);
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
function validName(n) { return typeof n === "string" && NAME_RE.test(n) && !/\.\./.test(n); }
function validPass(p) { return typeof p === "string" && p.length >= 6 && p.length <= 200; }
function findUser(name) {
  const l = String(name || "").toLowerCase();
  return users.users.find((u) => u.name.toLowerCase() === l);
}

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  return new Promise((res, rej) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 64, SCRYPT, (err, key) => err ? rej(err) : res("scrypt$" + salt.toString("base64") + "$" + key.toString("base64")));
  });
}
function verifyPassword(pw, stored) {
  return new Promise((res) => {
    const [alg, s, h] = String(stored || "").split("$");
    if (alg !== "scrypt" || !s || !h) return res(false);
    const want = Buffer.from(h, "base64");
    crypto.scrypt(String(pw), Buffer.from(s, "base64"), want.length, SCRYPT, (err, key) => {
      res(!err && key.length === want.length && crypto.timingSafeEqual(key, want));
    });
  });
}
const DUMMY_HASH = "scrypt$" + Buffer.alloc(16).toString("base64") + "$" + Buffer.alloc(64).toString("base64");

/* ----------------------------------------------------------------- sessions */

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
function newSession(name) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions[sha(token)] = { user: name, created: Date.now(), expires: Date.now() + SESSION_DAYS * 864e5 };
  saveSessions();
  return token;
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const COOKIE = "nocturne_sid";
function isHttps(req) {
  return !!req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() === "https";
}
function setCookie(req, res, token, maxAge) {
  const parts = [COOKIE + "=" + (token || ""), "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=" + (maxAge == null ? SESSION_DAYS * 86400 : maxAge)];
  if (isHttps(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}
/** 返回当前登录用户 {name, admin}，未登录返回 null */
function currentUser(req) {
  if (NO_AUTH) return { name: NO_AUTH_USER, admin: true };
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const key = sha(t), s = sessions[key];
  if (!s) return null;
  if (s.expires < Date.now()) { delete sessions[key]; saveSessions(); return null; }
  const u = findUser(s.user);
  if (!u) { delete sessions[key]; saveSessions(); return null; }
  // 滑动续期：剩余不足一半时延长
  if (s.expires - Date.now() < SESSION_DAYS * 432e5) { s.expires = Date.now() + SESSION_DAYS * 864e5; saveSessions(); }
  req.sessionKey = key;
  return { name: u.name, admin: !!u.admin };
}
function dropSessionsOf(name, exceptKey) {
  const l = name.toLowerCase();
  for (const [k, s] of Object.entries(sessions)) if (s.user.toLowerCase() === l && k !== exceptKey) delete sessions[k];
  return saveSessions(true);
}

/* ------------------------------------------------------------- rate limiting */

const PRIVATE_IP = /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc|fd|::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i;
function clientIp(req) {
  const ra = req.socket.remoteAddress || "";
  // 只有来自内网（如群晖反向代理、Lucky）的连接才信任 X-Forwarded-For / X-Real-IP
  if (PRIVATE_IP.test(ra)) {
    const xr = String(req.headers["x-real-ip"] || "").trim();
    const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xf || xr) return xf || xr;
  }
  return ra;
}
const fails = new Map(); // ip -> [timestamps]
const FAIL_WINDOW = 10 * 60 * 1000, FAIL_MAX = 5;
function failsOf(ip) {
  const now = Date.now(), list = (fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW);
  if (list.length) fails.set(ip, list); else fails.delete(ip);
  return list;
}
setInterval(() => { for (const ip of fails.keys()) failsOf(ip); }, 60000).unref();

/* ------------------------------------------------------------------ configs */

const configFile = (name) => path.join(CONFIG_DIR, name.toLowerCase() + ".json");
const backupFile = (name) => path.join(BACKUP_DIR, name.toLowerCase() + ".json");
const configCache = new Map(); // lname -> {mtimeMs, doc}
function readConfig(name) {
  const f = configFile(name);
  let st; try { st = fs.statSync(f); } catch (e) { return { version: 0, updatedAt: null, data: null }; }
  const c = configCache.get(f);
  if (c && c.mtimeMs === st.mtimeMs) return c.doc;
  const doc = readJSON(f, { version: 0, updatedAt: null, data: null });
  configCache.set(f, { mtimeMs: st.mtimeMs, doc });
  return doc;
}
async function writeConfig(name, data) {
  const cur = readConfig(name);
  const doc = { version: (cur.version || 0) + 1, updatedAt: new Date().toISOString(), data };
  await writeJSON(configFile(name), doc);
  configCache.delete(configFile(name));
  return doc;
}
function validConfig(d) {
  return d && typeof d === "object" && !Array.isArray(d) && d.settings && typeof d.settings === "object" && Array.isArray(d.groups) &&
    d.groups.every((g) => g && typeof g === "object" && (g.items == null || Array.isArray(g.items)));
}
function allUserNames() {
  return NO_AUTH ? [NO_AUTH_USER, ...users.users.map((u) => u.name)] : users.users.map((u) => u.name);
}

/* --------------------------------------------------------------- wallpapers */

/** 自定义壁纸存成文件 /data/wallpapers/<user>.<ext>，配置里只记 {id:"custom", file:true, v} */
const WP_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}
const wallpaperBase = (name) => path.join(WALLPAPER_DIR, name.toLowerCase());
function findWallpaper(name) {
  for (const ext of Object.keys(WP_TYPES)) {
    const f = wallpaperBase(name) + "." + ext;
    try { const st = fs.statSync(f); if (st.isFile()) return { file: f, ext, st }; } catch (e) { /* next */ }
  }
  return null;
}
async function storeWallpaper(name, buf) {
  const ext = sniffImage(buf);
  if (!ext) throw Object.assign(new Error("只支持 JPEG / PNG / WebP 图片"), { status: 415 });
  const file = wallpaperBase(name) + "." + ext;
  const tmp = file + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  const fh = await fsp.open(tmp, "w", 0o600);
  try { await fh.writeFile(buf); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(tmp, file);
  for (const e of Object.keys(WP_TYPES)) if (e !== ext) await fsp.rm(wallpaperBase(name) + "." + e, { force: true });
  return ext;
}
async function removeWallpaper(name) {
  for (const e of Object.keys(WP_TYPES)) await fsp.rm(wallpaperBase(name) + "." + e, { force: true });
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const tooBig = () => Object.assign(new Error("图片太大（上限 " + Math.round(limit / 1048576) + "MB）"), { status: 413, close: true });
    if (+req.headers["content-length"] > limit) return reject(tooBig());
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(tooBig()); req.removeAllListeners("data"); req.resume(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
/** 旧版把壁纸以 data URL 存在配置里：解码落盘，改写成文件引用。返回是否改动了 data。 */
async function migrateWallpaper(name, data) {
  const w = data && data.settings && data.settings.wallpaper;
  if (!w || typeof w.url !== "string" || !w.url.startsWith("data:")) return false;
  const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(w.url);
  let ok = false;
  if (m) {
    try { await storeWallpaper(name, Buffer.from(m[1], "base64")); ok = true; } catch (e) { log("wallpaper migrate", name, e.message); }
  }
  data.settings.wallpaper = Object.assign({}, w, ok ? { id: "custom", file: true, v: Date.now(), url: "" } : { id: "star", url: "" });
  if (!ok) delete data.settings.wallpaper.file;
  log("wallpaper migrated from data URL", name, ok ? "ok" : "dropped (unreadable)");
  return true;
}
async function migrateAllWallpapers() {
  for (const name of allUserNames()) {
    const cur = readConfig(name);
    if (cur.data && await migrateWallpaper(name, cur.data)) await writeConfig(name, cur.data);
  }
}

/* ------------------------------------------------------------------- status */

const RESERVED = /(^|\.)(example\.(com|net|org)|example|test|invalid)$/i;
/** 与前端一致：优先内网地址，回退 url / 外网地址 */
function probeTarget(item) {
  for (const u of [item.lan, item.url, item.wan]) {
    if (!u || typeof u !== "string") continue;
    try {
      const p = new URL(u);
      if (!/^https?:$/.test(p.protocol)) continue;
      if (RESERVED.test(p.hostname)) return { url: u, reserved: true };
      return { url: p.href };
    } catch (e) { /* skip */ }
  }
  return null;
}
function itemsOf(doc) {
  const out = [];
  for (const g of (doc && doc.data && doc.data.groups) || []) for (const it of g.items || []) if (it && it.id) out.push(it);
  return out;
}

/* 探测安全边界（服务端代为请求 = 受控 SSRF，所以要设限）：
 *  - 永远拦截：链路本地 169.254.0.0/16、fe80::/10（含云厂商元数据 169.254.169.254）、元数据主机名、0.0.0.0/8 与 ::、
 *    以及本机 Nocturne 自己的端口（回环 / 本机网卡地址）
 *  - 主机名先 DNS 解析，所有解析结果都要过检查；实际连接只用检查过的地址（防 DNS rebinding）
 *  - PROBE_PRIVATE_ONLY=1：只允许内网（RFC1918 / CGNAT 100.64/10 / ULA fc00::/7 / 回环）；.local/.lan/.home.arpa 也要解析到内网才放行 */
function blockList(v4, v6) {
  const b = new net.BlockList();
  for (const [a, n] of v4) b.addSubnet(a, n, "ipv4");
  for (const [a, n] of v6) b.addSubnet(a, n, "ipv6");
  return b;
}
const ALWAYS_BLOCK = blockList([["169.254.0.0", 16], ["0.0.0.0", 8], ["100.100.100.200", 32]], [["fe80::", 10], ["::", 128], ["fd00:ec2::254", 128]]);
const LOOPBACK = blockList([["127.0.0.0", 8]], [["::1", 128]]);
const PRIVATE_NET = blockList([["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["127.0.0.0", 8]], [["fc00::", 7], ["::1", 128]]);
const METADATA_HOST = /^(metadata\.google\.internal|metadata\.goog|metadata|instance-data(\.ec2\.internal)?|metadata\.azure\.com)\.?$/i;
function normIp(a) { // IPv4-mapped IPv6（::ffff:1.2.3.4 / ::ffff:102:304）→ IPv4
  let m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (m) return m[1];
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(a);
  if (m) { const h = parseInt(m[1], 16), l = parseInt(m[2], 16); return [h >> 8, h & 255, l >> 8, l & 255].join("."); }
  return a;
}
function selfAddrs() {
  const s = new Set();
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) s.add(normIp(i.address));
  return s;
}
/** 返回 {address, family} 或 {blocked: 原因} */
async function vetTarget(u) {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (METADATA_HOST.test(host)) return { blocked: "metadata host" };
  const port = +u.port || (u.protocol === "https:" ? 443 : 80);
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
  else {
    try { addrs = await dns.promises.lookup(host, { all: true, verbatim: true }); }
    catch (e) { return { error: e.code || "dns error" }; }
    if (!addrs.length) return { error: "ENOTFOUND" };
  }
  const mine = selfAddrs();
  for (const a of addrs) {
    const ip = normIp(a.address), type = net.isIP(ip) === 6 ? "ipv6" : "ipv4";
    if (ALWAYS_BLOCK.check(ip, type)) return { blocked: "link-local / metadata / unspecified address (" + ip + ")" };
    if (port === PORT && (LOOPBACK.check(ip, type) || mine.has(ip))) return { blocked: "Nocturne itself (" + ip + ":" + port + ")" };
    if (PROBE_PRIVATE_ONLY && !PRIVATE_NET.check(ip, type)) return { blocked: "not a private address (" + ip + "), PROBE_PRIVATE_ONLY=1" };
  }
  const a = addrs[0], ip = normIp(a.address);
  return { address: ip, family: net.isIP(ip) };
}

const results = new Map(); // url -> {up, ms, checkedAt, code, error, blocked}
const blockedLogged = new Set();
let docker = { available: false, containers: [], checkedAt: null, error: null };

function probe(url) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let done = false, req = null;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(Object.assign(r, { checkedAt: new Date().toISOString() })); };
    const timer = setTimeout(() => { if (req) req.destroy(new Error("timeout")); finish({ up: false, ms: null, error: "timeout" }); }, PROBE_TIMEOUT);
    let u; try { u = new URL(url); } catch (e) { return finish({ up: false, ms: null, error: "bad url" }); }
    vetTarget(u).then((v) => {
      if (done) return;
      if (v.blocked) { if (!blockedLogged.has(u.host)) { blockedLogged.add(u.host); log("probe blocked", u.host, v.blocked); } return finish({ up: false, ms: null, blocked: true, error: "blocked: " + v.blocked }); }
      if (v.error) return finish({ up: false, ms: null, error: v.error });
      const mod = u.protocol === "https:" ? https : http;
      req = mod.request(u, {
        method: "GET",
        rejectUnauthorized: PROBE_TLS_STRICT, // 默认 false：家里的自签名证书也算在线
        // 只连接上面检查过的地址（不再二次解析，防 DNS rebinding）；Host / SNI 仍是原主机名
        lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: v.address, family: v.family }]) : cb(null, v.address, v.family)),
        headers: { "User-Agent": "Nocturne-StatusProbe/" + VERSION, Accept: "*/*", Connection: "close" },
      }, (res) => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const code = res.statusCode || 0;
        res.destroy();
        finish({ up: code > 0 && code < 500, ms: Math.round(ms), code });
      });
      req.on("error", (e) => finish({ up: false, ms: null, error: e.code || e.message }));
      req.end();
    }, (e) => finish({ up: false, ms: null, error: e.message }));
  });
}

function dockerRequest(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCK, path: p, method: "GET", headers: { Host: "docker" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("docker http " + res.statusCode));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(4000, () => req.destroy(new Error("docker timeout")));
    req.on("error", reject);
    req.end();
  });
}
async function refreshDocker() {
  let st; try { st = fs.statSync(DOCKER_SOCK); } catch (e) { docker = { available: false, containers: [], checkedAt: new Date().toISOString(), error: null }; return; }
  if (!st.isSocket()) { docker = { available: false, containers: [], checkedAt: new Date().toISOString(), error: "not a socket" }; return; }
  try {
    const list = await dockerRequest("/containers/json?all=1");
    docker = {
      available: true,
      checkedAt: new Date().toISOString(),
      error: null,
      containers: list.map((c) => ({
        name: String((c.Names && c.Names[0]) || c.Id.slice(0, 12)).replace(/^\//, ""),
        state: c.State, status: c.Status, image: c.Image,
      })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  } catch (e) {
    docker = { available: false, containers: [], checkedAt: new Date().toISOString(), error: e.code === "EACCES" ? "没有读取 docker.sock 的权限" : e.message };
  }
}

let probing = null;
async function runProbes(onlyNew) {
  if (probing) return probing;
  probing = (async () => {
    await refreshDocker().catch(() => {});
    const urls = new Set();
    for (const name of allUserNames()) for (const it of itemsOf(readConfig(name))) {
      const t = probeTarget(it);
      if (t && !t.reserved && (!onlyNew || !results.has(t.url))) urls.add(t.url);
    }
    const queue = [...urls];
    const worker = async () => { while (queue.length) { const u = queue.shift(); results.set(u, await probe(u)); } };
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
    if (!onlyNew) { // 清理已不存在的地址
      for (const u of results.keys()) if (!urls.has(u)) results.delete(u);
    }
  })().catch((e) => log("probe loop", e.message)).finally(() => { probing = null; });
  return probing;
}
let soonTimer = null;
function probeSoon() { clearTimeout(soonTimer); soonTimer = setTimeout(() => runProbes(true), 800); }

function statusFor(name) {
  const out = {}, byName = new Map(docker.containers.map((c) => [c.name.toLowerCase(), c]));
  for (const it of itemsOf(readConfig(name))) {
    const t = probeTarget(it);
    let r = null;
    if (t && t.reserved) r = { up: false, ms: null, checkedAt: null, via: "http", error: "reserved domain" };
    else if (t && results.has(t.url)) r = Object.assign({ via: "http" }, results.get(t.url));
    const c = it.container && docker.available ? byName.get(String(it.container).toLowerCase()) : null;
    // HTTP 探测不可用（没有地址 / 网络错误）时，用关联容器的运行状态
    if (c && (!r || (!r.up && !r.code))) r = { up: c.state === "running", ms: null, checkedAt: docker.checkedAt, via: "docker", state: c.state, status: c.status };
    // code：HTTP 状态码；401/403 说明服务在线、只是需要登录（auth:true），前端单独显示
    if (r) out[it.id] = { up: r.up, ms: r.ms, checkedAt: r.checkedAt, via: r.via, status: r.blocked ? "blocked" : r.up ? (r.code === 401 || r.code === 403 ? "auth" : "up") : "down",
      ...(r.code ? { code: r.code } : {}), ...(r.code === 401 || r.code === 403 ? { auth: true } : {}), ...(r.state ? { state: r.state } : {}), ...(r.error ? { error: r.error } : {}) };
  }
  return out;
}

/* ------------------------------------------------------------------ helpers */

function send(res, code, body, headers) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(code, Object.assign({ "Content-Length": buf.length }, headers || {}));
  res.end(res.req.method === "HEAD" ? undefined : buf);
}
function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers["content-type"] || "");
    // 只接受 JSON：跨站表单无法伪造（需 CORS 预检），配合 SameSite=Lax 防 CSRF
    if (!/^application\/json\b/i.test(ct)) return reject(Object.assign(new Error("需要 application/json"), { status: 415 }));
    const tooBig = () => Object.assign(new Error("请求体过大"), { status: 413, close: true });
    if (+req.headers["content-length"] > MAX_BODY) return reject(tooBig());
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(tooBig()); req.removeAllListeners("data"); req.resume(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(Object.assign(new Error("JSON 格式错误"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

/* ------------------------------------------------------------------- static */

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest)|image\/svg)/;
const staticCache = new Map(); // file -> {mtimeMs, buf, gz, etag}

function acceptsGzip(req) { return /\bgzip\b/.test(String(req.headers["accept-encoding"] || "")); }

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return send(res, 400, "Bad Request"); }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "Forbidden");
  if (path.basename(file) === "index.html") return serveIndex(req, res);
  let st; try { st = fs.statSync(file); } catch (e) { return send(res, 404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" }); }
  if (!st.isFile()) return send(res, 404, "Not Found");
  let c = staticCache.get(file);
  if (!c || c.mtimeMs !== st.mtimeMs) {
    const buf = fs.readFileSync(file), type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    c = { mtimeMs: st.mtimeMs, buf, type, etag: '"' + sha(buf).slice(0, 20) + '"', gz: COMPRESSIBLE.test(type) && buf.length > 1024 ? zlib.gzipSync(buf, { level: 9 }) : null };
    staticCache.set(file, c);
  }
  const headers = {
    "Content-Type": c.type, ETag: c.etag, "Last-Modified": new Date(st.mtimeMs).toUTCString(), Vary: "Accept-Encoding",
    "Cache-Control": /\/fonts\//.test(file) ? "public, max-age=31536000, immutable" : "public, max-age=86400, must-revalidate",
  };
  if (req.headers["if-none-match"] === c.etag) { res.writeHead(304, headers); return res.end(); }
  if (c.gz && acceptsGzip(req)) return send(res, 200, c.gz, Object.assign(headers, { "Content-Encoding": "gzip" }));
  send(res, 200, c.buf, headers);
}

let indexCache = null;
function serveIndex(req, res) {
  const file = path.join(PUBLIC_DIR, "index.html"), st = fs.statSync(file);
  if (!indexCache || indexCache.mtimeMs !== st.mtimeMs) indexCache = { mtimeMs: st.mtimeMs, html: fs.readFileSync(file, "utf8") };
  const u = currentUser(req);
  const boot = {
    backend: true, version: u ? readConfig(u.name).version || 0 : 0,
    auth: !NO_AUTH, setup: !NO_AUTH && users.users.length === 0, user: u, app: VERSION,
  };
  const tag = "<script>window.NOCTURNE=" + JSON.stringify(boot).replace(/</g, "\\u003c") + ";</script>";
  const html = Buffer.from(indexCache.html.replace("<!--nocturne:boot-->", tag));
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Vary: "Cookie, Accept-Encoding", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
    // 不允许被别的网站嵌进 iframe（点击劫持）；用不到的浏览器能力一律关掉。内联脚本较多，暂不启用 CSP。
    "X-Frame-Options": "DENY", "Permissions-Policy": "camera=(), microphone=(), geolocation=()" };
  if (acceptsGzip(req)) return send(res, 200, zlib.gzipSync(html, { level: 6 }), Object.assign(headers, { "Content-Encoding": "gzip" }));
  send(res, 200, html, headers);
}

/* --------------------------------------------------------------- icon proxy */

const ICON_SVG = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\.svg$/i;
const ICON_SEARCH = /^search$/;
const iconInflight = new Map();
function fetchUpstream(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Nocturne/" + VERSION, Accept: "*/*", "Accept-Encoding": "identity" } }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > 2 * 1024 * 1024) req.destroy(new Error("too large")); else chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] || "", body: Buffer.concat(chunks) }));
    });
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}
async function serveIcon(req, res, rest, search) {
  if (!(ICON_SVG.test(rest) || (ICON_SEARCH.test(rest) && search))) return json(res, 400, { error: "不支持的图标请求" });
  const key = rest + (search || "");
  const isSvg = rest.endsWith(".svg");
  const ttl = isSvg ? 30 * 864e5 : 864e5;
  const base = path.join(CACHE_DIR, "icon-" + sha(key).slice(0, 40));
  const out = (status, type, body, hit) => send(res, status, body, {
    "Content-Type": type, "Cache-Control": status === 200 ? (isSvg ? "public, max-age=604800" : "public, max-age=3600") : "public, max-age=600",
    "X-Cache": hit ? "HIT" : "MISS", "X-Content-Type-Options": "nosniff",
    ...(isSvg ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } : {}),
  });
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(base + ".json", "utf8")); } catch (e) { /* miss */ }
  if (meta && Date.now() - meta.t < (meta.status === 200 ? ttl : 864e5)) {
    try { return out(meta.status, meta.type, fs.readFileSync(base + ".bin"), true); } catch (e) { /* fall through */ }
  }
  let p = iconInflight.get(key);
  if (!p) {
    p = fetchUpstream(ICON_UPSTREAM + rest + (search || "")).finally(() => iconInflight.delete(key));
    iconInflight.set(key, p);
  }
  try {
    const r = await p;
    const status = r.status === 200 ? 200 : 404;
    const type = status === 200 ? (isSvg ? "image/svg+xml" : r.type || "application/json") : "text/plain; charset=utf-8";
    const body = status === 200 ? r.body : Buffer.from("not found");
    if (r.status === 200 || r.status === 404) { // 只缓存确定的结果
      fs.writeFileSync(base + ".bin", body);
      fs.writeFileSync(base + ".json", JSON.stringify({ t: Date.now(), status, type, key }));
    }
    out(status, type, body, false);
  } catch (e) {
    if (meta) { try { return out(meta.status, meta.type, fs.readFileSync(base + ".bin"), true); } catch (x) { /* none */ } }
    json(res, 502, { error: "图标服务暂时连不上" });
  }
}

/* ---------------------------------------------------------------------- API */

async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api/, "") || "/", m = req.method;

  if (p === "/health") return json(res, 200, { ok: true, app: "nocturne", version: VERSION, auth: !NO_AUTH, uptime: Math.round(process.uptime()) });

  if (p === "/me" && m === "GET") {
    return json(res, 200, { auth: !NO_AUTH, setup: !NO_AUTH && users.users.length === 0, user: currentUser(req) });
  }

  if (p === "/setup" && m === "POST") {
    if (NO_AUTH) return json(res, 400, { error: "已关闭登录" });
    if (users.users.length) return json(res, 409, { error: "管理员已存在，请直接登录" });
    const b = await readBody(req);
    const name = String(b.name || "").trim();
    if (!validName(name)) return json(res, 400, { error: "用户名只能包含字母、数字、. _ -，最多 32 位" });
    if (!validPass(b.password)) return json(res, 400, { error: "密码至少 6 位" });
    const hash = await hashPassword(b.password);
    if (users.users.length) return json(res, 409, { error: "管理员已存在，请直接登录" });
    users.users.push({ name, admin: true, hash, created: new Date().toISOString() });
    await saveUsers();
    setCookie(req, res, newSession(name));
    log("setup: admin created", name);
    return json(res, 200, { ok: true, user: { name, admin: true } });
  }

  if (p === "/login" && m === "POST") {
    if (NO_AUTH) return json(res, 200, { ok: true, user: currentUser(req) });
    const ip = clientIp(req);
    if (failsOf(ip).length >= FAIL_MAX) {
      const wait = Math.ceil((failsOf(ip)[0] + FAIL_WINDOW - Date.now()) / 60000);
      return json(res, 429, { error: "尝试次数过多，请 " + wait + " 分钟后再试" });
    }
    const b = await readBody(req);
    const u = findUser(String(b.name || "").trim());
    const ok = await verifyPassword(String(b.password || ""), u ? u.hash : DUMMY_HASH);
    if (!u || !ok) {
      const list = failsOf(ip); list.push(Date.now()); fails.set(ip, list);
      log("login failed", ip, JSON.stringify(String(b.name || "").slice(0, 40)));
      return json(res, 401, { error: "用户名或密码不正确", left: Math.max(0, FAIL_MAX - list.length) });
    }
    fails.delete(ip);
    setCookie(req, res, newSession(u.name));
    return json(res, 200, { ok: true, user: { name: u.name, admin: !!u.admin } });
  }

  if (p === "/logout" && m === "POST") {
    const t = parseCookies(req)[COOKIE];
    if (t && sessions[sha(t)]) { delete sessions[sha(t)]; await saveSessions(true); }
    setCookie(req, res, "", 0);
    return json(res, 200, { ok: true });
  }

  /* ---- 以下需要登录 ---- */
  const me = currentUser(req);
  if (!me) return json(res, 401, { error: "未登录" });

  if (p === "/config") {
    if (m === "GET" && url.searchParams.get("prev") === "1") { // 上一次被覆盖掉的服务器版本
      const prev = readJSON(backupFile(me.name), null);
      return prev && prev.data ? json(res, 200, prev) : json(res, 404, { error: "没有可恢复的服务器版本" });
    }
    if (m === "GET") {
      let doc = readConfig(me.name);
      if (doc.data && await migrateWallpaper(me.name, doc.data)) doc = await writeConfig(me.name, doc.data);
      return json(res, 200, doc);
    }
    if (m === "PUT") {
      const b = await readBody(req);
      if (!validConfig(b.data)) return json(res, 400, { error: "配置格式不正确" });
      const migrated = await migrateWallpaper(me.name, b.data);
      const cur = readConfig(me.name);
      // 客户端带上它基于的版本号；对不上说明另一台设备在这之间改过 → 仍以本次为准（后写覆盖），
      // 但把被覆盖的那一版留在 backup/，客户端可以「改用服务器版」
      const overwrote = b.baseVersion != null && +b.baseVersion !== (cur.version || 0) && !!cur.data;
      if (overwrote) await writeJSON(backupFile(me.name), cur);
      const doc = await writeConfig(me.name, b.data);
      probeSoon();
      return json(res, 200, { version: doc.version, updatedAt: doc.updatedAt, overwrote, ...(migrated ? { migrated: true } : {}) });
    }
    return json(res, 405, { error: "Method Not Allowed" });
  }

  if (p === "/wallpaper") {
    if (m === "GET" || m === "HEAD") {
      const w = findWallpaper(me.name);
      if (!w) return json(res, 404, { error: "没有自定义壁纸" });
      const etag = '"' + w.st.size.toString(36) + "-" + Math.round(w.st.mtimeMs).toString(36) + '"';
      const headers = {
        "Content-Type": WP_TYPES[w.ext], ETag: etag, "Last-Modified": new Date(w.st.mtimeMs).toUTCString(), Vary: "Cookie",
        // 前端用 ?v=<上传时间> 区分版本，同一个 v 的内容不会变
        "Cache-Control": url.searchParams.has("v") ? "private, max-age=31536000, immutable" : "private, no-cache",
      };
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); return res.end(); }
      return send(res, 200, fs.readFileSync(w.file), headers);
    }
    if (m === "PUT" || m === "POST") {
      const ct = String(req.headers["content-type"] || "").toLowerCase();
      // 只收原始图片：跨站表单发不出 image/* 的 Content-Type，配合 SameSite=Lax 防 CSRF
      if (!/^image\/(jpeg|png|webp)\b/.test(ct)) return json(res, 415, { error: "需要 image/jpeg、image/png 或 image/webp" });
      const buf = await readRaw(req, MAX_WALLPAPER);
      const ext = await storeWallpaper(me.name, buf);
      const v = Date.now();
      return json(res, 200, { ok: true, v, type: WP_TYPES[ext], size: buf.length, url: "api/wallpaper?v=" + v });
    }
    if (m === "DELETE") { await removeWallpaper(me.name); return json(res, 200, { ok: true }); }
    return json(res, 405, { error: "Method Not Allowed" });
  }

  if (p === "/status" && m === "GET") return json(res, 200, statusFor(me.name));

  if (p === "/docker" && m === "GET") {
    if (!docker.checkedAt || Date.now() - Date.parse(docker.checkedAt) > 10000) await refreshDocker();
    return json(res, 200, docker);
  }

  if (p.startsWith("/icon")) {
    if (m !== "GET" && m !== "HEAD") return json(res, 405, { error: "Method Not Allowed" });
    if (p === "/icon") { // /api/icon?q=selfhst/emby.svg 或 ?q=search?query=…
      const q = String(url.searchParams.get("q") || "");
      const i = q.indexOf("?");
      return serveIcon(req, res, i < 0 ? q : q.slice(0, i), i < 0 ? "" : q.slice(i));
    }
    return serveIcon(req, res, p.slice("/icon/".length), url.search);
  }

  if (p === "/password" && m === "POST") {
    if (NO_AUTH) return json(res, 400, { error: "已关闭登录，无需密码" });
    const b = await readBody(req), u = findUser(me.name);
    if (!(await verifyPassword(String(b.old || ""), u.hash))) return json(res, 400, { error: "当前密码不正确" });
    if (!validPass(b.password)) return json(res, 400, { error: "新密码至少 6 位" });
    u.hash = await hashPassword(b.password);
    await saveUsers();
    await dropSessionsOf(u.name, req.sessionKey); // 其他设备需重新登录
    return json(res, 200, { ok: true });
  }

  if (p === "/users" || p.startsWith("/users/")) {
    if (NO_AUTH) return json(res, 400, { error: "已关闭登录（NOCTURNE_NO_AUTH=1），无法管理账户" });
    if (!me.admin) return json(res, 403, { error: "需要管理员权限" });
    if (p === "/users" && m === "GET") {
      return json(res, 200, users.users.map((u) => ({ name: u.name, admin: !!u.admin, created: u.created, updatedAt: readConfig(u.name).updatedAt })));
    }
    if (p === "/users" && m === "POST") {
      const b = await readBody(req), name = String(b.name || "").trim();
      if (!validName(name)) return json(res, 400, { error: "用户名只能包含字母、数字、. _ -，最多 32 位" });
      if (name.toLowerCase() === NO_AUTH_USER) return json(res, 400, { error: "这个用户名是保留的" });
      if (findUser(name)) return json(res, 409, { error: "用户名已存在" });
      if (!validPass(b.password)) return json(res, 400, { error: "密码至少 6 位" });
      users.users.push({ name, admin: !!b.admin, hash: await hashPassword(b.password), created: new Date().toISOString() });
      await saveUsers();
      return json(res, 200, { ok: true });
    }
    const mm = p.match(/^\/users\/([^/]+)(\/password)?$/);
    if (mm) {
      const target = findUser(decodeURIComponent(mm[1]));
      if (!target) return json(res, 404, { error: "用户不存在" });
      if (mm[2] && m === "POST") {
        const b = await readBody(req);
        if (!validPass(b.password)) return json(res, 400, { error: "密码至少 6 位" });
        target.hash = await hashPassword(b.password);
        await saveUsers();
        await dropSessionsOf(target.name, target.name === me.name ? req.sessionKey : undefined);
        return json(res, 200, { ok: true });
      }
      if (!mm[2] && m === "DELETE") {
        if (target.name === me.name) return json(res, 400, { error: "不能删除自己" });
        users.users = users.users.filter((u) => u !== target);
        await saveUsers();
        await dropSessionsOf(target.name);
        await fsp.rm(configFile(target.name), { force: true });
        await removeWallpaper(target.name);
        await fsp.rm(backupFile(target.name), { force: true });
        configCache.delete(configFile(target.name));
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 405, { error: "Method Not Allowed" });
  }

  return json(res, 404, { error: "Not Found" });
}

/* ------------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch (e) { return send(res, 400, "Bad Request"); }
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method Not Allowed");
    // 旧浏览器/工具会直接请求 /favicon.ico：给 SVG 图标（登录前也可访问）
    return serveStatic(req, res, url.pathname === "/favicon.ico" ? "/favicon.svg" : url.pathname);
  } catch (e) {
    if (!e.status) log("error", req.method, url.pathname, e.stack || e.message);
    if (e.close) res.setHeader("Connection", "close"); // 没读完的请求体不再接收
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : "服务器内部错误" });
    else res.destroy();
  }
});

function main() {
  ensureDirs();
  loadState();
  migrateAllWallpapers().catch((e) => log("wallpaper migrate", e.message));
  server.listen(PORT, HOST, () => {
    log(`夜曲 Nocturne v${VERSION} 已启动 http://${HOST}:${PORT}  data=${DATA_DIR}  auth=${NO_AUTH ? "off" : "on"}  users=${users.users.length}`);
    if (!NO_AUTH && !users.users.length) log("尚未创建账户：打开网页创建管理员");
  });
  runProbes(false);
  setInterval(() => runProbes(false), STATUS_INTERVAL).unref();
  const stop = () => { log("shutting down"); saveSessions(true).finally(() => server.close(() => process.exit(0))); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
main();
