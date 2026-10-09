"use strict";
// 固定两份认证文件的小型撤销/重做记录。仅调用者的账户锁内使用；无生产故障开关。
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const hash = b => crypto.createHash("sha256").update(b).digest("hex");
function createAuthStore(root, validate) {
  const journal = path.join(root, ".auth-transaction");
  const fail = () => Object.assign(new Error("认证事务无法安全恢复，已阻断；请保留恢复目录"), { storage: true, status: 503, code: "storage_unavailable" });
  function stat(f) { try { return fs.lstatSync(f); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
  function syncDir(d) { const fd = fs.openSync(d, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  function read(f) { const s = stat(f); if (!s) return null; if (!s.isFile()) throw fail(); return fs.readFileSync(f); }
  function write(f, b, check) {
    const tmp = f + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    let own = false;
    try {
      const fd = fs.openSync(tmp, "wx", 0o600); own = true;
      try { let n = 0; while (n < b.length) { const k = fs.writeSync(fd, b, n, b.length - n); if (!k) throw fail(); n += k; } fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (check) check();
      fs.renameSync(tmp, f); syncDir(path.dirname(f));
    } finally { if (own && stat(tmp)) fs.unlinkSync(tmp); }
  }
  function assets(name) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(name) || name.includes("..")) throw fail();
    return ["config/" + name + ".json", "backup/" + name + ".json", "backup/" + name, "icons/" + name, "spaces-guard/" + name + ".json", ...["jpg", "png", "webp"].map(x => "wallpapers/" + name + "." + x)];
  }
  function assetHash(f) {
    const s = stat(f); if (!s || s.isSymbolicLink()) throw fail();
    if (s.isFile()) return hash(fs.readFileSync(f));
    if (!s.isDirectory()) throw fail();
    return hash(JSON.stringify(fs.readdirSync(f).sort().map(n => [n, assetHash(path.join(f, n))])));
  }
  function identity(f, s) { return { dir: s.isDirectory(), sha256: assetHash(f) }; }
  function same(f, id) { const s = stat(f); return s && !s.isSymbolicLink() && s.isDirectory() === id.dir && assetHash(f) === id.sha256; }
  function checkParents(rel) { const parent = path.join(root, path.dirname(rel)), s = stat(parent); if (!s || !s.isDirectory() || s.isSymbolicLink()) throw fail(); }
  function decode(v, key) {
    if (v === null) return null;
    if (typeof v !== "string" || Buffer.from(v, "base64").toString("base64") !== v) throw fail();
    const b = Buffer.from(v, "base64"); if (!validate[key](JSON.parse(b.toString("utf8")))) throw fail(); return b;
  }
  function record(dir = journal) {
    const s = stat(dir); if (!s || !s.isDirectory() || s.isSymbolicLink()) throw fail();
    const a = stat(path.join(dir, "assets")); if (!a || !a.isDirectory() || a.isSymbolicLink()) throw fail();
    const envelope = JSON.parse(read(path.join(dir, "RECORD.json")).toString("utf8"));
    if (typeof envelope.payload !== "string" || envelope.sha256 !== hash(envelope.payload)) throw fail();
    const r = JSON.parse(envelope.payload);
    if (r.format !== 1 || !r.old || !r.next || !Array.isArray(r.assets)) throw fail();
    for (const side of [r.old, r.next]) for (const k of ["users", "sessions"]) decode(side[k], k);
    if (r.next.users === null || r.next.sessions === null) throw fail();
    const allowed = r.deleteName === null ? [] : assets(r.deleteName);
    if (r.assets.length !== allowed.length || r.assets.some((v, i) => v.rel !== allowed[i] || (v.id !== null && (!/^[0-9a-f]{64}$/.test(v.id.sha256) || typeof v.id.dir !== "boolean")))) throw fail();
    const marker = read(path.join(dir, "COMMITTED"));
    if (marker && marker.toString() !== "committed\n") throw fail();
    return { r, committed: marker !== null };
  }
  function finish(r, committed, recovering = true) {
    if (!recovering) {
      const live = record();
      if (!live.committed || JSON.stringify(live.r) !== JSON.stringify(r)) throw fail();
    }
    for (const k of ["users", "sessions"]) {
      const got = read(path.join(root, k + ".json"));
      const expected = recovering ? [r.old[k], r.next[k]] : [r.next[k]];
      if (!expected.some(v => v === null ? got === null : got !== null && got.equals(decode(v, k)))) throw fail();
    }
    for (const [i, v] of r.assets.entries()) {
      checkParents(v.rel);
      const original = path.join(root, v.rel), saved = path.join(journal, "assets", String(i));
      const a = stat(original), b = stat(saved);
      if (v.id === null) { if (a || b) throw fail(); continue; }
      if (committed) {
        if (!recovering && (a || !b)) throw fail();
        if (a) { if (b || !same(original, v.id)) throw fail(); fs.renameSync(original, saved); syncDir(path.dirname(original)); syncDir(path.dirname(saved)); }
        else if (b && !same(saved, v.id)) throw fail();
      } else {
        if (b) { if (a || !same(saved, v.id)) throw fail(); fs.renameSync(saved, original); syncDir(path.dirname(original)); syncDir(path.dirname(saved)); }
        else if (!same(original, v.id)) throw fail();
      }
    }
    for (const k of ["users", "sessions"]) {
      const f = path.join(root, k + ".json"), want = decode((committed ? r.next : r.old)[k], k), got = read(f);
      if (!recovering && (got === null || !got.equals(want))) throw fail();
      if (want === null) { if (got !== null) { fs.unlinkSync(f); syncDir(root); } }
      else if (got === null || !got.equals(want)) write(f, want);
    }
    // 先持久化“无需再恢复”的退休名称，递归清理失败不破坏提交判断。
    write(path.join(journal, "DONE"), Buffer.from(committed ? "committed\n" : "rolled-back\n"));
    const retired = path.join(root, ".auth-done." + crypto.randomUUID() + ".tmp");
    fs.renameSync(journal, retired); syncDir(root);
    try { fs.rmSync(retired, { recursive: true }); syncDir(root); } catch (e) { return { cleanupPending: true }; }
    return { cleanupPending: false };
  }
  function recover() {
    for (const n of fs.readdirSync(root).filter(n => /^\.auth-done\.[0-9a-f-]{36}\.tmp$/.test(n))) {
      const dir = path.join(root, n), result = record(dir);
      if (read(path.join(dir, "DONE")).toString() !== (result.committed ? "committed\n" : "rolled-back\n")) throw fail();
      try { fs.rmSync(dir, { recursive: true }); syncDir(root); } catch { /* 已提交材料仍保留，不能撤销认证状态 */ }
    }
    if (!stat(journal)) return null;
    try { const { r, committed } = record(); return { committed, ...finish(r, committed) }; } catch (e) { throw fail(); }
  }
  function commit(nextUsers, nextSessions, deleteName = null) {
    if (stat(journal)) throw fail();
    const old = {}, next = {};
    for (const k of ["users", "sessions"]) {
      const b = read(path.join(root, k + ".json")); if (b && !validate[k](JSON.parse(b.toString("utf8")))) throw fail();
      old[k] = b === null ? null : b.toString("base64");
      const data = k === "users" ? nextUsers : nextSessions;
      if (!validate[k](data)) throw fail(); next[k] = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");
    }
    const r = { format: 1, old, next, deleteName, assets: deleteName === null ? [] : assets(deleteName).map(rel => {
      checkParents(rel); const f = path.join(root, rel), s = stat(f); if (s && !s.isFile() && !s.isDirectory()) throw fail(); return { rel, id: s ? identity(f, s) : null };
    }) };
    const preparing = path.join(root, ".auth-prepare." + crypto.randomUUID() + ".tmp");
    let published = false;
    try {
      fs.mkdirSync(preparing, { mode: 0o700 }); fs.mkdirSync(path.join(preparing, "assets"), { mode: 0o700 });
      const payload = JSON.stringify(r); write(path.join(preparing, "RECORD.json"), Buffer.from(JSON.stringify({ payload, sha256: hash(payload) })));
      syncDir(path.join(preparing, "assets")); syncDir(preparing);
      fs.renameSync(preparing, journal); published = true; syncDir(root);
      for (const [i, v] of r.assets.entries()) if (v.id) {
        const src = path.join(root, v.rel); if (!same(src, v.id)) throw fail();
        fs.renameSync(src, path.join(journal, "assets", String(i))); syncDir(path.dirname(src)); syncDir(path.join(journal, "assets"));
      }
      const expected = { ...old };
      const check = () => { for (const k of ["users", "sessions"]) {
        const got = read(path.join(root, k + ".json")), want = expected[k];
        if (want === null ? got !== null : got === null || !got.equals(decode(want, k))) throw fail();
      } };
      for (const k of ["users", "sessions"]) { check(); write(path.join(root, k + ".json"), decode(next[k], k), check); expected[k] = next[k]; }
      for (const k of ["users", "sessions"]) if (!read(path.join(root, k + ".json")).equals(decode(next[k], k))) throw fail();
      write(path.join(journal, "COMMITTED"), Buffer.from("committed\n"));
    } catch (e) {
      if (!published) { try { fs.rmSync(preparing, { recursive: true, force: true }); } catch {} throw e; }
      // 标记出现但耐久性步骤失败：不能声称未提交并回滚，保留材料且失败关闭。
      if (stat(path.join(journal, "COMMITTED"))) throw Object.assign(fail(), { committed: true });
      try { recover(); } catch { throw fail(); }
      throw e;
    }
    // 仅 finish 内已持久退休后的清理失败可降级；核验/写入/移动失败必须阻断并保留材料。
    try { return finish(r, true, false); } catch { throw Object.assign(fail(), { committed: true }); }
  }
  return { commit, recover, pending: () => !!stat(journal), journal };
}
module.exports = { createAuthStore };
