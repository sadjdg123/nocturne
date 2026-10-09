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
  const retiredName = /^\.auth-done\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/;
  const receiptName = /^\.auth-cleanup\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
  const metadata = /^(RECORD\.json|DONE|COMMITTED)(\.\d+\.[0-9a-f]{8}\.tmp)?$/;
  function inventory(dir) {
    const entries = [];
    const s = stat(dir); if (!s || !s.isDirectory() || s.isSymbolicLink()) throw fail();
    function walk(f, rel) {
      const s = stat(f); if (!s || s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) throw fail();
      if (rel) entries.push(s.isDirectory() ? { rel, dir: true } : { rel, dir: false, sha256: hash(read(f)) });
      if (s.isDirectory()) for (const n of fs.readdirSync(f).sort()) walk(path.join(f, n), rel ? rel + "/" + n : n);
    }
    walk(dir, ""); return entries;
  }
  function receiptFile(n) { return path.join(root, ".auth-cleanup." + n.match(retiredName)[1] + ".json"); }
  function certify(n) {
    const dir = path.join(root, n), { r, committed } = record(dir);
    const done = committed ? "committed\n" : "rolled-back\n";
    if (read(path.join(dir, "DONE"))?.toString() !== done) throw fail();
    // 旧版完整退休目录也必须先核验来源和资产；不能仅凭目录名授权删除。
    for (const child of fs.readdirSync(dir)) {
      if (child === "assets") continue;
      const m = child.match(metadata); if (!m) throw fail();
      if (m[2]) {
        const expected = m[1] === "RECORD.json" ? read(path.join(dir, "RECORD.json")) : Buffer.from(m[1] === "DONE" ? done : "committed\n");
        const got = read(path.join(dir, child));
        // 强杀可留下尚未写完的原子临时文件；仅接纳已知元数据的字节前缀。
        if (!got || got.length > expected.length || !got.equals(expected.subarray(0, got.length))) throw fail();
      }
    }
    for (const child of fs.readdirSync(path.join(dir, "assets"))) {
      if (!/^(0|[1-9]\d*)$/.test(child)) throw fail();
      const v = r.assets[Number(child)];
      if (!committed || !v?.id || !same(path.join(dir, "assets", child), v.id)) throw fail();
    }
    const payload = JSON.stringify({ format: 1, retired: n, entries: inventory(dir) });
    write(receiptFile(n), Buffer.from(JSON.stringify({ payload, sha256: hash(payload) })));
  }
  function verifyRetired(n) {
    const envelope = JSON.parse(read(receiptFile(n)).toString("utf8"));
    if (typeof envelope.payload !== "string" || envelope.sha256 !== hash(envelope.payload)) throw fail();
    const r = JSON.parse(envelope.payload), expected = new Map();
    if (r.format !== 1 || r.retired !== n || !Array.isArray(r.entries)) throw fail();
    for (const e of r.entries) {
      if (typeof e.rel !== "string" || e.rel.split("/").some(p => !p || p === "." || p === ".." || /[\\\0]/.test(p)) ||
          typeof e.dir !== "boolean" || (!e.dir && !/^[0-9a-f]{64}$/.test(e.sha256)) || expected.has(e.rel)) throw fail();
      const [top] = e.rel.split("/");
      if (top !== "assets" && (!metadata.test(top) || e.rel !== top || e.dir)) throw fail();
      if (e.rel.includes("/") && expected.get(e.rel.slice(0, e.rel.lastIndexOf("/")))?.dir !== true) throw fail();
      expected.set(e.rel, e);
    }
    if (!expected.get("assets")?.dir || expected.get("RECORD.json")?.dir !== false || expected.get("DONE")?.dir !== false) throw fail();
    const dir = path.join(root, n);
    // 只允许已认证清单的子集：文件可缺失，剩余文件不可替换，也不可加入链接/额外数据。
    if (stat(dir)) for (const e of inventory(dir)) {
      const want = expected.get(e.rel);
      if (!want || want.dir !== e.dir || (!e.dir && want.sha256 !== e.sha256)) throw fail();
    }
  }
  function cleanRetired(n) {
    verifyRetired(n); // 核验错误不属于可忽略的清理失败。
    try {
      const dir = path.join(root, n);
      if (stat(dir)) fs.rmSync(dir, { recursive: true });
      syncDir(root); // 先持久化目录消失，才能移除目录外的凭据。
      fs.unlinkSync(receiptFile(n)); syncDir(root);
    } catch { return { cleanupPending: true }; }
    return { cleanupPending: false };
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
    const n = ".auth-done." + crypto.randomUUID() + ".tmp", retired = path.join(root, n);
    fs.renameSync(journal, retired); syncDir(root);
    certify(n); // 首次递归删除前，持久化不会随退休目录一起删除的来源凭据。
    return cleanRetired(n);
  }
  function recover() {
    try {
      const names = fs.readdirSync(root), retired = new Set(names.filter(n => retiredName.test(n)));
      for (const f of names.filter(n => receiptName.test(n))) retired.add(".auth-done." + f.match(receiptName)[1] + ".tmp");
      for (const n of retired) {
        if (!stat(receiptFile(n))) certify(n);
        cleanRetired(n); // 凭据存在时允许重复清理，不重放过时认证状态。
      }
    } catch { throw fail(); }
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
