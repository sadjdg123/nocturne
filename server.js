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
const URLCHECK = require("./public/urlcheck.js"); // 与前端共用的 URL 白名单校验
const SPACES = require("./public/spaces.js"); // 与前端共用的场景空间模型（V2.0）

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
const PROBE_MAX_PER_USER = Math.max(1, +process.env.PROBE_MAX_PER_USER || 200); // 每个账户每轮最多让服务器探测多少个地址
const PROBE_MAX_TOTAL = Math.max(1, +process.env.PROBE_MAX_TOTAL || 2000); // 每轮总上限
const ICON_UPSTREAM = process.env.ICON_UPSTREAM || "https://api.iconify.design/"; // 可改成自建的 Iconify API（测试也用它指向本地模拟服务）
const CACHE_MAX_BYTES = Math.max(1, +process.env.CACHE_MAX_MB || 50) * 1048576; // data/cache 总大小上限
const CACHE_MAX_FILES = Math.max(20, +process.env.CACHE_MAX_FILES || 5000); // data/cache 文件数上限
const CACHE_TTL = Math.max(1, +process.env.CACHE_TTL_DAYS || 30) * 864e5; // 超过这么久没被用到的缓存直接删
const UPSTREAM_MAX = 256 * 1024, UPSTREAM_TIMEOUT = 8000; // 图标上游：单个响应上限、超时
const VERSION = require("./package.json").version;
const MAX_BODY = 2 * 1024 * 1024; // JSON 请求（配置等）上限；壁纸 / 上传的图标都单独存文件，这里只是安全余量
const MAX_ICON = 512 * 1024;
const MAX_WALLPAPER = 15 * 1024 * 1024;
const NO_AUTH_USER = "default";

const CONFIG_DIR = path.join(DATA_DIR, "config");
const CACHE_DIR = path.join(DATA_DIR, "cache");
const WALLPAPER_DIR = path.join(DATA_DIR, "wallpapers");
const BACKUP_DIR = path.join(DATA_DIR, "backup"); // 配置快照：backup/<user>/<时间戳>-<序号>-v<版本>[-<类型>].json，每人最多 BACKUP_KEEP 份 / BACKUP_MAX_BYTES
const ICONS_DIR = path.join(DATA_DIR, "icons"); // 上传的图标：icons/<user>/<id>.<ext>
const BACKUP_KEEP = Math.max(5, +process.env.BACKUP_KEEP || 30); // 每个账户最多保留几份配置快照
const BACKUP_MAX_BYTES = Math.max(1, +process.env.BACKUP_MAX_MB || 20) * 1048576; // 每个账户快照总大小上限
const SNAPSHOT_EVERY_MS = 30 * 60 * 1000, SNAPSHOT_EVERY_VERSIONS = 20; // 普通保存：距上一份快照满 30 分钟或 20 个版本，就把被替换的版本存一份
const OPS_KEEP = 50; // 记住最近 50 个已接受的推送 opId（重复推送直接返回当时的结果）
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

/** 本地时间 + 时区偏移（跟随 TZ 环境变量），例如 2026-10-08 03:14:05.123+08:00 */
function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0"), o = -d.getTimezoneOffset();
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + "." + p(d.getMilliseconds(), 3) +
    (o >= 0 ? "+" : "-") + p(Math.floor(Math.abs(o) / 60)) + ":" + p(Math.abs(o) % 60);
}
const log = (...a) => console.log(stamp(), ...a);

/* ------------------------------------------------------------------ storage */

function ensureDirs() {
  for (const d of [DATA_DIR, CONFIG_DIR, CACHE_DIR, WALLPAPER_DIR, BACKUP_DIR, ICONS_DIR]) fs.mkdirSync(d, { recursive: true });
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
async function writeFileAtomic(file, buf) {
  const tmp = file + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    const fh = await fsp.open(tmp, "w", 0o600);
    try { await fh.writeFile(buf); await fh.sync(); } finally { await fh.close(); }
    await fsp.rename(tmp, file);
  } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; } // 失败不留临时文件
}
/** 按用户串行：配置的「迁移 → 读 → 判冲突 → 备份 → 写」、壁纸 / 图标写入、删除用户都在这把锁里，避免并发交错 */
const userLocks = new Map();
function withUserLock(name, fn) {
  const k = String(name).toLowerCase();
  const run = (userLocks.get(k) || Promise.resolve()).catch(() => {}).then(fn);
  userLocks.set(k, run);
  run.finally(() => { if (userLocks.get(k) === run) userLocks.delete(k); }).catch(() => {});
  return run;
}

/* 全局账户锁：users.json 的所有写入（管理员初始化、新建 / 删除用户、改密 / 重置密码、已知设备令牌更新）都在这把锁里串行，
 * 「查重 → 算哈希 → 写入」是一个整体。锁的顺序：账户锁 → 用户锁（删除用户时在账户锁里再拿那个用户的锁清文件）；
 * 持有用户锁的代码（配置 / 壁纸 / 图标）绝不再去拿账户锁，所以不会死锁。 */
let accountsChain = Promise.resolve();
function withAccountsLock(fn) {
  const run = accountsChain.catch(() => {}).then(fn);
  accountsChain = run.catch(() => {});
  return run;
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
const PASS_MIN = 8; // 新建 / 修改密码的最短长度（已有的短密码照常能登录，不强制修改）
function validPass(p) { return typeof p === "string" && p.length >= PASS_MIN && p.length <= 200; }
const PASS_MSG = "密码至少 " + PASS_MIN + " 位（最长 200 位，可以用密码管理器生成的长密码）";
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
/** decodeURIComponent，遇到坏的百分号编码返回 null（调用方回 400，而不是抛 URIError 变成 500） */
function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return null; } }
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) { const v = safeDecode(part.slice(i + 1).trim()); if (v != null) out[part.slice(0, i).trim()] = v; } // 坏的 cookie 值直接忽略
  }
  return out;
}
const COOKIE = "nocturne_sid";
/** HTTPS 判定：只有直连对端是可信代理（TRUSTED_PROXY_CIDRS）时才看 X-Forwarded-Proto，否则只认本连接是否加密 */
function isHttps(req) { return clientInfo(req).https; }
/** 追加一条 Set-Cookie（同一响应可以设多个 cookie） */
function addCookie(req, res, name, value, maxAge) {
  const parts = [name + "=" + (value || ""), "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=" + maxAge];
  if (isHttps(req)) parts.push("Secure");
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), parts.join("; ")]);
}
function setCookie(req, res, token, maxAge) {
  addCookie(req, res, COOKIE, token, maxAge == null ? SESSION_DAYS * 86400 : maxAge);
}

/* 「已知设备」：登录成功时发一个长效 HttpOnly cookie，服务器只在 users.json 里存它的 sha256（每人最多 DEVICE_MAX 个）。
 * 带着它的登录请求不受「按用户名封禁」限制（只保留逐步变慢），这样别人反复试你的用户名也锁不住你自己的设备。
 * 修改 / 重置密码、删除用户时全部作废。 */
const DEV_COOKIE = "nocturne_dev", DEVICE_DAYS = 365, DEVICE_MAX = 20, DEV_RE = /^[A-Za-z0-9_-]{43}$/;
function knownDevice(req, u) {
  if (!u || !Array.isArray(u.devices)) return false;
  const t = parseCookies(req)[DEV_COOKIE];
  if (!t || !DEV_RE.test(t)) return false;
  const h = sha(t), now = Date.now();
  return u.devices.some((d) => d && d.h === h && d.exp > now);
}
/** 登录成功后调用：已是这个用户的已知设备就续期，否则发一个新的 */
function rememberDevice(req, res, u) {
  const old = parseCookies(req)[DEV_COOKIE];
  const t = old && knownDevice(req, u) ? old : crypto.randomBytes(32).toString("base64url");
  const h = sha(t), now = Date.now();
  u.devices = (Array.isArray(u.devices) ? u.devices : []).filter((d) => d && d.exp > now && d.h !== h);
  u.devices.push({ h, exp: now + DEVICE_DAYS * 864e5 });
  u.devices = u.devices.slice(-DEVICE_MAX);
  addCookie(req, res, DEV_COOKIE, t, DEVICE_DAYS * 86400);
  return saveUsers();
}
/** 带着哪个账户的有效「已知设备」cookie（不看用户名）；没有返回 null */
function deviceOwner(req) {
  const t = parseCookies(req)[DEV_COOKIE];
  if (!t || !DEV_RE.test(t)) return null;
  const h = sha(t), now = Date.now();
  return users.users.find((u) => Array.isArray(u.devices) && u.devices.some((d) => d && d.h === h && d.exp > now)) || null;
}
function revokeDevices(u) { if (u && u.devices && u.devices.length) { u.devices = []; return true; } return false; }
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

/* 可信反向代理：TRUSTED_PROXY_CIDRS=172.17.0.1,192.168.1.10/32,fd00::/8（逗号 / 空格分隔，IP 或 CIDR）。
 * 默认空 = 不信任任何转发头（X-Forwarded-For / X-Real-IP / X-Forwarded-Proto），一律用 TCP 对端地址。
 * 只有直连对端在列表里时才读转发头：X-Forwarded-For 从右往左跳过可信代理，第一个不可信的地址就是客户端；没有 XFF 时用 X-Real-IP。 */
function parseCidrList(str) {
  const b = new net.BlockList(), list = [];
  for (const raw of String(str || "").split(/[\s,;]+/).filter(Boolean)) {
    const m = /^([^/]+?)(?:\/(\d{1,3}))?$/.exec(raw.replace(/^\[|\]$/g, ""));
    const ip = m && normIp(m[1]), fam = ip && net.isIP(ip);
    if (!fam) { console.warn("TRUSTED_PROXY_CIDRS: 忽略无法识别的条目 " + JSON.stringify(raw)); continue; }
    const max = fam === 4 ? 32 : 128, n = m[2] == null ? max : +m[2];
    if (n > max) { console.warn("TRUSTED_PROXY_CIDRS: 前缀长度不对 " + JSON.stringify(raw)); continue; }
    b.addSubnet(ip, n, fam === 4 ? "ipv4" : "ipv6"); list.push(ip + "/" + n);
  }
  return { has: (a) => { const ip = normIp(a), f = net.isIP(ip); return !!f && b.check(ip, f === 4 ? "ipv4" : "ipv6"); }, list };
}
let TRUSTED_PROXIES = null; // 延迟初始化（normIp 在下面定义）
const trustedProxies = () => TRUSTED_PROXIES || (TRUSTED_PROXIES = parseCidrList(process.env.TRUSTED_PROXY_CIDRS));
const fwdWarned = new Set();
/** {peer, ip, https, forwarded, trustedPeer}：peer = TCP 对端；ip = 判定出的真实客户端地址 */
function clientInfo(req) {
  if (req._client) return req._client;
  const peer = normIp(String(req.socket.remoteAddress || "")), tp = trustedProxies();
  const h = req.headers, forwarded = !!(h["x-forwarded-for"] || h["x-real-ip"] || h["x-forwarded-proto"]);
  let ip = peer, https = !!req.socket.encrypted;
  const trustedPeer = tp.list.length > 0 && tp.has(peer);
  if (trustedPeer) {
    const xf = String(h["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean).map(cleanIp); // 不合法的段变成 ""
    let hops = 1; // 采信到第几跳（从右数）：X-Forwarded-Proto 取同一跳的值
    if (xf.length) {
      let pick = null, n = 0;
      for (let i = xf.length - 1; i >= 0; i--) {
        const v = xf[i];
        if (!v) break; // 中间有一段不是合法 IP：不再往左相信
        pick = v; n++;
        if (!tp.has(v)) break; // 第一个不可信的地址 = 客户端
      }
      if (pick) { ip = pick; hops = n; }
    } else {
      const xr = cleanIp(h["x-real-ip"]);
      if (xr) ip = xr;
    }
    const proto = forwardedProto(h["x-forwarded-proto"], hops);
    if (proto) https = proto === "https";
  } else if (forwarded && !fwdWarned.has(peer) && fwdWarned.size < 50) {
    fwdWarned.add(peer);
    log("收到来自 " + peer + " 的转发头（X-Forwarded-For / X-Real-IP），但它不在 TRUSTED_PROXY_CIDRS 里，已忽略；如果这是你的反向代理，把它加进 TRUSTED_PROXY_CIDRS");
  }
  return (req._client = { peer, ip: normIp(ip), https, forwarded, trustedPeer });
}
/** X-Forwarded-Proto（可能是逗号列表，重复的头被 Node 用 ", " 拼起来）：和 XFF 一样从右往左数，
 *  取第 hops 个（= 记下客户端地址的那个可信代理追加的值）；列表比 hops 短（代理是覆盖写而不是追加）时取最左边那个——
 *  也就是可信代理写下的值。最左边那些可能是客户端伪造的，只有真的走到那一跳才会用到。 */
function forwardedProto(raw, hops) {
  const list = (Array.isArray(raw) ? raw.join(",") : String(raw || "")).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return "";
  return list[Math.max(0, list.length - Math.max(1, hops))];
}
const PRIVATE_IP = /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]:|::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254)\.)/i;
const cleanIp = (s) => { s = String(s || "").trim().replace(/^\[|\](:\d+)?$/g, ""); return net.isIP(s) ? normIp(s) : ""; };
/** 真实客户端 IP（见 clientInfo：只信任 TRUSTED_PROXY_CIDRS 里的代理） */
function clientIp(req) { return clientInfo(req).ip; }
/** 「内网直连」：判定出的客户端地址是内网，且这个判定没有建立在被忽略的转发头上
 *  （带转发头却不是可信代理 = 要么是没配置的反向代理（外网访问会显示成网关地址），要么是伪造，都不给内网豁免） */
function lanClient(req) {
  const c = clientInfo(req);
  return PRIVATE_IP.test(c.ip) && (c.trustedPeer || !c.forwarded);
}
/** 滑动窗口计数：key -> [时间戳] */
function failCounter(windowMs, maxKeys) {
  const m = new Map();
  const of = (k) => {
    const now = Date.now(), list = (m.get(k) || []).filter((t) => now - t < windowMs);
    if (list.length) m.set(k, list); else m.delete(k);
    return list;
  };
  const add = (k) => {
    const list = of(k); list.push(Date.now()); m.set(k, list);
    if (m.size > maxKeys) m.delete(m.keys().next().value); // 防止随便编的用户名把内存撑大
    return list;
  };
  setInterval(() => { for (const k of [...m.keys()]) of(k); }, 60000).unref();
  /** 去掉一次记录（登录成功时只撤回自己占的那个名额） */
  const drop = (k, t) => { const list = m.get(k); if (!list) return; const i = list.lastIndexOf(t); if (i >= 0) list.splice(i, 1); if (!list.length) m.delete(k); };
  return { of, add, drop, clear: (k) => m.delete(k) };
}
/** 在途请求计数：同一 IP / 同一用户名同时最多 LOGIN_INFLIGHT 个登录在处理（scrypt 校验 + 逐步变慢期间一直占着） */
const LOGIN_INFLIGHT = 2;
const loginInflight = new Map();
function takeSlot(k) {
  const n = loginInflight.get(k) || 0;
  if (n >= LOGIN_INFLIGHT) return false;
  loginInflight.set(k, n + 1);
  return true;
}
function releaseSlot(k) { const n = (loginInflight.get(k) || 1) - 1; if (n > 0) loginInflight.set(k, n); else loginInflight.delete(k); }
const FAIL_WINDOW = 10 * 60 * 1000, FAIL_MAX = 5; // 按 IP：10 分钟 5 次
const NAME_WINDOW = 15 * 60 * 1000, NAME_MAX = 10, NAME_SLOW = 5; // 按用户名：15 分钟 10 次封顶，第 5 次起逐步变慢（和 IP 无关）
const ipFails = failCounter(FAIL_WINDOW, 10000);
const nameFails = failCounter(NAME_WINDOW, 5000);
const nameKey = (n) => String(n || "").trim().toLowerCase().slice(0, 64);

/* ------------------------------------------------------------------ configs */

const configFile = (name) => path.join(CONFIG_DIR, name.toLowerCase() + ".json");
const backupDir = (name) => path.join(BACKUP_DIR, name.toLowerCase());
const legacyBackupFile = (name) => path.join(BACKUP_DIR, name.toLowerCase() + ".json"); // 旧版：每人只有一个槽
let backupSeq = 0;
/** 旧版单槽备份 → 环形目录 */
async function migrateLegacyBackup(name) {
  const old = legacyBackupFile(name);
  let st; try { st = await fsp.stat(old); } catch (e) { return; }
  if (!st.isFile()) return;
  await fsp.mkdir(backupDir(name), { recursive: true });
  await fsp.rename(old, path.join(backupDir(name), String(Math.round(st.mtimeMs)).padStart(15, "0") + "-legacy.json"));
}
async function listBackups(name) {
  await migrateLegacyBackup(name);
  let files; try { files = await fsp.readdir(backupDir(name)); } catch (e) { return []; }
  return files.filter((f) => /^\d{15}-[\w-]+\.json$/.test(f)).sort().reverse().map((f) => path.join(backupDir(name), f)); // 新的在前
}
/** 写一份快照（环形：最多 BACKUP_KEEP 份、总共 BACKUP_MAX_BYTES，超出从最旧的删）；必须在 withUserLock 里调用。
 *  kind：auto 定期快照 / replaced 被「用本机版覆盖」替换 / restore 恢复前 / local 冲突时选「使用服务器版」留下的本机版本 */
async function addBackup(name, doc, kind) {
  await migrateLegacyBackup(name);
  await fsp.mkdir(backupDir(name), { recursive: true });
  const f = path.join(backupDir(name), String(Date.now()).padStart(15, "0") + "-" + String(++backupSeq % 1e6).padStart(6, "0") + "-v" + (doc.version || 0) + (kind ? "-" + kind : "") + ".json");
  await writeJSON(f, { version: doc.version, updatedAt: doc.updatedAt, data: doc.data, ...(kind ? { kind } : {}) }); // 不带 hist / ops
  const all = await listBackups(name);
  let bytes = 0;
  for (let i = 0; i < all.length; i++) {
    let size = 0; try { size = (await fsp.stat(all[i])).size; } catch (e) { continue; }
    bytes += size;
    if (i > 0 && (i >= BACKUP_KEEP || bytes > BACKUP_MAX_BYTES)) await fsp.rm(all[i], { force: true }); // 最新的一份永远保留
  }
}
/** 普通保存时是否该顺手存一份快照：没有快照、或距最新一份 ≥ 30 分钟、或相差 ≥ 20 个版本 */
async function snapshotDue(name, cur) {
  const all = await listBackups(name);
  if (!all.length) return true;
  const b = path.basename(all[0], ".json"), at = +b.slice(0, 15), m = /-v(\d+)/.exec(b);
  return Date.now() - at >= SNAPSHOT_EVERY_MS || (cur.version || 0) - (m ? +m[1] : 0) >= SNAPSHOT_EVERY_VERSIONS;
}
/** 备份 id = 文件名去掉 .json（时间戳-序号-v版本）；只认 listBackups 里真实存在的 */
const BACKUP_ID = /^\d{15}-[\w-]+$/;
async function backupSummaries(name) {
  const out = [];
  for (const f of await listBackups(name)) {
    const d = readJSON(f, null);
    if (!d || !d.data) continue;
    const id = path.basename(f, ".json"), groups = Array.isArray(d.data.groups) ? d.data.groups : [];
    const at = +id.slice(0, 15); // 进备份（被替换）的时间
    const km = /-(auto|replaced|restore|local|legacy)$/.exec(id);
    out.push({ id, version: d.version || 0, updatedAt: d.updatedAt || null, at: new Date(at).toISOString(), time: Date.parse(d.updatedAt) || at, // time：这个版本保存的时间（毫秒）
      groups: groups.length, items: allItems(d.data).length, spaces: Array.isArray(d.data.spaces) ? d.data.spaces.length : 0, kind: d.kind || (km ? km[1] : null) });
  }
  return out;
}
async function readBackup(name, id) {
  if (!BACKUP_ID.test(id)) return null;
  const f = (await listBackups(name)).find((x) => path.basename(x, ".json") === id);
  const d = f && readJSON(f, null);
  return d && d.data ? { version: d.version || 0, updatedAt: d.updatedAt || null, data: d.data } : null;
}
async function latestBackup(name) {
  for (const f of await listBackups(name)) { const d = readJSON(f, null); if (d && d.data) return d; }
  return null;
}
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
/* 内容指纹：sha256(键排序后的 JSON)。配置文档里记最近 HIST_KEEP 个版本的指纹 hist:[{v,h}]，
 * 用来识别「离线补推的其实是早就被接受过、后来又被别的设备改掉的旧内容」（见 PUT replay）。 */
const HIST_KEEP = 20;
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : canonical(x))).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined && typeof v[k] !== "function").map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}
const dataHash = (data) => sha(canonical(data));
/** 当前版本的指纹（旧文档没有 hist 时现算） */
function currentHash(doc) {
  const last = Array.isArray(doc.hist) && doc.hist[doc.hist.length - 1];
  return last && last.v === doc.version ? last.h : doc.data ? dataHash(doc.data) : null;
}
/** 对外返回的配置文档：不带 hist */
const publicDoc = (d) => ({ version: d.version || 0, updatedAt: d.updatedAt || null, data: d.data || null }); // 不带 hist / ops
async function writeConfig(name, data, opId, opHash) {
  const cur = readConfig(name);
  const version = (cur.version || 0) + 1;
  let hist = Array.isArray(cur.hist) ? cur.hist.slice() : [];
  if (cur.data && !hist.some((x) => x.v === cur.version)) hist.push({ v: cur.version || 0, h: dataHash(cur.data) }); // 旧文档：补上当前版本
  hist.push({ v: version, h: dataHash(data) });
  hist = hist.slice(-HIST_KEEP);
  let ops = Array.isArray(cur.ops) ? cur.ops.slice() : [];
  if (opId) ops = ops.filter((o) => o.id !== opId).concat({ id: opId, v: version, h: opHash || dataHash(data) }).slice(-OPS_KEEP); // h：这次推送收到的内容指纹（迁移前）
  const doc = { version, updatedAt: new Date().toISOString(), data, hist, ...(ops.length ? { ops } : {}) };
  await writeJSON(configFile(name), doc);
  configCache.delete(configFile(name));
  return doc;
}
/** 项目搜索别名 item.aliases（V1.1）：字符串数组、≤10 个、每个 ≤32 字。不合法 → 400（只是搜索文本，服务器不解释它） */
function aliasesError(d) {
  const bad = URLCHECK.checkAliases(d);
  if (!bad.length) return null;
  return { error: "有 " + bad.length + " 个项目的别名不合法（" + bad[0].where + "：" + bad[0].problem + "），未保存", code: "bad_aliases", aliases: bad.slice(0, 20) };
}
/** 场景空间 data.spaces（V2.0，可选）：结构不合法 → 400 bad_spaces（数量 ≤24、名称 ≤24 字且不重名、id 格式、引用是字符串数组且 ≤500、theme/density 枚举、无未知字段）。
 *  引用了不存在的分组 / 项目不算错误：保存前由 reconcileSpaces 清掉（见下）。 */
function spacesError(d) {
  const bad = SPACES.check(d);
  if (!bad.length) return null;
  return { error: "空间定义不合法（" + bad[0].where + "：" + bad[0].problem + "），未保存", code: "bad_spaces", spaces: bad.slice(0, 20) };
}
/** 保存前整理空间（必须在 withUserLock 里、拿到当前版本 cur 之后调用）。原地修改 body.data，返回 {kept, pruned}。
 *  1. 旧版前端保护：请求体没有 caps:["spaces"]（V1.1 前端不认识空间）且 data 里没有 spaces 字段，而服务器当前版本有空间定义
 *     → 沿用服务器上的空间定义（kept）。V2 前端总是带 caps，所以它明确删光空间 / 恢复默认时不会被「保护」回来。
 *  2. 悬空引用规则：groupIds / itemIds 里指向已不存在的分组 / 项目的 id 一律删掉（pruned = 删掉的个数）；空间本身保留（可以是空空间）。 */
function reconcileSpaces(body, cur) {
  const data = body.data, aware = Array.isArray(body.caps) && body.caps.includes("spaces");
  let kept = false;
  if (!aware && data.spaces === undefined && cur && cur.data && Array.isArray(cur.data.spaces) && cur.data.spaces.length) {
    data.spaces = JSON.parse(JSON.stringify(cur.data.spaces));
    kept = true;
  }
  return { kept, pruned: SPACES.prune(data) };
}
function validConfig(d) {
  return d && typeof d === "object" && !Array.isArray(d) && d.settings && typeof d.settings === "object" && Array.isArray(d.groups) &&
    d.groups.every((g) => g && typeof g === "object" && (g.items == null || Array.isArray(g.items)));
}
/** 配置里「新出现的」不安全地址（导航只许 http/https，搜索模板 http(s)+%s，图片另有白名单）。
 *  已经存在于当前版本或备份里的旧值不算新的：放行，免得历史配置一改就无法同步（前端渲染时会把它们当作无效地址、不可点击）。 */
async function newUnsafeUrls(name, data, cur) {
  const bad = URLCHECK.checkConfig(data);
  if (!bad.length) return [];
  const known = new Set();
  const add = (d) => { for (const x of URLCHECK.checkConfig(d)) { const k = legacyKey(x); if (k) known.add(k); } };
  if (cur && cur.data) add(cur.data);
  if (bad.some((x) => !known.has(legacyKey(x)))) for (const f of await listBackups(name)) add((readJSON(f, null) || {}).data);
  return bad.filter((x) => { const k = legacyKey(x); return !k || !known.has(k); });
}
/** 旧值豁免的键：同一个对象（项目 / 搜索引擎的 id；壁纸只有一个）+ 同一个字段 + 完全相同的原值。
 *  没有 id 的项目 / 搜索引擎不豁免（返回 null），所以新项目、别的字段、别的项目抄这个值都会被拒。 */
function legacyKey(x) {
  const id = x.kind === "wallpaper" ? "-" : typeof x.id === "string" || typeof x.id === "number" ? String(x.id) : "";
  if (!id) return null;
  return JSON.stringify([x.kind, id, x.field, typeof x.value === "string" ? x.value : JSON.stringify(x.value)]);
}
function unsafeError(list) {
  return Object.assign(new Error("配置里有 " + list.length + " 个不安全的地址（只支持 http:// 或 https://），未保存"),
    { status: 400, invalid: list.slice(0, 20).map((x) => ({ kind: x.kind, where: x.where, id: x.id || null, field: x.field, value: URLCHECK.show(x.value) })) });
}
/** 拿到用户锁之后再确认一次：账户还在、这个会话还有效（请求开始后账户可能被删 / 密码被改导致会话作废）。否则 401，什么都不写。 */
function assertAlive(me, req) {
  if (NO_AUTH) return;
  if (!findUser(me.name) || (req && req.sessionKey && !sessions[req.sessionKey])) throw Object.assign(new Error("账户已不存在或登录已失效"), { status: 401 });
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
  await writeFileAtomic(file, buf);
  for (const e of Object.keys(WP_TYPES)) if (e !== ext) await fsp.rm(wallpaperBase(name) + "." + e, { force: true });
  return ext;
}
async function removeWallpaper(name) {
  for (const e of Object.keys(WP_TYPES)) await fsp.rm(wallpaperBase(name) + "." + e, { force: true });
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const tooBig = () => Object.assign(new Error("图片太大（上限 " + (limit >= 1048576 ? Math.round(limit / 1048576) + "MB" : Math.round(limit / 1024) + "KB") + "）"), { status: 413, close: true });
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

/* -------------------------------------------------------------------- icons */

/** 上传的图标存成文件 /data/icons/<user>/<id>.<ext>，配置里记 {type:"image", value:"api/icons/<id>"}。
 *  只收位图（PNG / JPEG / WebP，按文件头判断），不收 SVG（可以内嵌脚本）。 */
const ICON_ID = /^[A-Za-z0-9_-]{16,64}$/;
const ICON_REF = /^api\/icons\/([A-Za-z0-9_-]{16,64})$/;
const ICON_MAX_FILES = 500, ICON_MAX_BYTES = 50 * 1024 * 1024; // 每个用户的上传图标上限：500 个或总共 50MB
const ICON_ORPHAN_GRACE = 24 * 3600 * 1000; // 没被引用满 24 小时才删（撤销、「改用服务器版」还能找回）
const iconDir = (name) => path.join(ICONS_DIR, name.toLowerCase());
const newIconId = () => crypto.randomBytes(16).toString("base64url");
function findIcon(name, id) {
  if (!ICON_ID.test(id)) return null;
  for (const ext of Object.keys(WP_TYPES)) {
    const f = path.join(iconDir(name), id + "." + ext);
    try { const st = fs.statSync(f); if (st.isFile()) return { file: f, ext, st }; } catch (e) { /* next */ }
  }
  return null;
}
async function storeIcon(name, id, buf) {
  const ext = sniffImage(buf);
  if (!ext) throw Object.assign(new Error("图标只支持 PNG / JPEG / WebP 图片"), { status: 415 });
  if (buf.length > MAX_ICON) throw Object.assign(new Error("图标太大（上限 512KB）"), { status: 413 });
  await fsp.mkdir(iconDir(name), { recursive: true });
  await writeFileAtomic(path.join(iconDir(name), id + "." + ext), buf);
  for (const e of Object.keys(WP_TYPES)) if (e !== ext) await fsp.rm(path.join(iconDir(name), id + "." + e), { force: true });
  return ext;
}
/** 当前用户的图标文件数和总大小（replaceId：PUT 覆盖同一个 id 时，旧文件不计入） */
async function iconUsage(name, replaceId) {
  let files; try { files = await fsp.readdir(iconDir(name)); } catch (e) { return { count: 0, bytes: 0 }; }
  let count = 0, bytes = 0;
  for (const f of files) {
    const m = /^([A-Za-z0-9_-]{16,64})\.(png|jpg|webp)$/.exec(f);
    if (!m || m[1] === replaceId) continue;
    try { bytes += (await fsp.stat(path.join(iconDir(name), f))).size; count++; } catch (e) { /* 刚被删 */ }
  }
  return { count, bytes };
}
/** 上传前检查配额；超了先试着清理一次没被引用的旧图标（仍受 24 小时宽限期保护），还超就 413。必须在 withUserLock 里调用。 */
async function checkIconQuota(name, id, size) {
  const over = (u) => u.count + 1 > ICON_MAX_FILES || u.bytes + size > ICON_MAX_BYTES;
  if (!over(await iconUsage(name, id))) return;
  await cleanupIcons(name).catch((e) => log("icon cleanup", name, e.message));
  const u = await iconUsage(name, id);
  if (over(u)) throw Object.assign(new Error("上传的图标已达上限（每个账户最多 " + ICON_MAX_FILES + " 个、共 " + Math.round(ICON_MAX_BYTES / 1048576) + "MB），请先删掉一些不用的图标"), { status: 413, usage: u });
}
async function removeIcon(name, id) {
  if (!ICON_ID.test(id)) return;
  for (const e of Object.keys(WP_TYPES)) await fsp.rm(path.join(iconDir(name), id + "." + e), { force: true });
}
function allItems(data) {
  const out = [];
  for (const g of (data && Array.isArray(data.groups) ? data.groups : [])) for (const it of (g && Array.isArray(g.items) ? g.items : [])) if (it && typeof it === "object") out.push(it);
  return out;
}
/** 配置里的 data URL 图标 → 文件。返回改动数量。必须在 withUserLock 里调用。 */
async function migrateIcons(name, data) {
  let n = 0;
  for (const it of allItems(data)) {
    const ic = it.icon;
    if (!ic || ic.type !== "image" || typeof ic.value !== "string" || !ic.value.startsWith("data:")) continue;
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(ic.value);
    if (!m) continue; // SVG 等：保持原样（只在 <img> 里显示，不执行脚本）
    const buf = Buffer.from(m[2], "base64");
    if (!sniffImage(buf) || buf.length > MAX_ICON) continue;
    const id = newIconId();
    try { await storeIcon(name, id, buf); } catch (e) { log("icon migrate", name, e.message); continue; }
    it.icon = Object.assign({}, ic, { value: "api/icons/" + id });
    n++;
  }
  if (n) log("icons migrated from data URL", name, n);
  return n;
}
function iconRefs(data, set) {
  for (const it of allItems(data)) { const m = it.icon && typeof it.icon.value === "string" && ICON_REF.exec(it.icon.value); if (m) set.add(m[1]); }
  return set;
}
/** 清理没被当前配置和备份引用的图标文件（尽力而为）。必须在 withUserLock 里调用。 */
async function cleanupIcons(name) {
  let files; try { files = await fsp.readdir(iconDir(name)); } catch (e) { return; }
  const refs = iconRefs(readConfig(name).data, new Set());
  for (const f of await listBackups(name)) iconRefs((readJSON(f, null) || {}).data, refs);
  const markFile = path.join(iconDir(name), ".orphans.json"), marks = readJSON(markFile, {}), now = Date.now(), next = {};
  let changed = false;
  for (const f of files) {
    const m = /^([A-Za-z0-9_-]{16,64})\.(png|jpg|webp)$/.exec(f);
    if (!m || refs.has(m[1])) continue;
    const since = marks[m[1]] || now;
    if (now - since > ICON_ORPHAN_GRACE) { await fsp.rm(path.join(iconDir(name), f), { force: true }); changed = true; log("icon removed (unreferenced)", name, m[1]); }
    else next[m[1]] = since;
  }
  if (changed || JSON.stringify(next) !== JSON.stringify(marks)) await writeJSON(markFile, next);
}
/** data URL 壁纸 / 图标 → 文件。返回是否改动了 data。必须在 withUserLock 里调用。 */
async function migrateData(name, data) {
  const a = await migrateWallpaper(name, data), b = await migrateIcons(name, data);
  return a || b > 0;
}
async function migrateAll() {
  for (const name of allUserNames()) {
    await withUserLock(name, async () => {
      const cur = readConfig(name);
      if (cur.data && await migrateData(name, cur.data)) await writeConfig(name, cur.data);
    });
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
/** IPv6 → 8 个 16 位整数（支持 :: 缩写和末尾内嵌 IPv4），不是合法 IPv6 返回 null */
function v6words(a) {
  a = String(a).replace(/%.*$/, "");
  if (net.isIP(a) !== 6) return null;
  const m4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (m4) a = a.slice(0, m4.index) + ((+m4[1] << 8) | +m4[2]).toString(16) + ":" + ((+m4[3] << 8) | +m4[4]).toString(16);
  const [l, r] = a.split("::"), L = l ? l.split(":") : [], R = r != null && r ? r.split(":") : [];
  const words = r == null ? L : [...L, ...Array(8 - L.length - R.length).fill("0"), ...R];
  return words.length === 8 ? words.map((w) => parseInt(w, 16)) : null;
}
/** 内嵌 IPv4 的 IPv6 → IPv4：IPv4-mapped ::ffff:a.b.c.d、IPv4-compatible ::a.b.c.d（已废弃）、
 *  NAT64 64:ff9b::/96 与本地 NAT64 64:ff9b:1::/48（RFC 8215，取末 32 位）。其他原样返回。 */
function normIp(a) {
  const w = v6words(a);
  if (!w) return a;
  const v4 = () => [w[6] >> 8, w[6] & 255, w[7] >> 8, w[7] & 255].join(".");
  const zero = (from, to) => w.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && w[5] === 0xffff) return v4(); // ::ffff:0:0/96
  if (zero(0, 6) && (w[6] || w[7] > 1)) return v4(); // ::a.b.c.d（排除 :: 和 ::1）
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return v4(); // 64:ff9b::/96
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return v4(); // 64:ff9b:1::/48
  return a;
}
function selfAddrs() {
  const s = new Set();
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) s.add(normIp(i.address));
  return s;
}
/** 返回 {addrs:[{address, family}]}（全部检查过）或 {blocked: 原因} / {error} */
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
  const mine = selfAddrs(), ok = [];
  for (const a of addrs) {
    const raw = String(a.address).replace(/%.*$/, ""), ip = normIp(raw), type = net.isIP(ip) === 6 ? "ipv6" : "ipv4";
    // 内嵌 IPv4 的地址（NAT64 等）按内嵌的 IPv4 检查；IPv6 本身也要过一遍
    const v6 = ip !== raw && net.isIP(raw) === 6 && ALWAYS_BLOCK.check(raw, "ipv6");
    if (v6 || ALWAYS_BLOCK.check(ip, type)) return { blocked: "link-local / metadata / unspecified address (" + raw + ")" };
    if (port === PORT && (LOOPBACK.check(ip, type) || mine.has(ip) || mine.has(raw))) return { blocked: "Nocturne itself (" + raw + ":" + port + ")" };
    if (PROBE_PRIVATE_ONLY && !PRIVATE_NET.check(ip, type)) return { blocked: "not a private address (" + raw + "), PROBE_PRIVATE_ONLY=1" };
    // NAT64 要连 IPv6 本身（由网关转换）；mapped / compatible 直接连内嵌的 IPv4
    const conn = raw.toLowerCase().startsWith("64:ff9b:") ? raw : ip;
    ok.push({ address: conn, family: net.isIP(conn) });
  }
  return { addrs: ok, userAllowed: probeAllowed(u, ok) };
}

/* 普通（非管理员）账户的探测白名单 PROBE_ALLOW：逗号 / 空格分隔，每条是
 *   IP 或 CIDR（192.168.1.0/24、fd00::/8）、主机名（nas.lan、*.home.arpa）、或 *，都可以带 :端口（192.168.1.20:8096、*:8096、[fd00::1]:80）。
 * 管理员账户的地址照常探测（仍受上面的永久拦截规则约束）；普通账户的地址只有匹配 PROBE_ALLOW 才由服务器探测，
 * 否则服务器不发请求，前端退回浏览器自己探测（和 xxx.local 一样）。默认空 = 普通账户的地址一律不由服务器探测。
 * IP / CIDR 规则要求「所有解析结果」都在范围内（防 DNS 指向别处）；主机名规则按 URL 里的主机名匹配。 */
function parseProbeAllow(str) {
  const rules = [];
  for (let raw of String(str || "").split(/[\s,;]+/).filter(Boolean)) {
    let host = raw, port = null, m;
    if ((m = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw))) { host = m[1]; port = m[2] ? +m[2] : null; }
    else if ((raw.match(/:/g) || []).length === 1 && (m = /^(.*):(\d{1,5})$/.exec(raw))) { host = m[1]; port = +m[2]; }
    if (port != null && !(port > 0 && port < 65536)) { console.warn("PROBE_ALLOW: 端口不对 " + JSON.stringify(raw)); continue; }
    const cm = /^([^/]+)\/(\d{1,3})$/.exec(host), ip = normIp(cm ? cm[1] : host), fam = net.isIP(ip);
    if (fam) {
      const n = cm ? +cm[2] : fam === 4 ? 32 : 128;
      if (n > (fam === 4 ? 32 : 128)) { console.warn("PROBE_ALLOW: 前缀长度不对 " + JSON.stringify(raw)); continue; }
      const b = new net.BlockList(); b.addSubnet(ip, n, fam === 4 ? "ipv4" : "ipv6");
      rules.push({ raw, port, net: b });
    } else if (host === "*" || /^(\*\.)?[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?$/i.test(host)) {
      rules.push({ raw, port, host: host.toLowerCase().replace(/\.$/, "") });
    } else console.warn("PROBE_ALLOW: 忽略无法识别的条目 " + JSON.stringify(raw));
  }
  return rules;
}
const PROBE_ALLOW = parseProbeAllow(process.env.PROBE_ALLOW);
/** 这个目标（URL + 检查过的解析地址）是否在 PROBE_ALLOW 里 */
function probeAllowed(u, addrs, rules = PROBE_ALLOW) {
  if (!rules.length) return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, ""), port = +u.port || (u.protocol === "https:" ? 443 : 80);
  return rules.some((r) => {
    if (r.port != null && r.port !== port) return false;
    if (r.host) return r.host === "*" || r.host === host || (r.host.startsWith("*.") && host.endsWith(r.host.slice(1)));
    return addrs.length > 0 && addrs.every((a) => { const ip = normIp(a.address), f = net.isIP(ip); return !!f && r.net.check(ip, f === 4 ? "ipv4" : "ipv6"); });
  });
}
function isAdminName(name) {
  if (NO_AUTH && String(name).toLowerCase() === NO_AUTH_USER) return true;
  const u = findUser(name);
  return !!(u && u.admin);
}

const results = new Map(); // url -> {up, ms, checkedAt, code, error, blocked, userAllowed, restricted}
const blockedLogged = new Set();
let docker = { available: false, containers: [], checkedAt: null, error: null };

/** restricted：只有普通账户在用这个地址 → 不在 PROBE_ALLOW 里就不发请求。HTTP 请求不跟随重定向（只看第一个响应的状态码）。 */
function probe(url, restricted) {
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
      if (restricted && !v.userAllowed) return finish({ up: false, ms: null, blocked: true, policy: true, userAllowed: false, restricted: true, error: "blocked: not in PROBE_ALLOW" });
      const mod = u.protocol === "https:" ? https : http;
      req = mod.request(u, {
        method: "GET",
        rejectUnauthorized: PROBE_TLS_STRICT, // 默认 false：家里的自签名证书也算在线
        // 只连接上面检查过的地址（不再二次解析，防 DNS rebinding）；Host / SNI 仍是原主机名
        // o.all：返回检查过的全部地址，Node 的 happy-eyeballs 才能从 IPv6 回退到 IPv4
        lookup: (h, o, cb) => (o && o.all ? cb(null, v.addrs.map((a) => ({ address: a.address, family: a.family }))) : cb(null, v.addrs[0].address, v.addrs[0].family)),
        headers: { "User-Agent": "Nocturne-StatusProbe/" + VERSION, Accept: "*/*", Connection: "close" },
      }, (res) => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const code = res.statusCode || 0;
        res.destroy(); // 不读响应体、不跟随 3xx（重定向目标不会被请求，也就绕不过上面的检查）
        finish({ up: code > 0 && code < 500, ms: Math.round(ms), code, userAllowed: v.userAllowed, restricted: !!restricted });
      });
      req.on("error", (e) => finish({ up: false, ms: null, error: e.code || e.message, userAllowed: v.userAllowed, restricted: !!restricted }));
      req.end();
    }, (e) => finish({ up: false, ms: null, error: e.message }));
  });
}

/* DOCKER_SOCK：unix socket 路径（默认 /var/run/docker.sock），或 tcp://主机:端口 / http://主机:端口
 * （例如只开放 CONTAINERS=1 的 tecnativa/docker-socket-proxy：tcp://docker-proxy:2375）。夜曲只发 GET /containers/json。 */
const DOCKER_TCP = /^(tcp|http):\/\/([^/:]+|\[[^\]]+\]):(\d+)\/?$/i.exec(DOCKER_SOCK);
function dockerRequest(p) {
  return new Promise((resolve, reject) => {
    const target = DOCKER_TCP ? { host: DOCKER_TCP[2].replace(/^\[|\]$/g, ""), port: +DOCKER_TCP[3] } : { socketPath: DOCKER_SOCK };
    const req = http.request(Object.assign(target, { path: p, method: "GET", headers: { Host: "docker" } }), (res) => {
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
  let st = null;
  if (!DOCKER_TCP) { try { st = fs.statSync(DOCKER_SOCK); } catch (e) { docker = { available: false, containers: [], checkedAt: new Date().toISOString(), error: null }; return; } }
  if (st && !st.isSocket()) { docker = { available: false, containers: [], checkedAt: new Date().toISOString(), error: "not a socket" }; return; }
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
    const urls = new Map(); // url -> 是否有管理员在用（有 = 不受 PROBE_ALLOW 限制）
    for (const name of allUserNames()) {
      const admin = isAdminName(name), mine = new Set();
      for (const it of itemsOf(readConfig(name))) {
        const t = probeTarget(it);
        if (!t || t.reserved || mine.has(t.url)) continue;
        if (mine.size >= PROBE_MAX_PER_USER) break; // 每个账户每轮的上限：多出来的地址前端自己探测
        mine.add(t.url);
        if (!urls.has(t.url) && urls.size >= PROBE_MAX_TOTAL) continue;
        urls.set(t.url, urls.get(t.url) || admin);
      }
    }
    const want = new Set(urls.keys());
    const queue = [];
    for (const [u, admin] of urls) {
      const prev = results.get(u);
      if (onlyNew && prev && !(prev.restricted && admin)) continue; // 新地址，或者原来只有普通账户在用、现在管理员也加了
      if (!admin && !PROBE_ALLOW.length) { results.set(u, { up: false, ms: null, checkedAt: new Date().toISOString(), blocked: true, policy: true, userAllowed: false, restricted: true, error: "blocked: not in PROBE_ALLOW" }); continue; } // 不发请求，连 DNS 都不查
      queue.push([u, !admin]);
    }
    const worker = async () => { while (queue.length) { const [u, restricted] = queue.shift(); results.set(u, await probe(u, restricted)); } };
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
    if (!onlyNew) { // 清理已不存在的地址
      for (const u of results.keys()) if (!want.has(u)) results.delete(u);
    }
  })().catch((e) => log("probe loop", e.message)).finally(() => { probing = null; });
  return probing;
}
let soonTimer = null;
function probeSoon() { clearTimeout(soonTimer); soonTimer = setTimeout(() => runProbes(true), 800); }

function statusFor(name) {
  const admin = isAdminName(name), out = {}, byName = new Map(docker.containers.map((c) => [c.name.toLowerCase(), c]));
  for (const it of itemsOf(readConfig(name))) {
    const t = probeTarget(it);
    let r = null;
    if (t && t.reserved) r = { up: false, ms: null, checkedAt: null, via: "http", error: "reserved domain" };
    else if (t && results.has(t.url)) {
      const x = results.get(t.url);
      // 普通账户：不在 PROBE_ALLOW 里的地址不给服务器的探测结果（哪怕管理员也有同一个地址），不返回这一项 → 前端用浏览器探测
      if (!admin && !x.userAllowed && !(x.blocked && !x.policy)) continue;
      r = Object.assign({ via: "http" }, x);
    }
    // 关联容器只对管理员生效：普通账户填任意容器名就能读到它的运行状态 = 变相枚举 NAS 上的容器
    const c = admin && it.container && docker.available ? byName.get(String(it.container).toLowerCase()) : null;
    // xxx.local（Bonjour / mDNS）在容器的 bridge 网络里解析不了，但浏览器可以：不返回这一项，让前端退回浏览器探测
    if (r && !c && /^(ENOTFOUND|EAI_AGAIN)$/.test(r.error || "") && /\.local\.?$/i.test(new URL(t.url).hostname)) continue;
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
/** 图标搜索参数：只认这几个键，长度受限，按固定顺序重建（同一个搜索只占一份缓存）。不合法返回 null */
const SEARCH_KEYS = { query: /^[^\u0000-\u001f]{1,100}$/, limit: /^\d{1,3}$/, start: /^\d{1,4}$/, prefixes: /^[a-z0-9,-]{1,200}$/i, prefix: /^[a-z0-9-]{1,64}$/i, category: /^[^\u0000-\u001f]{1,64}$/ };
function canonicalSearch(search) {
  if (!search || search.length > 600) return null;
  let sp; try { sp = new URLSearchParams(search.replace(/^\?/, "")); } catch (e) { return null; }
  const got = {};
  for (const [k, v] of sp) { if (!SEARCH_KEYS[k] || got[k] != null || !SEARCH_KEYS[k].test(v)) return null; got[k] = v; }
  if (!got.query) return null;
  const out = new URLSearchParams();
  for (const k of Object.keys(SEARCH_KEYS)) if (got[k] != null) out.set(k, got[k]);
  return "?" + out.toString();
}
function fetchUpstream(url, wantType) {
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } };
    const mod = url.startsWith("http:") ? http : https;
    const req = mod.get(url, { headers: { "User-Agent": "Nocturne/" + VERSION, Accept: wantType + ", */*;q=0.1", "Accept-Encoding": "identity" } }, (res) => {
      const status = res.statusCode || 0, type = String(res.headers["content-type"] || "");
      if (status === 200 && !wantType.split(",").some((t) => type.toLowerCase().startsWith(t.trim()))) { res.destroy(); return fail(Object.assign(new Error("unexpected content-type " + type.slice(0, 60)), { upstream: true })); }
      if (+res.headers["content-length"] > UPSTREAM_MAX) { res.destroy(); return fail(Object.assign(new Error("too large"), { upstream: true })); }
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > UPSTREAM_MAX) { res.destroy(); fail(Object.assign(new Error("too large"), { upstream: true })); } else chunks.push(c); });
      res.on("end", () => { if (!done) { done = true; clearTimeout(timer); resolve({ status, type, body: Buffer.concat(chunks) }); } });
      res.on("error", fail);
    });
    const timer = setTimeout(() => { req.destroy(); fail(new Error("timeout")); }, UPSTREAM_TIMEOUT); // 整体超时（连接 + 下载）
    req.on("error", fail);
  });
}

/* data/cache 清理：启动后和每 6 小时异步跑一次；写入后若估算超限也会提前跑。只碰 data/cache，绝不碰 data/icons（用户上传的图标）。
 * 规则：超过 CACHE_TTL 没被用到的删掉；仍超过 CACHE_MAX_FILES / CACHE_MAX_MB 时按最近使用时间（mtime，命中时会刷新）从旧到新淘汰。 */
const CACHE_FILE = /^icon-([0-9a-f]{40})\.(bin|json)$/;
let cacheSweep = null, cacheApprox = { files: 0, bytes: 0 }, cacheSoon = null;
function sweepCache() {
  if (cacheSweep) return cacheSweep;
  cacheSweep = (async () => {
    let names; try { names = await fsp.readdir(CACHE_DIR); } catch (e) { return { files: 0, bytes: 0, removed: 0 }; }
    const now = Date.now(), entries = new Map();
    let removed = 0;
    for (const f of names) {
      const full = path.join(CACHE_DIR, f);
      if (f.endsWith(".tmp")) { // 中断留下的临时文件：1 小时以上的删掉
        try { const st = await fsp.stat(full); if (now - st.mtimeMs > 3600e3) { await fsp.rm(full, { force: true }); removed++; } } catch (e) { /* gone */ }
        continue;
      }
      const m = CACHE_FILE.exec(f); if (!m) continue;
      let st; try { st = await fsp.stat(full); } catch (e) { continue; }
      const e = entries.get(m[1]) || { files: [], bytes: 0, t: 0 };
      e.files.push(full); e.bytes += st.size; e.t = Math.max(e.t, st.mtimeMs);
      entries.set(m[1], e);
    }
    let files = 0, bytes = 0;
    const live = [];
    for (const e of entries.values()) {
      if (now - e.t > CACHE_TTL) { for (const f of e.files) await fsp.rm(f, { force: true }); removed += e.files.length; continue; }
      live.push(e); files += e.files.length; bytes += e.bytes;
    }
    live.sort((a, b) => a.t - b.t);
    for (const e of live) {
      if (files <= CACHE_MAX_FILES && bytes <= CACHE_MAX_BYTES) break;
      for (const f of e.files) await fsp.rm(f, { force: true });
      files -= e.files.length; bytes -= e.bytes; removed += e.files.length;
    }
    cacheApprox = { files, bytes };
    if (removed) log("icon cache sweep: removed " + removed + " files, now " + files + " files / " + Math.round(bytes / 1024) + "KB");
    return { files, bytes, removed };
  })().catch((e) => { log("icon cache sweep", e.message); return null; }).finally(() => { cacheSweep = null; });
  return cacheSweep;
}
/* 上限是「软」的：写入后按估算值判断，超了马上（异步）清理一次；清理进行中又超了，就在它结束后再跑一次。
 * 加上上游并发上限 ICON_FETCH_MAX，峰值最多超出 CACHE_MAX_FILES 约「清理一轮期间新写入的文件数」，随后很快回落。 */
function noteCacheWrite(bytes) {
  cacheApprox.files += 2; cacheApprox.bytes += bytes;
  if ((cacheApprox.files > CACHE_MAX_FILES || cacheApprox.bytes > CACHE_MAX_BYTES) && !cacheSoon) {
    cacheSoon = setTimeout(() => { cacheSoon = null; (cacheSweep || Promise.resolve()).then(() => sweepCache()); }, 0);
  }
}
/* 上游并发上限：同时最多 ICON_FETCH_MAX 个不同的图标在拉取 / 写缓存，其余排队（同一个 key 本来就只拉一次） */
const ICON_FETCH_MAX = 8;
let iconFetching = 0;
const iconFetchQueue = [];
function iconSlot() {
  if (iconFetching < ICON_FETCH_MAX) { iconFetching++; return Promise.resolve(); }
  return new Promise((r) => iconFetchQueue.push(r));
}
function iconSlotDone() { const next = iconFetchQueue.shift(); if (next) next(); else iconFetching--; }
/** 拉上游并写缓存（同一个 key 并发只拉一次）；返回 {status, type, body} */
function fetchIcon(key, base, upstreamUrl, isSvg) {
  let p = iconInflight.get(key);
  if (p) return p;
  p = (async () => {
    await iconSlot();
    try { return await fetchAndStore(); } finally { iconSlotDone(); }
  })().finally(() => iconInflight.delete(key));
  iconInflight.set(key, p);
  return p;
  async function fetchAndStore() {
    const r = await fetchUpstream(upstreamUrl, isSvg ? "image/svg+xml" : "application/json");
    if (r.status !== 200 && r.status !== 404) throw Object.assign(new Error("upstream http " + r.status), { upstream: true });
    const status = r.status === 200 ? 200 : 404;
    const type = status === 200 ? (isSvg ? "image/svg+xml" : "application/json; charset=utf-8") : "text/plain; charset=utf-8";
    const body = status === 200 ? r.body : Buffer.from("not found");
    try { // 只缓存确定的结果；异步原子写入（先 .bin 后 .json，.json 在就说明 .bin 完整）
      await writeFileAtomic(base + ".bin", body);
      await writeFileAtomic(base + ".json", Buffer.from(JSON.stringify({ t: Date.now(), status, type, key })));
      noteCacheWrite(body.length + 200);
    } catch (e) { log("icon cache write", e.message); }
    return { status, type, body };
  }
}
async function serveIcon(req, res, rest, search) {
  if (rest.length > 200) return json(res, 400, { error: "不支持的图标请求" });
  const isSvg = ICON_SVG.test(rest);
  let q = "";
  if (isSvg) q = ""; // SVG 不带参数（前端也不用），免得同一个图标被随便加参数撑出无数份缓存
  else if (ICON_SEARCH.test(rest) && search) { q = canonicalSearch(search); if (!q) return json(res, 400, { error: "图标搜索参数不合法" }); }
  else return json(res, 400, { error: "不支持的图标请求" });
  const key = rest + q;
  const ttl = isSvg ? 30 * 864e5 : 864e5;
  const base = path.join(CACHE_DIR, "icon-" + sha(key).slice(0, 40));
  const out = (status, type, body, hit) => send(res, status, body, {
    "Content-Type": type, "Cache-Control": status === 200 ? (isSvg ? "public, max-age=604800" : "public, max-age=3600") : "public, max-age=600",
    "X-Cache": hit ? "HIT" : "MISS", "X-Content-Type-Options": "nosniff",
    ...(isSvg ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } : {}),
  });
  let meta = null, cached = null;
  try { meta = JSON.parse(await fsp.readFile(base + ".json", "utf8")); } catch (e) { /* miss */ }
  if (meta) { try { cached = await fsp.readFile(base + ".bin"); } catch (e) { meta = null; } }
  if (meta && Date.now() - meta.t < (meta.status === 200 ? ttl : 864e5)) {
    const now = new Date(); fsp.utimes(base + ".json", now, now).catch(() => {}); // 记一下「最近用过」，清理时按它淘汰
    return out(meta.status, meta.type, cached, true);
  }
  try {
    const r = await fetchIcon(key, base, ICON_UPSTREAM + rest + q, isSvg);
    out(r.status, r.type, r.body, false);
  } catch (e) {
    if (meta && cached) return out(meta.status, meta.type, cached, true); // 上游连不上 / 返回异常：退回旧缓存
    if (!e.upstream && e.message !== "timeout") log("icon upstream", e.message);
    json(res, 502, { error: "图标服务暂时连不上" });
  }
}

/* ---------------------------------------------------------------------- API */

async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api/, "") || "/", m = req.method;

  if (p === "/health") {
    const out = { ok: true, app: "nocturne", version: VERSION, auth: !NO_AUTH, uptime: Math.round(process.uptime()) };
    const u = currentUser(req);
    if (u && u.admin) { // 只给管理员看：帮你确认 TRUSTED_PROXY_CIDRS 该填什么
      const c = clientInfo(req);
      out.client = { peer: c.peer, ip: c.ip, https: c.https, forwardedHeaders: c.forwarded, trustedPeer: c.trustedPeer, lan: lanClient(req),
        xForwardedFor: String(req.headers["x-forwarded-for"] || "").slice(0, 300) || null, xRealIp: String(req.headers["x-real-ip"] || "").slice(0, 60) || null,
        trustedProxies: trustedProxies().list };
    }
    return json(res, 200, out);
  }

  if (p === "/me" && m === "GET") {
    return json(res, 200, { auth: !NO_AUTH, setup: !NO_AUTH && users.users.length === 0, user: currentUser(req) });
  }

  if (p === "/setup" && m === "POST") {
    if (NO_AUTH) return json(res, 400, { error: "已关闭登录" });
    if (users.users.length) return json(res, 409, { error: "管理员已存在，请直接登录" });
    const b = await readBody(req);
    const name = String(b.name || "").trim();
    if (!validName(name)) return json(res, 400, { error: "用户名只能包含字母、数字、. _ -，最多 32 位" });
    if (!validPass(b.password)) return json(res, 400, { error: PASS_MSG });
    return withAccountsLock(async () => {
      if (users.users.length) return json(res, 409, { error: "管理员已存在，请直接登录" });
      const admin = { name, admin: true, hash: await hashPassword(b.password), created: new Date().toISOString() };
      users.users.push(admin);
      setCookie(req, res, newSession(name));
      await rememberDevice(req, res, admin); // 创建管理员的这台设备算「已知设备」（内含 saveUsers()）
      log("setup: admin created", name);
      return json(res, 200, { ok: true, user: { name, admin: true } });
    });
  }

  if (p === "/login" && m === "POST") {
    if (NO_AUTH) return json(res, 200, { ok: true, user: currentUser(req) });
    const ip = clientIp(req);
    // 带着有效「已知设备」cookie 的请求不受按 IP 的硬限制（没配置 TRUSTED_PROXY_CIDRS 时，反向代理后面所有人共用一个 IP，
    // 别人试错 5 次不该把设备主人也锁在外面）；在途名额按设备计。按用户名的限制照旧（只对自己账户的已知设备豁免）。
    const dev = deviceOwner(req), ipSlot = dev ? "dev:" + sha(parseCookies(req)[DEV_COOKIE]) : "ip:" + ip;
    // 在途上限：同一 IP 同时最多 2 个登录在处理，多的直接 429（并发爆发不会全部进入校验）
    if (!takeSlot(ipSlot)) return json(res, 429, { error: "登录请求太频繁，请稍后再试" });
    let nameSlot = null;
    try {
      // 按 IP（硬限制）：先检查、再「占一个名额」，都在进入 scrypt 校验之前同步完成 —— 并发请求也会被一个个计上
      const ipList = ipFails.of(ip);
      if (!dev && ipList.length >= FAIL_MAX) {
        const wait = Math.ceil((ipList[0] + FAIL_WINDOW - Date.now()) / 60000);
        return json(res, 429, { error: "尝试次数过多，请 " + wait + " 分钟后再试" });
      }
      if (!dev) ipFails.add(ip); // 先记，成功后再清零
      const b = await readBody(req);
      const name = String(b.name || "").trim(), nk = nameKey(name), u = findUser(name);
      // 按用户名（和 IP 无关，换 IP 也绕不过去）：只影响这一个用户名。
      // 内网地址、或带着这个账户「已知设备」cookie 的请求不受硬封禁（只保留逐步变慢）—— 别人锁不住账户主人。
      const trusted = lanClient(req) || knownDevice(req, u);
      const nList = nameFails.of(nk);
      if (!trusted) {
        if (nList.length >= NAME_MAX) {
          const wait = Math.ceil((nList[0] + NAME_WINDOW - Date.now()) / 60000);
          return json(res, 429, { error: "这个账户尝试次数过多，请 " + wait + " 分钟后再试" });
        }
        if (!takeSlot("n:" + nk)) return json(res, 429, { error: "登录请求太频繁，请稍后再试" });
        nameSlot = "n:" + nk;
      }
      const slow = nList.length; // 占名额之前的次数
      const nameList = nameFails.add(nk), nameMark = nameList[nameList.length - 1];
      if (slow >= NAME_SLOW) await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * (slow - NAME_SLOW + 1)))); // 逐步变慢
      const ok = await verifyPassword(String(b.password || ""), u ? u.hash : DUMMY_HASH);
      if (!u || !ok) {
        log("login failed", ip, JSON.stringify(name.slice(0, 40)) + (trusted ? " (trusted)" : ""));
        return json(res, 401, { error: "用户名或密码不正确", left: Math.max(0, FAIL_MAX - ipFails.of(ip).length) });
      }
      if (!dev) ipFails.clear(ip);
      // 受信任的登录（内网 / 已知设备）只撤回自己这一次，不替别人解锁；普通登录成功即清零
      if (trusted) nameFails.drop(nk, nameMark); else nameFails.clear(nk);
      const verified = u.hash;
      return await withAccountsLock(async () => {
        // 校验密码期间账户被删除 / 密码被改：这次登录作废（不能让已撤销的凭据换到新会话）
        if (!users.users.includes(u) || u.hash !== verified) return json(res, 401, { error: "用户名或密码不正确" });
        setCookie(req, res, newSession(u.name));
        await rememberDevice(req, res, u);
        return json(res, 200, { ok: true, user: { name: u.name, admin: !!u.admin } });
      });
    } finally {
      releaseSlot(ipSlot);
      if (nameSlot) releaseSlot(nameSlot);
    }
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

  if (p === "/config/stash" && m === "POST") { // 冲突时选「使用服务器版」：先把本机版本存成一份快照（不改当前配置），随时能从「恢复较早的版本」找回
    const b = await readBody(req);
    if (!validConfig(b.data)) return json(res, 400, { error: "配置格式不正确" });
    const ae = aliasesError(b.data) || spacesError(b.data);
    if (ae) return json(res, 400, ae);
    const r = await withUserLock(me.name, async () => {
      assertAlive(me, req);
      const cur = readConfig(me.name);
      const unsafe = await newUnsafeUrls(me.name, b.data, cur);
      if (unsafe.length) throw unsafeError(unsafe);
      await addBackup(me.name, { version: +b.baseVersion || 0, updatedAt: new Date().toISOString(), data: b.data }, "local");
      return { ok: true };
    });
    return json(res, 200, r);
  }

  if (p === "/config/backups" && m === "GET") { // 环形备份列表（新的在前）：[{id, version, updatedAt, at, groups, items}]
    return json(res, 200, await withUserLock(me.name, () => backupSummaries(me.name)));
  }

  if (p === "/config") {
    if (m === "GET" && url.searchParams.get("prev") === "1") { // 最近一次被覆盖掉的版本（环形备份里最新的一份）
      const prev = await withUserLock(me.name, () => latestBackup(me.name));
      return prev ? json(res, 200, publicDoc(prev)) : json(res, 404, { error: "没有可恢复的服务器版本" });
    }
    if (m === "GET" && url.searchParams.has("backup")) { // 环形备份里的某一份（设置 → 账户 →「恢复较早的版本」）
      const d = await withUserLock(me.name, () => readBackup(me.name, String(url.searchParams.get("backup"))));
      return d ? json(res, 200, d) : json(res, 404, { error: "这个版本已经不在了" });
    }
    if (m === "GET") {
      const doc = await withUserLock(me.name, async () => {
        const d = readConfig(me.name);
        return d.data && await migrateData(me.name, d.data) ? writeConfig(me.name, d.data) : d;
      });
      return json(res, 200, publicDoc(doc));
    }
    if (m === "PUT") {
      /* 乐观并发：body = {baseVersion, data, opId?, force?, expectVersion?, restore?}
       *  - opId：客户端给每次推送的标识。服务器记住最近 OPS_KEEP 个已接受的 opId → 重复推送（keepalive 已成功但客户端没收到回应、
       *    下次打开又补推）直接返回当时的版本号，不产生新版本、不算冲突。
       *  - baseVersion 和服务器当前版本对不上（另一台设备在这之间改过）→ 409 + 服务器版本信息，不写入。
       *  - 用户明确选择「用本机版覆盖」：force:true + expectVersion（409 里拿到的服务器版本）。锁内再核对一次，
       *    一致才先把服务器当前版本存成快照、再写入；又变了就再 409，让用户重新确认。
       *  - 内容与服务器当前版本相同：不算冲突、不升版本。 */
      const b = await readBody(req); // 读请求体不占锁
      if (!validConfig(b.data)) return json(res, 400, { error: "配置格式不正确" });
      const ae = aliasesError(b.data) || spacesError(b.data);
      if (ae) return json(res, 400, ae);
      // baseVersion 必填：非负整数。缺失 / 不合法 → 400（不能靠省略它绕过冲突检测）
      if (!Number.isSafeInteger(b.baseVersion) || b.baseVersion < 0) return json(res, 400, { error: "缺少或不合法的 baseVersion", code: "bad_base_version" });
      const opId = typeof b.opId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(b.opId) ? b.opId : null;
      const inHash = dataHash(b.data); // 收到的内容指纹（迁移前算，和 opId 一起记下）
      const r = await withUserLock(me.name, async () => {
        assertAlive(me, req); // 账户刚被删除 / 会话已作废
        const cur = readConfig(me.name), curV = cur.version || 0;
        if (opId && Array.isArray(cur.ops)) {
          const hit = cur.ops.find((o) => o.id === opId);
          if (hit) {
            // 同一个 opId 只有内容也完全一样才算重复推送；旧记录没有指纹时用 hist 里那个版本的指纹核对，核对不了一律不认
            const h = hit.h || ((Array.isArray(cur.hist) && cur.hist.find((x) => x.v === hit.v)) || {}).h;
            if (h && h === inHash) return { version: hit.v, current: curV, updatedAt: cur.updatedAt, duplicate: true, unchanged: true };
            return { status: 422, error: "这个 opId 已用于另一份内容，未保存", code: "opid_mismatch", version: curV, unchanged: true };
          }
        }
        const unsafe = await newUnsafeUrls(me.name, b.data, cur);
        if (unsafe.length) throw unsafeError(unsafe);
        const mismatch = !!cur.data && b.baseVersion !== curV; // 服务器还没有配置时（首次同步 / 数据目录被清空）任何版本号都可以写
        // 旧版前端（没有 opId）的补推：内容是服务器早先接受过、后来又被别的设备改掉的旧版本 → 不写入，让它拉最新版（指纹只作辅助判断）
        if (!opId && b.replay === true && b.restore !== true && mismatch) {
          const h = dataHash(b.data);
          if (h !== currentHash(cur) && Array.isArray(cur.hist) && cur.hist.some((x) => x.h === h)) {
            return { stale: true, version: curV, updatedAt: cur.updatedAt, unchanged: true };
          }
        }
        const sp = reconcileSpaces(b, cur); // 旧版前端保存时沿用服务器上的空间定义 + 清悬空引用（改了内容 → migrated，前端会重新拉取）
        const spFix = sp.kept || sp.pruned > 0, spInfo = spFix ? { migrated: true, ...(sp.kept ? { spacesKept: true } : {}), ...(sp.pruned ? { spacesPruned: sp.pruned } : {}) } : {};
        const same = () => cur.data && (JSON.stringify(cur.data) === JSON.stringify(b.data) || dataHash(b.data) === currentHash(cur));
        if (same()) return { version: curV, updatedAt: cur.updatedAt, overwrote: false, unchanged: true, ...spInfo };
        const forced = mismatch && b.force === true && b.expectVersion != null && +b.expectVersion === curV;
        if (mismatch && !forced) {
          const groups = Array.isArray(cur.data.groups) ? cur.data.groups.length : 0;
          return { status: 409, error: "另一台设备在这之后改过配置，未覆盖", conflict: true, version: curV, updatedAt: cur.updatedAt,
            groups, items: allItems(cur.data).length, spaces: Array.isArray(cur.data.spaces) ? cur.data.spaces.length : 0, unchanged: true };
        }
        const migrated = await migrateData(me.name, b.data);
        if (migrated && same()) return { version: curV, updatedAt: cur.updatedAt, overwrote: false, unchanged: true, migrated: true, ...spInfo };
        // 快照：被强制覆盖 / 恢复较早的版本前，当前版本一定先存一份；普通保存按 30 分钟 / 20 个版本的节奏存
        if (cur.data) {
          if (forced) await addBackup(me.name, cur, "replaced");
          else if (b.restore === true) await addBackup(me.name, cur, "restore");
          else if (await snapshotDue(me.name, cur)) await addBackup(me.name, cur, "auto");
        }
        const doc = await writeConfig(me.name, b.data, opId, inHash);
        await cleanupIcons(me.name).catch((e) => log("icon cleanup", me.name, e.message));
        return { version: doc.version, updatedAt: doc.updatedAt, overwrote: forced, ...(forced ? { forced: true } : {}), ...(migrated ? { migrated: true } : {}), ...spInfo };
      });
      if (!r.unchanged) probeSoon();
      delete r.unchanged;
      const status = r.status || 200; delete r.status;
      return json(res, status, r);
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
      const ext = await withUserLock(me.name, () => { assertAlive(me, req); return storeWallpaper(me.name, buf); });
      const v = Date.now();
      return json(res, 200, { ok: true, v, type: WP_TYPES[ext], size: buf.length, url: "api/wallpaper?v=" + v });
    }
    if (m === "DELETE") { await withUserLock(me.name, () => { assertAlive(me, req); return removeWallpaper(me.name); }); return json(res, 200, { ok: true }); }
    return json(res, 405, { error: "Method Not Allowed" });
  }

  // 上传的图标：POST /api/icons（服务器生成 id）或 PUT /api/icons/<id>；GET / DELETE /api/icons/<id>
  if (p === "/icons" || p.startsWith("/icons/")) {
    const id = p === "/icons" ? "" : safeDecode(p.slice("/icons/".length));
    if (id == null) return json(res, 400, { error: "图标 id 编码不正确" });
    if ((m === "POST" && !id) || (m === "PUT" && id)) {
      if (id && !ICON_ID.test(id)) return json(res, 400, { error: "图标 id 不合法" });
      const ct = String(req.headers["content-type"] || "").toLowerCase();
      if (!/^image\/(jpeg|png|webp)\b/.test(ct)) return json(res, 415, { error: "需要 image/jpeg、image/png 或 image/webp（不支持 SVG）" });
      const buf = await readRaw(req, MAX_ICON);
      const nid = id || newIconId();
      const ext = await withUserLock(me.name, async () => { assertAlive(me, req); await checkIconQuota(me.name, nid, buf.length); return storeIcon(me.name, nid, buf); });
      return json(res, 200, { ok: true, id: nid, type: WP_TYPES[ext], size: buf.length, url: "api/icons/" + nid });
    }
    if (!ICON_ID.test(id)) return json(res, id ? 400 : 405, { error: id ? "图标 id 不合法" : "Method Not Allowed" });
    if (m === "GET" || m === "HEAD") {
      const f = findIcon(me.name, id);
      if (!f) return json(res, 404, { error: "图标不存在" });
      const etag = '"' + f.st.size.toString(36) + "-" + Math.round(f.st.mtimeMs).toString(36) + '"';
      const headers = { "Content-Type": WP_TYPES[f.ext], ETag: etag, Vary: "Cookie", "Cache-Control": "private, max-age=86400", "Content-Security-Policy": "default-src 'none'" };
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); return res.end(); }
      return send(res, 200, fs.readFileSync(f.file), headers);
    }
    if (m === "DELETE") { await withUserLock(me.name, () => { assertAlive(me, req); return removeIcon(me.name, id); }); return json(res, 200, { ok: true }); }
    return json(res, 405, { error: "Method Not Allowed" });
  }

  if (p === "/status" && m === "GET") return json(res, 200, statusFor(me.name));

  if (p === "/docker" && m === "GET") {
    // 容器清单只给管理员（普通账户不能枚举 NAS 上的全部容器）；前端拿到 403 就不显示「关联容器」
    if (!me.admin) return json(res, 403, { error: "需要管理员权限", available: false, containers: [] });
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
    const b = await readBody(req);
    if (!validPass(b.password)) return json(res, 400, { error: "新" + PASS_MSG });
    return withAccountsLock(async () => {
      const u = findUser(me.name);
      if (!u) return json(res, 401, { error: "未登录" });
      if (!(await verifyPassword(String(b.old || ""), u.hash))) return json(res, 400, { error: "当前密码不正确" });
      u.hash = await hashPassword(b.password);
      revokeDevices(u); // 所有「已知设备」作废；当前这台刚验证过密码，重新发一个
      await rememberDevice(req, res, u); // 内含 saveUsers()
      await dropSessionsOf(u.name, req.sessionKey); // 其他设备需重新登录
      return json(res, 200, { ok: true });
    });
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
      if (!validPass(b.password)) return json(res, 400, { error: PASS_MSG });
      return withAccountsLock(async () => { // 查重 → 算哈希 → 写入 在同一把锁里：并发同名（不分大小写）只会成功一次
        if (findUser(name)) return json(res, 409, { error: "用户名已存在" });
        const hash = await hashPassword(b.password);
        if (findUser(name)) return json(res, 409, { error: "用户名已存在" });
        users.users.push({ name, admin: !!b.admin, hash, created: new Date().toISOString() });
        await saveUsers();
        return json(res, 200, { ok: true });
      });
    }
    const mm = p.match(/^\/users\/([^/]+)(\/password)?$/);
    if (mm) {
      const tn = safeDecode(mm[1]);
      if (tn == null) return json(res, 400, { error: "用户名编码不正确" });
      if (!findUser(tn)) return json(res, 404, { error: "用户不存在" });
      if (mm[2] && m === "POST") {
        const b = await readBody(req);
        if (!validPass(b.password)) return json(res, 400, { error: PASS_MSG });
        return withAccountsLock(async () => {
          const target = findUser(tn);
          if (!target) return json(res, 404, { error: "用户不存在" });
          target.hash = await hashPassword(b.password);
          revokeDevices(target);
          if (target.name === me.name) await rememberDevice(req, res, target); else await saveUsers();
          await dropSessionsOf(target.name, target.name === me.name ? req.sessionKey : undefined);
          return json(res, 200, { ok: true });
        });
      }
      if (!mm[2] && m === "DELETE") return withAccountsLock(async () => {
        const target = findUser(tn);
        if (!target) return json(res, 404, { error: "用户不存在" });
        if (target.name === me.name) return json(res, 400, { error: "不能删除自己" });
        revokeDevices(target); // 已知设备随用户一起作废（同名用户以后重建也不会继承）
        users.users = users.users.filter((u) => u !== target);
        await saveUsers();
        await dropSessionsOf(target.name);
        await withUserLock(target.name, async () => { // 锁顺序：账户锁 → 用户锁
          await fsp.rm(configFile(target.name), { force: true });
          await removeWallpaper(target.name);
          await fsp.rm(legacyBackupFile(target.name), { force: true });
          await fsp.rm(backupDir(target.name), { recursive: true, force: true });
          await fsp.rm(iconDir(target.name), { recursive: true, force: true });
          configCache.delete(configFile(target.name));
        });
        return json(res, 200, { ok: true });
      });
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
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : "服务器内部错误", ...(e.status && e.invalid ? { invalid: e.invalid } : {}) });
    else res.destroy();
  }
});

function main() {
  ensureDirs();
  loadState();
  migrateAll().catch((e) => log("migrate", e.message));
  server.listen(PORT, HOST, () => {
    log(`夜曲 Nocturne v${VERSION} 已启动 http://${HOST}:${PORT}  data=${DATA_DIR}  auth=${NO_AUTH ? "off" : "on"}  users=${users.users.length}  trusted-proxies=${trustedProxies().list.join(",") || "none"}`);
    if (!NO_AUTH && !users.users.length) log("尚未创建账户：打开网页创建管理员");
  });
  runProbes(false);
  setInterval(() => runProbes(false), STATUS_INTERVAL).unref();
  setTimeout(sweepCache, 5000).unref();
  setInterval(sweepCache, 6 * 3600e3).unref();
  const stop = () => { log("shutting down"); saveSessions(true).finally(() => server.close(() => process.exit(0))); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
if (require.main === module) main();
else module.exports = { // 供 test/ 下的单元测试使用；作为程序运行时不导出
  normIp, parseCidrList, parseProbeAllow, probeAllowed, vetTarget, canonicalSearch, validPass, PASS_MIN, clientInfo, forwardedProto, legacyKey,
};
