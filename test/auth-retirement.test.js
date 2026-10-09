"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { ROOT, startServer, client } = require("./helpers");
const CODE = process.env.NOCTURNE_AUTH_RETIREMENT_ROOT || ROOT, PRELOAD = path.join(__dirname, "auth-retirement-fault.js");
function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nc-retirement-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function children(d) { return fs.readdirSync(d).filter(n => n.startsWith(".auth-done.") || /^\.auth-cleanup\..*\.json$/.test(n)); }
function state(d) { return ["users.json", "sessions.json"].map(n => fs.readFileSync(path.join(d, n), "utf8")); }
const SCRIPT = `
const fs=require('node:fs'),path=require('node:path');const [d,code,action]=process.argv.slice(1);
const {createAuthStore}=require(path.join(code,'auth-store.js'));const validate={users:v=>v&&Array.isArray(v.users),sessions:v=>v&&typeof v==='object'};
const store=createAuthStore(d,validate);
if(action==='commit'){
 fs.writeFileSync(path.join(d,'users.json'),JSON.stringify({users:[{name:'admin'},{name:'bob'}]}));fs.writeFileSync(path.join(d,'sessions.json'),'{}');
 for(const n of ['config','backup','icons','spaces-guard','wallpapers'])fs.mkdirSync(path.join(d,n),{recursive:true});
 fs.writeFileSync(path.join(d,'config/bob.json'),'original-config');fs.mkdirSync(path.join(d,'icons/bob'));fs.mkdirSync(path.join(d,'icons/bob/nested'));fs.writeFileSync(path.join(d,'icons/bob/a.svg'),'icon-a');fs.writeFileSync(path.join(d,'icons/bob/nested/b.svg'),'icon-b');
 try{console.log(JSON.stringify({result:store.commit({users:[{name:'admin'}]},{token:{user:'admin'}},'bob')}));}catch(e){console.log(JSON.stringify({error:{storage:e.storage,status:e.status,committed:e.committed}}));process.exitCode=2;}
}else{try{store.recover();console.log('recovered');}catch(e){console.error(e.stack);process.exitCode=2;}}
`;
function run(d, action, ctl) { return spawnSync(process.execPath, [...(ctl ? ["--require", PRELOAD] : []), "-e", SCRIPT, d, CODE, action], { encoding: "utf8", timeout: 10000, env: { ...process.env, ...(ctl ? { AUTH_RETIREMENT_CTL: ctl } : {}) } }); }
function seeded(t, mode = "hold", target = "none") {
  const d = temp(t), ctl = path.join(temp(t), "control"); fs.writeFileSync(ctl, JSON.stringify({ mode, target })); const r = run(d, "commit", ctl);
  assert.ok(fs.existsSync(ctl + ".hit"), "故障必须真实触发");
  if (mode.includes("kill")) assert.equal(r.signal, "SIGKILL", r.stderr);
  else if (["receipt_write", "receipt_sync", "receipt_dirsync", "receipt_read"].includes(mode)) { assert.equal(r.status, 2, r.stdout); assert.equal(JSON.parse(r.stdout).error.storage, true); }
  else { assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout).result, { cleanupPending: true }); }
  return { d, ctl, r };
}
for (const mode of ["eio", "kill"]) for (const target of ["RECORD.json", "DONE", "COMMITTED", "assets/0", "assets/3/nested/b.svg", "assets/3/nested", "assets", "all", "directory"]) {
  test("退休部分删除 " + mode + " / " + target + " 后新进程恢复", t => {
    const { d } = seeded(t, mode, target), before = state(d);
    const r = run(d, "recover"); assert.equal(r.status, 0, r.stderr); assert.deepEqual(state(d), before); assert.deepEqual(children(d), []);
    assert.equal(fs.existsSync(path.join(d, "config/bob.json")), false); assert.equal(fs.existsSync(path.join(d, "icons/bob")), false);
    assert.equal(run(d, "recover").status, 0, "清理后的恢复可重复");
  });
}
for (const mode of ["retire_kill", "receipt_kill", "receipt_write", "receipt_sync", "receipt_dirsync", "receipt_read", "receipt_unlink", "receipt_unlink_kill", "cleanup_sync"]) test("退休清理凭据边界 " + mode, t => {
  const { d } = seeded(t, mode), before = state(d); const r = run(d, "recover"); assert.equal(r.status, 0, r.stderr); assert.deepEqual(state(d), before); assert.deepEqual(children(d), []);
});
for (const target of ["RECORD.json", "DONE", "all"]) test("已回退事务的部分退休清理 " + target, t => {
  const d = temp(t), ctl = path.join(temp(t), "control"); fs.writeFileSync(ctl, JSON.stringify({ mode: "eio", target, rollback: true }));
  const r = run(d, "commit", ctl); assert.equal(r.status, 2, r.stderr); assert.deepEqual(JSON.parse(r.stdout).error, {}); assert.ok(fs.existsSync(ctl + ".hit"));
  assert.deepEqual(JSON.parse(state(d)[0]), { users: [{ name: "admin" }, { name: "bob" }] }); assert.equal(fs.readFileSync(path.join(d, "config/bob.json"), "utf8"), "original-config");
  const before = state(d); assert.equal(run(d, "recover").status, 0); assert.deepEqual(state(d), before); assert.deepEqual(children(d), []); assert.equal(fs.readFileSync(path.join(d, "icons/bob/nested/b.svg"), "utf8"), "icon-b");
});
test("复制带部分退休材料和凭据的完整数据后恢复", t => {
  const { d } = seeded(t, "eio", "RECORD.json"), copy = temp(t); fs.cpSync(d, copy, { recursive: true }); const before = state(copy);
  assert.equal(run(copy, "recover").status, 0); assert.deepEqual(state(copy), before); assert.deepEqual(children(copy), []);
});
test("停写完整归档及恢复工具保留部分退休材料的清理凭据", t => {
  const { d } = seeded(t, "eio", "RECORD.json"), out = temp(t), target = path.join(temp(t), "restored"), before = state(d);
  // 唯一写入子进程已退出；仅对合成目录执行真实 shell 归档/校验/恢复，不调用 Docker。
  const backup = spawnSync("sh", [path.join(CODE, "tools/backup.sh"), "-o", out, d], { encoding: "utf8", timeout: 20000 }); assert.equal(backup.status, 0, backup.stderr);
  const archive = path.join(out, fs.readdirSync(out).find(n => n.endsWith(".tar.gz")));
  const restore = spawnSync("sh", [path.join(CODE, "tools/restore.sh"), archive, target], { encoding: "utf8", timeout: 20000 }); assert.equal(restore.status, 0, restore.stderr);
  assert.ok(fs.readdirSync(target).some(n => n.startsWith(".auth-cleanup."))); assert.equal(run(target, "recover").status, 0); assert.deepEqual(state(target), before); assert.deepEqual(children(target), []);
});
test("旧版完整退休材料无凭据可安全认证并清理", t => {
  const { d } = seeded(t); for (const n of fs.readdirSync(d).filter(n => n.startsWith(".auth-cleanup."))) fs.unlinkSync(path.join(d, n));
  assert.equal(run(d, "recover").status, 0); assert.deepEqual(children(d), []);
});
for (const value of ["committed\n", "comm"]) test("退休前中断的已知元数据临时文件 " + JSON.stringify(value), t => {
  const { d } = seeded(t), n = fs.readdirSync(d).find(n => n.startsWith(".auth-done."));
  for (const f of fs.readdirSync(d).filter(f => f.startsWith(".auth-cleanup."))) fs.unlinkSync(path.join(d, f));
  fs.writeFileSync(path.join(d, n, "COMMITTED.123.0123abcd.tmp"), value);
  assert.equal(run(d, "recover").status, 0); assert.deepEqual(children(d), []);
});
test("旧退休材料清理不重放更晚提交的认证状态", t => {
  const { d } = seeded(t, "eio", "DONE"), { createAuthStore } = require(path.join(CODE, "auth-store.js"));
  createAuthStore(d, { users: v => v && Array.isArray(v.users), sessions: v => v && typeof v === "object" }).commit({ users: [{ name: "admin", hash: "later-password" }] }, { later: { user: "admin" } });
  const before = state(d); assert.equal(run(d, "recover").status, 0); assert.deepEqual(state(d), before); assert.deepEqual(children(d), []);
});
for (const damage of ["unknown", "foreign_file", "symlink_dir", "symlink_file", "symlink_asset", "extra", "changed", "receipt_corrupt", "receipt_symlink", "receipt_forged_path", "legacy_partial", "unknown_temp"]) test("不确认来源或内容时保留并阻断 " + damage, t => {
  const { d } = seeded(t), n = fs.readdirSync(d).find(n => n.startsWith(".auth-done.")), dir = path.join(d, n), receipt = fs.readdirSync(d).find(n => n.startsWith(".auth-cleanup."));
  const other = temp(t); fs.writeFileSync(path.join(other, "keep"), "foreign-data");
  if (damage === "unknown") { fs.rmSync(dir, { recursive: true }); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "foreign"), "foreign-data"); fs.unlinkSync(path.join(d, receipt)); }
  if (damage === "foreign_file") { fs.rmSync(dir, { recursive: true }); fs.writeFileSync(dir, "foreign-data"); }
  if (damage === "symlink_dir") { fs.rmSync(dir, { recursive: true }); fs.symlinkSync(other, dir); }
  if (damage === "symlink_file") { fs.unlinkSync(path.join(dir, "RECORD.json")); fs.symlinkSync(path.join(other, "keep"), path.join(dir, "RECORD.json")); }
  if (damage === "symlink_asset") { fs.unlinkSync(path.join(dir, "assets/3/a.svg")); fs.symlinkSync(path.join(other, "keep"), path.join(dir, "assets/3/a.svg")); }
  if (damage === "extra") fs.writeFileSync(path.join(dir, "assets/3/foreign"), "foreign-data");
  if (damage === "changed") fs.writeFileSync(path.join(dir, "assets/3/a.svg"), "foreign-data");
  if (damage === "receipt_corrupt") fs.writeFileSync(path.join(d, receipt), "{bad");
  if (damage === "receipt_symlink") { fs.unlinkSync(path.join(d, receipt)); fs.symlinkSync(path.join(other, "keep"), path.join(d, receipt)); }
  if (damage === "receipt_forged_path") {
    const f = path.join(d, receipt), e = JSON.parse(fs.readFileSync(f)); const r = JSON.parse(e.payload); r.entries.push({ rel: "../foreign", dir: false, sha256: "0".repeat(64) });
    e.payload = JSON.stringify(r); e.sha256 = crypto.createHash("sha256").update(e.payload).digest("hex"); fs.writeFileSync(f, JSON.stringify(e));
  }
  if (damage === "legacy_partial") { fs.unlinkSync(path.join(dir, "RECORD.json")); fs.unlinkSync(path.join(d, receipt)); }
  if (damage === "unknown_temp") { fs.unlinkSync(path.join(d, receipt)); fs.writeFileSync(path.join(dir, "COMMITTED.123.0123abcd.tmp"), "foreign-data"); }
  const before = state(d), names = fs.readdirSync(d); const r = run(d, "recover");
  assert.equal(r.status, 2, "无法确认的材料必须阻断启动"); assert.deepEqual(state(d), before); assert.deepEqual(fs.readdirSync(d), names); assert.equal(fs.readFileSync(path.join(other, "keep"), "utf8"), "foreign-data");
});
test("重启清理再次 EIO 后第三次重启仍可完成", t => {
  const { d, ctl } = seeded(t, "eio", "RECORD.json"), before = state(d);
  // 第二次删除 DONE，第三次启动仍不依赖已删除的目录内标记。
  fs.writeFileSync(ctl, JSON.stringify({ mode: "hold", target: "DONE" })); const r = run(d, "recover", ctl); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(state(d), before); assert.ok(children(d).length); assert.equal(run(d, "recover").status, 0); assert.deepEqual(children(d), []);
});
test("重启清理再次 SIGKILL 后第三次重启仍可完成", t => {
  const { d, ctl } = seeded(t, "eio", "RECORD.json"), before = state(d);
  fs.writeFileSync(ctl, JSON.stringify({ mode: "kill", target: "DONE" })); const r = run(d, "recover", ctl); assert.equal(r.signal, "SIGKILL");
  assert.deepEqual(state(d), before); assert.equal(run(d, "recover").status, 0); assert.deepEqual(children(d), []);
});
for (const damage of ["record_missing", "assets_missing", "asset_changed", "marker_corrupt"]) test("活动事务仍严格核验 " + damage, t => {
  const { d } = seeded(t), n = fs.readdirSync(d).find(n => n.startsWith(".auth-done."));
  for (const f of fs.readdirSync(d).filter(f => f.startsWith(".auth-cleanup."))) fs.unlinkSync(path.join(d, f));
  const journal = path.join(d, ".auth-transaction"); fs.renameSync(path.join(d, n), journal);
  if (damage === "record_missing") fs.unlinkSync(path.join(journal, "RECORD.json"));
  if (damage === "assets_missing") fs.rmSync(path.join(journal, "assets"), { recursive: true });
  if (damage === "asset_changed") fs.writeFileSync(path.join(journal, "assets/3/a.svg"), "foreign-data");
  if (damage === "marker_corrupt") fs.writeFileSync(path.join(journal, "COMMITTED"), "unknown");
  const before = state(d); assert.equal(run(d, "recover").status, 2); assert.deepEqual(state(d), before); assert.ok(fs.existsSync(journal));
});
test("实际 HTTP 密码提交、部分清理失败、重启健康与 Cookie", async t => {
  const d = temp(t), ctl = path.join(temp(t), "control"); fs.writeFileSync(ctl, "");
  const s = await startServer({ root: CODE, dataDir: d, env: { NODE_OPTIONS: "--require=" + PRELOAD, AUTH_RETIREMENT_CTL: ctl } }); t.after(() => s.stop());
  const c = client(s.base); assert.equal((await c.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  fs.writeFileSync(ctl, JSON.stringify({ mode: "eio", target: "RECORD.json" })); const r = await c.post("/api/password", { old: "admin-pass-1", password: "changed-pass-12" });
  assert.equal(r.status, 200); assert.ok(r.setCookie.some(v => v.startsWith("nocturne_dev="))); assert.ok(fs.existsSync(ctl + ".hit")); await s.stop();
  const next = await startServer({ root: CODE, dataDir: d }); t.after(() => next.stop()); assert.equal((await client(next.base).get("/api/health")).status, 200);
  assert.equal((await client(next.base).post("/api/login", { name: "admin", password: "changed-pass-12" })).status, 200); assert.equal((await client(next.base).post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 401); assert.deepEqual(children(d), []);
});
