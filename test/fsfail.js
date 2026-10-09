"use strict";
/* 测试用的文件系统故障注入（只在测试里通过 NODE_OPTIONS=--require 预加载到 server.js 子进程；不进镜像逻辑、server.js 不引用它）。
 * FSFAIL_CTL=<控制文件>：每次 open / rename 时现读，所以测试可以在服务器运行中途打开 / 关闭故障。每行一条规则：
 *   <模式> <正则>     正则匹配 open / rename 的路径（源路径）
 * 模式：
 *   enospc   打开成功，writeFile 只写进一半内容后抛 ENOSPC（磁盘满：临时文件里留下半截内容）
 *   partial  同上但抛 EIO（写到一半出错）
 *   open     open 直接抛 ENOSPC（连临时文件都建不出来）
 *   rename   rename 抛 ENOSPC（临时文件完整写好了，但换不上去）
 *   read_eacces / read_eio / read_enoent  readFileSync 抛读取错误
 *   stat_eacces / stat_eio  statSync / lstatSync 抛读取错误
 *   corrupt_before_sync 临时文件写完后、sync 前损坏对应目标，验证提交前复核
 *   corrupt_auth_before_sync 同一时机损坏配置所属目录的 users.json
 *   delay_rename_result rename 已成功后延迟 Promise 返回，放大自写入基准更新窗口
 * 空文件 / 文件不存在 = 不注入。 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const CTL = process.env.FSFAIL_CTL;
const origRead = fs.readFileSync, origStat = fs.statSync, origLstat = fs.lstatSync, origRenameSync = fs.renameSync;

function rules() {
  if (!CTL) return [];
  let txt; try { txt = origRead.call(fs, CTL, "utf8"); } catch (e) { return []; }
  return txt.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(" "); return { mode: l.slice(0, i), re: new RegExp(l.slice(i + 1)) }; });
}
const hit = (p, modes) => rules().find((r) => modes.includes(r.mode) && r.re.test(String(p)));
function err(code, syscall, p) {
  const e = new Error(code + ": injected failure, " + syscall + " '" + p + "'");
  e.code = code; e.syscall = syscall; e.path = String(p); e.errno = code === "ENOSPC" ? -28 : -5;
  return e;
}

const origOpen = fsp.open, origRename = fsp.rename;
const origOpenSync = fs.openSync, origWriteSync = fs.writeSync, origSync = fs.fsyncSync, origClose = fs.closeSync;
const origRm = fs.rmSync;
const fdPaths = new Map();
function consume(r) {
  if (!r || !r.mode.startsWith("once_")) return;
  fs.writeFileSync(CTL, rules().filter(x => x.mode !== r.mode || x.re.source !== r.re.source).map(x => x.mode + " " + x.re.source).join("\n"));
}
function renameFault(a) {
  const r = hit(a, ["rename", "once_rename", "kill_rename", "after_rename_throw", "kill_after_rename", "rollback_failure"]);
  consume(r);
  if (r && r.mode === "rollback_failure") { fs.writeFileSync(CTL, "rename users\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n"); throw err("EIO", "rename", a); }
  if (r && r.mode === "kill_rename") process.kill(process.pid, "SIGKILL");
  if (r && ["rename", "once_rename"].includes(r.mode)) throw err("ENOSPC", "rename", a);
  return r;
}
fs.openSync = function(p, flags, ...args) {
  const r = hit(p, ["sync_open", "once_sync_open"]); consume(r);
  if (r) throw err("ENOSPC", "open", p);
  const fd = origOpenSync.call(this, p, flags, ...args); fdPaths.set(fd, String(p)); return fd;
};
fs.writeSync = function(fd, buf, ...args) {
  const p = fdPaths.get(fd), r = hit(p, ["sync_partial", "once_sync_partial"]); consume(r);
  if (r) { origWriteSync.call(this, fd, buf.subarray(0, Math.floor(buf.length / 2))); throw err("EIO", "write", p); }
  return origWriteSync.call(this, fd, buf, ...args);
};
fs.fsyncSync = function(fd) {
  const p = fdPaths.get(fd), r = hit(p, ["sync_fsync", "once_sync_fsync", "corrupt_before_sync", "corrupt_auth_before_sync"]); consume(r);
  if (r && r.mode.endsWith("sync_fsync")) throw err("EIO", "fsync", p);
  if (r) {
    const target = String(p).replace(/\.\d{1,10}\.[0-9a-f]{8}\.tmp$/, "");
    fs.writeFileSync(r.mode === "corrupt_auth_before_sync" ? path.join(path.dirname(path.dirname(target)), "users.json") : target, "{injected-corrupt");
  }
  return origSync.call(this, fd);
};
fs.closeSync = function(fd) { fdPaths.delete(fd); return origClose.call(this, fd); };
fs.rmSync = function(p, ...args) { const r = hit(p, ["sync_rm", "once_sync_rm"]); consume(r); if (r) throw err("EACCES", "rm", p); return origRm.call(this, p, ...args); };
fs.readFileSync = function (p, ...args) {
  const r = hit(p, ["read_eacces", "read_eio", "read_enoent"]);
  if (r) throw err(r.mode === "read_eacces" ? "EACCES" : r.mode === "read_enoent" ? "ENOENT" : "EIO", "read", p);
  return origRead.call(this, p, ...args);
};
for (const [key, original] of [["statSync", origStat], ["lstatSync", origLstat]]) fs[key] = function (p, ...args) {
  const r = hit(p, ["stat_eacces", "stat_eio"]);
  if (r) throw err(r.mode === "stat_eacces" ? "EACCES" : "EIO", "stat", p);
  return original.call(this, p, ...args);
};
fsp.open = async function (p, flags, mode) {
  const r = hit(p, ["enospc", "partial", "open", "corrupt_before_sync", "corrupt_auth_before_sync"]);
  if (r && r.mode === "open") throw err("ENOSPC", "open", p);
  const fh = await origOpen.call(this, p, flags, mode);
  if (!r) return fh;
  return new Proxy(fh, {
    get(t, k) {
      if (k === "sync" && ["corrupt_before_sync", "corrupt_auth_before_sync"].includes(r.mode)) return async () => {
        const target = String(p).replace(/\.\d{1,10}\.[0-9a-f]{8}\.tmp$/, "");
        if (target === String(p)) throw new Error("sync corruption must target an atomic temporary file");
        fs.writeFileSync(r.mode === "corrupt_auth_before_sync" ? path.join(path.dirname(path.dirname(target)), "users.json") : target, "{injected-corrupt");
        return t.sync();
      };
      if (k === "writeFile" && !["corrupt_before_sync", "corrupt_auth_before_sync"].includes(r.mode)) {
        return async (data) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
          await t.write(buf.subarray(0, Math.floor(buf.length / 2)));
          throw err(r.mode === "enospc" ? "ENOSPC" : "EIO", "write", p);
        };
      }
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
};
fsp.rename = async function (a, b) {
  if (hit(a, ["rename"])) throw err("ENOSPC", "rename", a);
  const out = await origRename.call(this, a, b);
  if (hit(a, ["delay_rename_result"])) await new Promise(r => setTimeout(r, 200));
  return out;
};
fs.renameSync = function (a, b) {
  const r = renameFault(a), out = origRenameSync.call(this, a, b);
  if (r && r.mode === "after_rename_throw") throw err("EIO", "rename-result", a);
  if (r && r.mode === "kill_after_rename") process.kill(process.pid, "SIGKILL");
  return out;
};
