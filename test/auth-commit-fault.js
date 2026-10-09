"use strict";
// 专用测试 preload：只在 COMMITTED 的目录 fsync 成功后注入，限制为临时测试目录。
const fs = require("node:fs"), path = require("node:path");
const native = Object.fromEntries(["readFileSync", "writeFileSync", "renameSync", "openSync", "closeSync", "fsyncSync", "rmSync", "unlinkSync"].map(k => [k, fs[k]]));
const ctl = process.env.AUTH_BOUNDARY_CTL, fdPaths = new Map();
let root, journal, config, waitingMarker = false, waitingRetire = false, waitingCleanup = false;
let targetReads = 0;
const state = { armed: false, hits: 0, mode: null };
const error = () => Object.assign(new Error("EIO: injected post-COMMITTED boundary failure"), { code: "EIO" });
function receipt() { if (ctl) native.writeFileSync(ctl + ".hit", JSON.stringify(state)); }
function hit() { state.hits++; receipt(); }
function target() { return path.join(["COMMITTED", "RECORD.json"].includes(config.file) ? journal : root, config.file); }
fs.openSync = function(p, ...args) {
  if (state.armed && !state.hits && config.mode === "done_open" && path.dirname(String(p)) === journal && /^DONE\..*\.tmp$/.test(path.basename(String(p)))) { hit(); throw error(); }
  const fd = native.openSync.call(this, p, ...args); fdPaths.set(fd, String(p)); return fd;
};
fs.closeSync = function(fd) { fdPaths.delete(fd); return native.closeSync.call(this, fd); };
fs.readFileSync = function(p, ...args) {
  if (state.armed && !state.hits && config.mode === "read_eio" && String(p) === target()) { hit(); throw error(); }
  if (state.armed && !state.hits && config.mode === "late_mismatch" && String(p) === target() && ++targetReads === 2) {
    const r = JSON.parse(JSON.parse(native.readFileSync(path.join(journal, "RECORD.json"))).payload);
    native.writeFileSync(target(), Buffer.from(r.old[config.file.slice(0, -5)], "base64")); hit();
  }
  return native.readFileSync.call(this, p, ...args);
};
fs.renameSync = function(a, b) {
  if (state.armed && !state.hits && config.mode === "retire_rename" && String(a) === journal) { hit(); throw error(); }
  const result = native.renameSync.call(this, a, b);
  if (!state.armed && String(b).endsWith("/.auth-transaction/COMMITTED") && ctl) {
    try { config = JSON.parse(native.readFileSync(ctl, "utf8")); } catch { config = null; }
    if (config) {
      journal = path.dirname(String(b)); root = path.dirname(journal);
      if (!path.basename(root).startsWith("nc-boundary-")) throw new Error("fault injection requires synthetic temporary DATA_DIR");
      waitingMarker = true;
    }
  }
  if (state.armed && String(a) === journal) waitingRetire = true;
  return result;
};
fs.fsyncSync = function(fd) {
  if (state.armed && !state.hits && fdPaths.get(fd) === root &&
      ((config.mode === "retire_sync" && waitingRetire) || (config.mode === "cleanup_sync" && waitingCleanup))) { hit(); throw error(); }
  const result = native.fsyncSync.call(this, fd);
  if (waitingMarker && fdPaths.get(fd) === journal) {
    waitingMarker = false; state.armed = true; state.mode = config.mode; receipt();
    if (["missing", "mismatch", "corrupt", "marker_missing", "marker_corrupt", "record_corrupt"].includes(config.mode)) {
      const f = target();
      if (config.mode.endsWith("missing")) native.unlinkSync(f);
      else if (config.mode === "mismatch") {
        const r = JSON.parse(JSON.parse(native.readFileSync(path.join(journal, "RECORD.json"))).payload);
        native.writeFileSync(f, Buffer.from(r.old[config.file.slice(0, -5)], "base64"));
      } else native.writeFileSync(f, "{injected invalid state");
      hit();
    }
  }
  if (fdPaths.get(fd) === root) waitingRetire = false;
  return result;
};
fs.rmSync = function(p, ...args) {
  const retired = state.armed && path.dirname(String(p)) === root && /^\.auth-done\..*\.tmp$/.test(path.basename(String(p)));
  if (retired && !state.hits && config.mode === "cleanup_rm") { hit(); throw error(); }
  const result = native.rmSync.call(this, p, ...args);
  if (retired) waitingCleanup = true;
  return result;
};
module.exports = state;
