"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { once } = require("node:events"), { spawn } = require("node:child_process");
const { ROOT, startServer, client, cfg, sleep, freePort } = require("./helpers");
const CODE = process.env.NOCTURNE_AUTH_TEST_ROOT || ROOT;
const PW = "admin-pass-1", BOB = "bob-pass-12", NEW = "changed-pass-12";
function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nc-auth-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function snapshot(d) {
  const out = {}; function walk(f, p) { for (const n of fs.readdirSync(f, { withFileTypes: true })) { if (n.name.endsWith(".tmp")) continue; const rel = path.join(p, n.name), full = path.join(f, n.name); if (n.isDirectory()) walk(full, rel); else out[rel] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"); } }
  walk(d, ""); return out;
}
function noChange(d, before) { const after = snapshot(d); assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort()); for (const k of Object.keys(before)) assert.ok(after[k] === before[k], k + " unchanged"); }
async function fixture(t, empty = false) {
  const d = temp(t), ctl = path.join(temp(t), "rules"); fs.writeFileSync(ctl, "");
  const srv = await startServer({ root: CODE, dataDir: d, env: { NODE_OPTIONS: "--require=" + path.join(ROOT, "test/fsfail.js"), FSFAIL_CTL: ctl } }); t.after(() => srv.stop());
  const admin = client(srv.base), bob = client(srv.base);
  if (!empty) {
    assert.equal((await admin.post("/api/setup", { name: "admin", password: PW })).status, 200);
    assert.equal((await admin.post("/api/users", { name: "bob", password: BOB })).status, 200);
    assert.equal((await bob.post("/api/login", { name: "bob", password: BOB })).status, 200);
    assert.equal((await bob.put("/api/config", { baseVersion: 0, data: cfg("Bob", [], { spaces: [] }) })).status, 200);
    for (const rel of ["icons/bob/p.png", "wallpapers/bob.jpg", "backup/bob/extra.json"]) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), "synthetic " + rel); }
    await sleep(2200); // 旧版会话防抖必须已落盘，便于逐字节比较。
  }
  return { srv, admin, bob, ctl, d };
}
function operation(f, op) {
  const c = op === "login" ? client(f.srv.base) : f.admin;
  const run = {
    setup: () => c.post("/api/setup", { name: "admin", password: PW }),
    create: () => c.post("/api/users", { name: "phantom", password: NEW }),
    login: () => c.post("/api/login", { name: "admin", password: PW }),
    password: () => c.post("/api/password", { old: PW, password: NEW }),
    reset: () => c.post("/api/users/bob/password", { password: NEW }),
    delete: () => c.del("/api/users/bob"), logout: () => c.post("/api/logout")
  }[op]; return { c, run };
}
for (const op of ["setup", "create", "login", "password", "reset", "delete", "logout"]) for (const file of ["users", "sessions"]) {
  test("失败不发布内存/Cookie，磁盘回退 " + op + " / " + file, async t => {
    const f = await fixture(t, op === "setup"), before = snapshot(f.d);
    fs.writeFileSync(f.ctl, "once_rename " + file + "\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
    const { run } = operation(f, op), r = await run(); assert.ok(r.status >= 500, "injected failure"); assert.deepEqual(r.setCookie, []);
    noChange(f.d, before); assert.ok(!fs.existsSync(path.join(f.d, ".auth-transaction")));
    if (op === "setup") assert.equal((await f.admin.get("/api/me")).json.setup, true);
    else {
      assert.equal((await f.admin.get("/api/config")).status, 200); assert.equal((await f.bob.get("/api/config")).status, 200);
      assert.equal((await client(f.srv.base).post("/api/login", { name: "phantom", password: NEW })).status, 401);
      assert.equal((await client(f.srv.base).post("/api/login", { name: "admin", password: PW })).status, 200);
      if (["password", "reset"].includes(op)) assert.equal((await client(f.srv.base).post("/api/login", { name: op === "reset" ? "bob" : "admin", password: NEW })).status, 401);
    }
  });
}
for (const mode of ["once_sync_open", "once_sync_partial", "once_sync_fsync"]) test("候选写入故障回退 " + mode, async t => {
  const f = await fixture(t), before = snapshot(f.d); fs.writeFileSync(f.ctl, mode + " sessions\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
  const r = await f.admin.post("/api/password", { old: PW, password: NEW }); assert.ok(r.status >= 500); assert.deepEqual(r.setCookie, []); noChange(f.d, before); assert.equal((await f.admin.get("/api/config")).status, 200);
});
for (const rule of ["once_rename COMMITTED", "once_sync_fsync COMMITTED"]) test("提交标记前失败保持旧状态 " + rule, async t => {
  const f = await fixture(t), before = snapshot(f.d); fs.writeFileSync(f.ctl, rule + "\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
  const r = await f.admin.post("/api/password", { old: PW, password: NEW }); assert.ok(r.status >= 500); assert.deepEqual(r.setCookie, []); noChange(f.d, before);
});
async function killed(t, rule, op = "password") {
  const f = await fixture(t); fs.writeFileSync(f.ctl, rule + "\n"); const ended = once(f.srv.child, "exit");
  await operation(f, op).run().catch(() => {}); await Promise.race([ended, sleep(1000)]);
  assert.equal(f.srv.child.signalCode, "SIGKILL", "故障注入必须实际强杀，旧版无对应阶段时用例失败");
  assert.ok(fs.existsSync(path.join(f.d, ".auth-transaction")), "恢复材料保留");
  fs.writeFileSync(f.ctl, ""); const next = await startServer({ root: CODE, dataDir: f.d }); t.after(() => next.stop());
  return { ...f, next };
}
for (const [label, rule, committed] of [
  ["首文件后", "kill_after_rename users\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$", false],
  ["提交标记前", "kill_rename COMMITTED\\.\\d+\\.[0-9a-f]{8}\\.tmp$", false],
  ["提交标记后", "kill_after_rename COMMITTED\\.\\d+\\.[0-9a-f]{8}\\.tmp$", true],
  ["提交后清理前", "kill_rename \\.auth-transaction$", true]
]) test("SIGKILL " + label + " 重启选择唯一状态", async t => {
  const f = await killed(t, rule), c = client(f.next.base);
  assert.equal((await c.post("/api/login", { name: "admin", password: committed ? NEW : PW })).status, 200);
  assert.equal((await client(f.next.base).post("/api/login", { name: "admin", password: committed ? PW : NEW })).status, 401);
  assert.ok(!fs.existsSync(path.join(f.d, ".auth-transaction")));
  const oldJar = client(f.next.base); for (const [k,v] of f.bob.jar) oldJar.jar.set(k,v); assert.equal((await oldJar.get("/api/config")).status, 200);
});
test("删除移动后 SIGKILL 回移资产并保留会话", async t => {
  const f = await killed(t, "kill_after_rename config/bob\\.json$", "delete"), c = client(f.next.base);
  for (const [k,v] of f.bob.jar) c.jar.set(k,v); assert.equal((await c.get("/api/config")).status, 200);
  for (const rel of ["config/bob.json", "icons/bob/p.png", "wallpapers/bob.jpg", "backup/bob/extra.json"]) assert.ok(fs.existsSync(path.join(f.d, rel)), rel);
});
test("回退本身失败必须阻断且保留记录，清除故障后重启恢复", async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.ctl, "rollback_failure sessions\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
  const r = await f.admin.post("/api/password", { old: PW, password: NEW }); assert.equal(r.status, 503); assert.deepEqual(r.setCookie, []);
  assert.equal((await f.admin.get("/api/health")).status, 503); assert.ok(fs.existsSync(path.join(f.d, ".auth-transaction/RECORD.json")));
  await f.srv.stop(); fs.writeFileSync(f.ctl, ""); const s = await startServer({ root: CODE, dataDir: f.d }); t.after(() => s.stop());
  assert.equal((await client(s.base).post("/api/login", { name: "admin", password: PW })).status, 200);
});
test("记录损坏启动拒绝，认证及恢复材料不变", async t => {
  const f = await fixture(t); const ended = once(f.srv.child, "exit"); fs.writeFileSync(f.ctl, "kill_after_rename users\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
  await f.admin.post("/api/password", { old: PW, password: NEW }).catch(() => {}); await ended;
  const r = path.join(f.d, ".auth-transaction/RECORD.json"); assert.ok(fs.existsSync(r)); fs.writeFileSync(r, "{broken"); const before = snapshot(f.d), port = await freePort();
  const child = spawn(process.execPath, [path.join(CODE, "server.js")], { env: { ...process.env, DATA_DIR: f.d, HOST: "127.0.0.1", PORT: String(port), NODE_OPTIONS: "" }, stdio: "ignore" });
  await once(child, "exit"); assert.equal(child.exitCode, 2); noChange(f.d, before);
});
test("提交后返回异常不发 Cookie、不回旧状态，重启完成新状态", async t => {
  const f = await fixture(t); fs.writeFileSync(f.ctl, "after_rename_throw COMMITTED\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
  const r = await f.admin.post("/api/password", { old: PW, password: NEW }); assert.equal(r.status, 503); assert.deepEqual(r.setCookie, []);
  await f.srv.stop(); fs.writeFileSync(f.ctl, ""); const s = await startServer({ root: CODE, dataDir: f.d }); t.after(() => s.stop());
  assert.equal((await client(s.base).post("/api/login", { name: "admin", password: NEW })).status, 200);
  assert.equal((await client(s.base).post("/api/login", { name: "admin", password: PW })).status, 401);
});
test("成功响应前 Cookie 对应会话已落盘；同名重建无旧资产/设备/会话", async t => {
  const f = await fixture(t), c = client(f.srv.base); const login = await c.post("/api/login", { name: "admin", password: PW }); assert.equal(login.status, 200);
  const token = c.jar.get("nocturne_sid"), disk = JSON.parse(fs.readFileSync(path.join(f.d, "sessions.json")));
  assert.ok(disk[crypto.createHash("sha256").update(token).digest("hex")]);
  assert.equal((await f.admin.del("/api/users/bob")).status, 200); assert.equal((await f.admin.post("/api/users", { name: "bob", password: BOB })).status, 200);
  assert.equal((await f.bob.get("/api/config")).status, 401); assert.ok(!fs.existsSync(path.join(f.d, "config/bob.json")));
  const u = JSON.parse(fs.readFileSync(path.join(f.d, "users.json"))).users.find(x => x.name === "bob"); assert.ok(!u.devices);
});
test("删除移动失败逐字节回退资产", async t => {
  const f = await fixture(t), before = snapshot(f.d); fs.writeFileSync(f.ctl, "once_rename wallpapers/bob\\.jpg$\n");
  const r = await f.admin.del("/api/users/bob"); assert.ok(r.status >= 500); noChange(f.d, before); assert.equal((await f.bob.get("/api/config")).status, 200);
});
test("提交后清理失败不撤销成功删除；重启继续清理", async t => {
  const f = await fixture(t); fs.writeFileSync(f.ctl, "once_sync_rm \\.auth-done\\.[0-9a-f-]+\\.tmp$\n");
  assert.equal((await f.admin.del("/api/users/bob")).status, 200); assert.equal((await f.bob.get("/api/config")).status, 401);
  assert.ok(fs.readdirSync(f.d).some(x => x.startsWith(".auth-done.")), "保留已提交清理材料");
  await f.srv.stop(); const s = await startServer({ root: CODE, dataDir: f.d }); t.after(() => s.stop());
  assert.ok(!fs.readdirSync(f.d).some(x => x.startsWith(".auth-done.")));
});
test("中断删除的恢复材料允许复制到隔离目录后恢复", async t => {
  const f = await fixture(t), before = snapshot(f.d), ended = once(f.srv.child, "exit");
  fs.writeFileSync(f.ctl, "kill_after_rename config/bob\\.json$\n"); await f.admin.del("/api/users/bob").catch(() => {}); await Promise.race([ended, sleep(1000)]);
  assert.equal(f.srv.child.signalCode, "SIGKILL"); assert.ok(fs.existsSync(path.join(f.d, ".auth-transaction")));
  const copy = path.join(temp(t), "copy"); fs.cpSync(f.d, copy, { recursive: true });
  const s = await startServer({ root: CODE, dataDir: copy }); t.after(() => s.stop()); noChange(copy, before);
});
test("恢复时目标冲突拒绝猜测，保留资产和记录", async t => {
  const f = await fixture(t), ended = once(f.srv.child, "exit"); fs.writeFileSync(f.ctl, "kill_after_rename config/bob\\.json$\n");
  await f.admin.del("/api/users/bob").catch(() => {}); await Promise.race([ended, sleep(1000)]);
  assert.ok(fs.existsSync(path.join(f.d, ".auth-transaction"))); fs.writeFileSync(path.join(f.d, "config/bob.json"), "conflicting replacement"); const before = snapshot(f.d);
  const child = spawn(process.execPath, [path.join(CODE, "server.js")], { env: { ...process.env, DATA_DIR: f.d, PORT: String(await freePort()), HOST: "127.0.0.1", NODE_OPTIONS: "" }, stdio: "ignore" });
  await once(child, "exit"); assert.equal(child.exitCode, 2); noChange(f.d, before);
});
test("恢复记录拒绝任意资产路径，即使校验和被重新计算", async t => {
  const f = await fixture(t), ended = once(f.srv.child, "exit"); fs.writeFileSync(f.ctl, "kill_after_rename config/bob\\.json$\n");
  await f.admin.del("/api/users/bob").catch(() => {}); await Promise.race([ended, sleep(1000)]);
  const file = path.join(f.d, ".auth-transaction/RECORD.json"); assert.ok(fs.existsSync(file)); const e = JSON.parse(fs.readFileSync(file)), r = JSON.parse(e.payload);
  r.assets[0].rel = "../outside"; e.payload = JSON.stringify(r); e.sha256 = crypto.createHash("sha256").update(e.payload).digest("hex"); fs.writeFileSync(file, JSON.stringify(e)); const before = snapshot(f.d);
  const child = spawn(process.execPath, [path.join(CODE, "server.js")], { env: { ...process.env, DATA_DIR: f.d, PORT: String(await freePort()), HOST: "127.0.0.1", NODE_OPTIONS: "" }, stdio: "ignore" });
  await once(child, "exit"); assert.equal(child.exitCode, 2); noChange(f.d, before);
});
test("滑动续期失败不延长磁盘，重试后先持久化再继续使用", async t => {
  const f = await fixture(t); await f.srv.stop(); const sf = path.join(f.d, "sessions.json"), sessions = JSON.parse(fs.readFileSync(sf));
  const key = crypto.createHash("sha256").update(f.admin.jar.get("nocturne_sid")).digest("hex"); sessions[key].expires = Date.now() + 60000; fs.writeFileSync(sf, JSON.stringify(sessions));
  const s = await startServer({ root: CODE, dataDir: f.d, env: { NODE_OPTIONS: "--require=" + path.join(ROOT, "test/fsfail.js"), FSFAIL_CTL: f.ctl } }); t.after(() => s.stop()); const c = client(s.base); for (const [k,v] of f.admin.jar) c.jar.set(k,v);
  fs.writeFileSync(f.ctl, "once_rename sessions\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n"); assert.ok((await c.get("/api/config")).status >= 500); assert.equal(JSON.parse(fs.readFileSync(sf))[key].expires, sessions[key].expires);
  assert.equal((await c.get("/api/config")).status, 200); assert.ok(JSON.parse(fs.readFileSync(sf))[key].expires > sessions[key].expires);
});
test("过期清理写失败不覆盖认证文件，下次清理经事务成功", async t => {
  const f = await fixture(t); await f.srv.stop(); const sf = path.join(f.d, "sessions.json"), sessions = JSON.parse(fs.readFileSync(sf));
  const key = crypto.createHash("sha256").update(f.bob.jar.get("nocturne_sid")).digest("hex"); sessions[key].expires = Date.now() - 1000; fs.writeFileSync(sf, JSON.stringify(sessions));
  const before = fs.readFileSync(sf); fs.writeFileSync(f.ctl, "once_rename sessions\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
  const s = await startServer({ root: CODE, dataDir: f.d, env: { NODE_OPTIONS: "--require=" + path.join(ROOT, "test/fsfail.js"), FSFAIL_CTL: f.ctl } }); t.after(() => s.stop()); await sleep(2300);
  assert.ok(fs.readFileSync(sf).equals(before)); const c = client(s.base); for (const [k,v] of f.bob.jar) c.jar.set(k,v); assert.equal((await c.get("/api/config")).status, 401); await sleep(2300);
  assert.ok(!JSON.parse(fs.readFileSync(sf))[key]);
});
