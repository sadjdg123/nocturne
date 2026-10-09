"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const { ROOT, startServer, client } = require("./helpers");
const CODE = process.env.NOCTURNE_AUTH_BOUNDARY_ROOT || ROOT;
const PRELOAD = path.join(__dirname, "auth-commit-fault.js");
function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nc-boundary-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
const UNIT = `
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const [root,code,mode,file]=process.argv.slice(1),fault=require(${JSON.stringify(PRELOAD)});
const {createAuthStore}=require(path.join(code,'auth-store.js'));
const old={users:[{name:'admin',hash:'old'}]},next={users:[{name:'admin',hash:'new'}]},sessions={token:{user:'admin',expires:123}};
fs.writeFileSync(path.join(root,'users.json'),JSON.stringify(old));
// 明确覆盖首次提交旧 sessions 文件不存在时，finish 不能静默补写丢失文件。
if(!(mode==='missing'&&file==='sessions.json'))fs.writeFileSync(path.join(root,'sessions.json'),'{}');
const store=createAuthStore(root,{users:d=>d&&Array.isArray(d.users),sessions:d=>d&&typeof d==='object'});
let result,error;try{result=store.commit(next,sessions);}catch(e){error=e;}
assert.equal(fault.armed,true,'注入必须发生在 COMMITTED 目录 fsync 成功之后');
assert.equal(fault.hits,1,'故障必须真实触发且仅一次');
if(mode.startsWith('cleanup_')){
 assert.equal(error,undefined);assert.deepEqual(result,{cleanupPending:true});
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'users.json'))),next);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'sessions.json'))),sessions);
 assert.equal(store.pending(),false);
 if(mode==='cleanup_rm'){
  const retired=fs.readdirSync(root).find(n=>n.startsWith('.auth-done.'));assert.ok(retired);
  assert.equal(fs.readFileSync(path.join(root,retired,'COMMITTED'),'utf8'),'committed\\n');
  assert.equal(fs.readFileSync(path.join(root,retired,'DONE'),'utf8'),'committed\\n');
  createAuthStore(root,{users:d=>d&&Array.isArray(d.users),sessions:d=>d&&typeof d==='object'}).recover();
  assert.ok(!fs.readdirSync(root).some(n=>n.startsWith('.auth-done.')));
 }
}else{
 assert.ok(error,'提交状态异常不能作为 cleanupPending 成功返回');assert.equal(result,undefined);
 assert.equal(error.storage,true);assert.equal(error.status,503);assert.equal(error.code,'storage_unavailable');assert.equal(error.committed,true);
 const material=mode==='retire_sync'?fs.readdirSync(root).find(n=>n.startsWith('.auth-done.')):'.auth-transaction';
 assert.ok(material);assert.ok(fs.existsSync(path.join(root,material,'RECORD.json')));
 if(mode!=='marker_missing')assert.ok(fs.existsSync(path.join(root,material,'COMMITTED')));
 if(mode==='missing')assert.ok(!fs.existsSync(path.join(root,file)),'不能自动补写并隐藏异常');
 if(mode==='mismatch'||mode==='late_mismatch')assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,file))),old,'核验不能用重做掩盖外部替换');
}
console.log(JSON.stringify({mode,file,fault,result,error:error&&{storage:error.storage,status:error.status,committed:error.committed}}));
`;
const FAILURES = [
  ["read_eio", "users.json"], ["read_eio", "sessions.json"], ["read_eio", "COMMITTED"],
  ["missing", "users.json"], ["missing", "sessions.json"], ["mismatch", "users.json"], ["late_mismatch", "users.json"], ["corrupt", "sessions.json"],
  ["marker_missing", "COMMITTED"], ["marker_corrupt", "COMMITTED"], ["record_corrupt", "RECORD.json"],
  ["done_open", "DONE"], ["retire_rename", "directory"], ["retire_sync", "directory"],
];
for (const [mode, file] of [...FAILURES, ["cleanup_rm", "directory"], ["cleanup_sync", "directory"]]) {
  test("COMMITTED 后异常分类 " + mode + " / " + file, t => {
    const d = temp(t), ctl = path.join(temp(t), "control"); fs.writeFileSync(ctl, JSON.stringify({ mode, file }));
    const r = spawnSync(process.execPath, ["--require", PRELOAD, "-e", UNIT, d, CODE, mode, file], {
      encoding: "utf8", env: { ...process.env, AUTH_BOUNDARY_CTL: ctl }, timeout: 10000,
    });
    assert.equal(r.status, 0, r.stderr); t.diagnostic(r.stdout.trim());
  });
}
for (const [mode, file] of [["read_eio", "users.json"], ["missing", "users.json"], ["corrupt", "sessions.json"], ["retire_sync", "directory"]]) {
  test("COMMITTED 后 API 阻断、无 Cookie、保留材料 " + mode, async t => {
    const d = temp(t), ctl = path.join(temp(t), "control"); fs.writeFileSync(ctl, "");
    const s = await startServer({ root: CODE, dataDir: d, env: { NODE_OPTIONS: "--require=" + PRELOAD, AUTH_BOUNDARY_CTL: ctl } }); t.after(() => s.stop());
    const c = client(s.base); assert.equal((await c.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
    fs.writeFileSync(ctl, JSON.stringify({ mode, file }));
    const r = await c.post("/api/password", { old: "admin-pass-1", password: "changed-pass-12" });
    const injection = JSON.parse(fs.readFileSync(ctl + ".hit")); assert.equal(injection.armed, true); assert.equal(injection.hits, 1);
    assert.equal(r.status, 503); assert.equal(r.json.code, "storage_unavailable"); assert.deepEqual(r.setCookie, []);
    const material = mode === "retire_sync" ? fs.readdirSync(d).find(n => n.startsWith(".auth-done.")) : ".auth-transaction";
    assert.ok(material); const before = fs.readFileSync(path.join(d, material, "RECORD.json"));
    fs.writeFileSync(ctl, ""); // 单次故障消失也不能在本进程自动解除异常并发新 Cookie。
    assert.equal((await c.get("/api/health")).status, 503);
    const login = await client(s.base).post("/api/login", { name: "admin", password: "changed-pass-12" });
    assert.equal(login.status, 503); assert.deepEqual(login.setCookie, []);
    assert.equal((await c.get("/api/config")).status, 503);
    assert.ok(fs.readFileSync(path.join(d, material, "RECORD.json")).equals(before));
    if (["read_eio", "retire_sync"].includes(mode)) {
      await s.stop(); const next = await startServer({ root: CODE, dataDir: d }); t.after(() => next.stop());
      assert.equal((await client(next.base).post("/api/login", { name: "admin", password: "changed-pass-12" })).status, 200);
      assert.equal((await client(next.base).post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 401);
      assert.ok(!fs.readdirSync(d).some(n => n === ".auth-transaction" || n.startsWith(".auth-done.")));
    }
  });
}
test("单纯退休材料清理失败仍允许持久提交后的 Cookie 和重启清理", async t => {
  const d = temp(t), ctl = path.join(temp(t), "control"); fs.writeFileSync(ctl, "");
  const s = await startServer({ root: CODE, dataDir: d, env: { NODE_OPTIONS: "--require=" + PRELOAD, AUTH_BOUNDARY_CTL: ctl } }); t.after(() => s.stop());
  const c = client(s.base); assert.equal((await c.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  fs.writeFileSync(ctl, JSON.stringify({ mode: "cleanup_rm", file: "directory" }));
  const r = await c.post("/api/password", { old: "admin-pass-1", password: "changed-pass-12" });
  assert.equal(JSON.parse(fs.readFileSync(ctl + ".hit")).hits, 1); assert.equal(r.status, 200); assert.ok(r.setCookie.some(v => v.startsWith("nocturne_dev=")));
  assert.equal((await c.get("/api/health")).status, 200); assert.ok(fs.readdirSync(d).some(n => n.startsWith(".auth-done.")));
  await s.stop(); const next = await startServer({ root: CODE, dataDir: d }); t.after(() => next.stop());
  assert.equal((await client(next.base).post("/api/login", { name: "admin", password: "changed-pass-12" })).status, 200);
  assert.ok(!fs.readdirSync(d).some(n => n.startsWith(".auth-done.")));
});
