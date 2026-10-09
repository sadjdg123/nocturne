"use strict";
// 仅测试预加载：真实删除退休目录的一部分后抛 EIO 或 SIGKILL。
const fs = require("node:fs"), path = require("node:path");
const native = Object.fromEntries(["readFileSync", "writeFileSync", "rmSync", "unlinkSync", "renameSync", "openSync", "closeSync", "fsyncSync"].map(k => [k, fs[k].bind(fs)]));
const ctl = process.env.AUTH_RETIREMENT_CTL;
const fdPaths = new Map(); let receiptPublished = false, removed = false, rollbackFailed = false;
function rule() { try { return JSON.parse(native.readFileSync(ctl, "utf8")); } catch { return {}; } }
function eio() { return Object.assign(new Error("injected retirement EIO"), { code: "EIO" }); }
function hit(r, p) { native.writeFileSync(ctl + ".hit", JSON.stringify({ ...r, path: String(p) })); native.writeFileSync(ctl, ""); }
fs.readFileSync = function(p, ...args) {
  const r = rule();
  if (r.mode === "receipt_read" && /^\.auth-cleanup\..*\.json$/.test(path.basename(String(p)))) { hit(r, p); throw eio(); }
  return native.readFileSync(p, ...args);
};
fs.openSync = function(p, ...args) { const fd = native.openSync(p, ...args); fdPaths.set(fd, String(p)); return fd; };
fs.closeSync = function(fd) { fdPaths.delete(fd); return native.closeSync(fd); };
fs.fsyncSync = function(fd) {
  const r = rule(), p = fdPaths.get(fd);
  if ((r.mode === "receipt_sync" && /\.auth-cleanup\..*\.json\.\d+\.[0-9a-f]{8}\.tmp$/.test(p)) ||
      (r.mode === "receipt_dirsync" && receiptPublished) || (r.mode === "cleanup_sync" && removed)) { hit(r, p); throw eio(); }
  return native.fsyncSync(fd);
};
fs.rmSync = function(p, ...args) {
  const r = rule();
  if (r.mode && /^\.auth-done\.[0-9a-f-]{36}\.tmp$/.test(path.basename(String(p)))) {
    // 注入只可发生在合法持久退休材料上；使用原生读取避免干扰其他故障。
    if (r.mode !== "hold" && native.readFileSync(path.join(p, "DONE"), "utf8") !== (r.rollback ? "rolled-back\n" : "committed\n")) throw new Error("not completed retirement");
    if (["receipt_read", "receipt_sync", "receipt_dirsync", "receipt_write", "receipt_unlink", "receipt_unlink_kill"].includes(r.mode)) return native.rmSync(p, ...args);
    if (r.mode === "cleanup_sync") { const out = native.rmSync(p, ...args); removed = true; return out; }
    if (r.target === "all") for (const n of fs.readdirSync(p)) native.rmSync(path.join(p, n), { recursive: true });
    else if (r.target === "directory") native.rmSync(p, { recursive: true });
    else if (r.target !== "none") native.rmSync(path.join(p, r.target), { recursive: true });
    // SIGKILL 是真实子进程强杀，且删除已在目录 fsync 后发生。
    const fd = native.openSync(r.target === "directory" ? path.dirname(p) : p, "r"); native.fsyncSync(fd); native.closeSync(fd);
    hit(r, p);
    if (r.mode === "kill") process.kill(process.pid, "SIGKILL");
    throw eio();
  }
  return native.rmSync(p, ...args);
};
fs.renameSync = function(a, b) {
  const r = rule();
  if (r.rollback && !rollbackFailed && path.basename(String(b)) === "sessions.json") { rollbackFailed = true; throw eio(); }
  if (r.mode === "receipt_write" && /^\.auth-cleanup\..*\.json$/.test(path.basename(String(b)))) { hit(r, b); throw eio(); }
  const out = native.renameSync(a, b);
  if (/^\.auth-cleanup\..*\.json$/.test(path.basename(String(b)))) receiptPublished = true;
  if (r.mode === "retire_kill" && String(a).endsWith(".auth-transaction")) { hit(r, b); process.kill(process.pid, "SIGKILL"); }
  if (r.mode === "receipt_kill" && /^\.auth-cleanup\..*\.json$/.test(path.basename(String(b)))) { hit(r, b); process.kill(process.pid, "SIGKILL"); }
  return out;
};
fs.unlinkSync = function(p) {
  const r = rule();
  if (r.mode === "receipt_unlink" && /^\.auth-cleanup\..*\.json$/.test(path.basename(String(p)))) { hit(r, p); throw eio(); }
  const out = native.unlinkSync(p);
  if (r.mode === "receipt_unlink_kill" && /^\.auth-cleanup\..*\.json$/.test(path.basename(String(p)))) { hit(r, p); process.kill(process.pid, "SIGKILL"); }
  return out;
};
