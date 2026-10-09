"use strict";
/* P1-1：仅合成数据。NOCTURNE_STORAGE_TEST_ROOT 可指向旧提交检出，证明旧代码失败。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { startServer, client, cfg, freePort, sleep, waitFor, ROOT } = require("./helpers");
const SERVER_ROOT = process.env.NOCTURNE_STORAGE_TEST_ROOT || ROOT;
const PW = "admin-pass-1", salt = Buffer.alloc(16, 7);
const HASH = "scrypt$" + salt.toString("base64") + "$" + crypto.scryptSync(PW, salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64");
function auth(d, extra = {}) { fs.writeFileSync(path.join(d, "users.json"), JSON.stringify({ users: [{ name: "admin", admin: true, hash: HASH, ...extra }], future: { keep: true } })); }
function config(d, name = "admin", data = cfg("原配置")) { fs.mkdirSync(path.join(d, "config"), { recursive: true }); fs.writeFileSync(path.join(d, "config", name + ".json"), JSON.stringify({ version: 7, data })); }
function tree(d) { const out = {}; function walk(p, rel) { for (const x of fs.readdirSync(p, { withFileTypes: true })) { const r = path.join(rel, x.name), f = path.join(p, x.name); if (x.isDirectory()) walk(f, r); else out[r] = fs.readFileSync(f).toString("base64"); } } walk(d, ""); return out; }
function unchanged(d, before, exclude = []) { const after = tree(d), keys = x => Object.keys(x).filter(k => !exclude.includes(k)).sort(); assert.deepEqual(keys(after), keys(before), "文件集合不变"); for (const f of keys(before)) assert.ok(after[f] === before[f], f + " 字节不变"); } // 失败不输出认证文件内容。
function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nc-storage-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
async function launch(t, d, env = {}) {
  const port = await freePort(), child = spawn(process.execPath, [path.join(SERVER_ROOT, "server.js")], { env: { ...process.env, DATA_DIR: d, HOST: "127.0.0.1", PORT: String(port), STATUS_INTERVAL: "3600", DOCKER_SOCK: path.join(d, "none.sock"), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", x => log += x); child.stderr.on("data", x => log += x);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } });
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null) break; try { await fetch("http://127.0.0.1:" + port + "/api/health"); break; } catch {} await sleep(25); }
  return { child, log: () => log, base: "http://127.0.0.1:" + port };
}
const faultEnv = (ctl) => ({ NODE_OPTIONS: "--require=" + path.join(ROOT, "test/fsfail.js"), FSFAIL_CTL: ctl });
async function live(t, seed = d => auth(d)) {
  const ctlDir = temp(t), ctl = path.join(ctlDir, "faults"); fs.writeFileSync(ctl, "");
  const srv = await startServer({ root: SERVER_ROOT, seed, env: faultEnv(ctl) }); t.after(() => srv.stop());
  const c = client(srv.base); assert.equal((await c.post("/api/login", { name: "admin", password: PW })).status, 200);
  await sleep(2200); return { srv, c, ctl };
}

for (const file of ["users.json", "sessions.json"]) for (const raw of ["{broken", "null", "[]", '{"users":"broken"}']) {
  test("损坏认证文件启动拒绝且不覆盖：" + file + " " + raw, async t => {
    const d = temp(t); auth(d); fs.writeFileSync(path.join(d, file), raw); const before = tree(d);
    const s = await launch(t, d); assert.equal(s.child.exitCode, 2, "必须在 listen 前明确报存储故障退出，不能依赖 TypeError 崩溃");
    unchanged(d, before); assert.doesNotMatch(s.log(), /scrypt\$|\{broken/);
  });
}
for (const seed of [d => config(d), d => fs.writeFileSync(path.join(d, "sessions.json"), "{}"), d => { config(d); fs.writeFileSync(path.join(d, "users.json"), '{"users":[]}'); }]) {
  test("孤立既有数据不能重新初始化管理员", async t => { const d = temp(t); seed(d); const before = tree(d); const s = await launch(t, d); assert.notEqual(s.child.exitCode, null); assert.notEqual(s.child.exitCode, 0); unchanged(d, before); });
}
for (const dir of ["icons", "backup"]) test("孤立 .tmp 后缀账户目录阻断首次初始化 " + dir, async t => {
  const d = temp(t), sub = path.join(d, dir, "bob.tmp"); fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "original.json"), "existing account material"); const before = tree(d);
  const s = await launch(t, d); assert.equal(s.child.exitCode, 2); unchanged(d, before);
});
for (const rule of ["read_eacces", "read_eio", "stat_eacces", "stat_eio", "read_enoent"]) {
  test("认证文件读取故障在启动前关闭：" + rule, async t => { const d = temp(t), ctl = path.join(temp(t), "faults"); auth(d); fs.writeFileSync(ctl, rule + " users\\.json$\n"); const before = tree(d); const s = await launch(t, d, faultEnv(ctl)); assert.notEqual(s.child.exitCode, null); unchanged(d, before); });
}
for (const raw of ["{broken", "null", '{"version":7,"data":null}', '{"version":-1,"data":{"settings":{},"groups":[]}}', '{"version":7,"data":{"settings":{},"groups":"bad"}}']) {
  test("损坏配置禁止 GET / PUT / force / restore / stash：" + raw, async t => {
    const { srv, c } = await live(t); const f = path.join(srv.dataDir, "config/admin.json"); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, raw);
    const before = tree(srv.dataDir);
    assert.equal((await c.get("/api/config")).status, 503);
    for (const body of [{ baseVersion: 99, data: cfg("覆盖") }, { baseVersion: 99, expectVersion: 0, force: true, data: cfg("覆盖") }, { baseVersion: 0, restore: true, data: cfg("覆盖") }]) assert.equal((await c.put("/api/config", body)).status, 503);
    assert.equal((await c.post("/api/config/stash", { baseVersion: 0, data: cfg("覆盖") })).status, 503);
    assert.equal((await c.get("/api/health")).status, 503); unchanged(srv.dataDir, before);
  });
}
for (const fault of ["read_eacces", "read_eio", "stat_eacces", "stat_eio", "read_enoent", "remove", "same-mtime"]) {
  test("已读取配置不能因缓存或读取异常变为空配置：" + fault, async t => {
    const { srv, c, ctl } = await live(t, d => { auth(d); config(d); }); const f = path.join(srv.dataDir, "config/admin.json"); assert.equal((await c.get("/api/config")).status, 200);
    if (fault === "remove") fs.unlinkSync(f);
    else if (fault === "same-mtime") { const st = fs.statSync(f); const n = fs.statSync(f).size; fs.writeFileSync(f, "{broken".padEnd(n)); fs.utimesSync(f, st.atime, st.mtime); }
    else fs.writeFileSync(ctl, fault + " config/admin\\.json$\n");
    const before = tree(srv.dataDir); assert.equal((await c.get("/api/config")).status, 503); assert.equal((await c.put("/api/config", { baseVersion: 0, data: cfg("覆盖") })).status, 503); unchanged(srv.dataDir, before);
  });
}
for (const file of ["users.json", "sessions.json"]) for (const mode of ["corrupt", "remove", "read_eacces", "read_eio"]) {
  test("运行中认证文件异常不被内存副本覆盖：" + file + " " + mode, async t => {
    const { srv, c, ctl } = await live(t); const f = path.join(srv.dataDir, file);
    if (mode === "corrupt") fs.writeFileSync(f, "{broken"); else if (mode === "remove") fs.unlinkSync(f); else fs.writeFileSync(ctl, mode + " " + file.replaceAll(".", "\\.") + "$\n");
    const before = tree(srv.dataDir);
    assert.equal((await c.post("/api/users", { name: "intruder", password: PW })).status, 503);
    assert.equal((await c.post("/api/login", { name: "admin", password: PW })).status, 503);
    assert.equal((await c.post("/api/setup", { name: "intruder", password: PW })).status, 503);
    assert.equal((await c.get("/api/health")).status, 503);
    srv.child.kill("SIGTERM"); await once(srv.child, "exit"); unchanged(srv.dataDir, before);
  });
}
test("坏配置启动不迁移/不找回，其他账户仍可使用", async t => {
  const d = temp(t); auth(d); config(d); const us = JSON.parse(fs.readFileSync(path.join(d, "users.json"))); us.users.push({ name: "bob", admin: false, hash: HASH }); fs.writeFileSync(path.join(d, "users.json"), JSON.stringify(us));
  config(d, "bob"); fs.writeFileSync(path.join(d, "config/admin.json"), "{broken"); const before = tree(d);
  const s = await launch(t, d); assert.equal(s.child.exitCode, null); await sleep(200); unchanged(d, before);
  const c = client(s.base); assert.equal((await c.post("/api/login", { name: "bob", password: PW })).status, 200); assert.equal((await c.get("/api/config")).json.version, 7); assert.equal((await c.get("/api/health")).status, 503);
});
test("NO_AUTH 保留损坏认证文件，正常配置仍可读写和关闭", async t => {
  const d = temp(t); fs.writeFileSync(path.join(d, "users.json"), "{broken-users"); fs.writeFileSync(path.join(d, "sessions.json"), "{broken-sessions"); config(d, "default");
  const srv = await startServer({ root: SERVER_ROOT, dataDir: d, env: { NOCTURNE_NO_AUTH: "1" } }); t.after(() => srv.stop()); const c = client(srv.base);
  assert.equal((await c.get("/api/config")).status, 200); assert.equal((await c.put("/api/config", { baseVersion: 7, data: cfg("新标题") })).status, 200);
  srv.child.kill("SIGTERM"); await once(srv.child, "exit"); assert.equal(fs.readFileSync(path.join(d, "users.json"), "utf8"), "{broken-users"); assert.equal(fs.readFileSync(path.join(d, "sessions.json"), "utf8"), "{broken-sessions");
});
test("全新空站点允许初始化；新账户没有配置允许首次同步", async t => {
  const srv = await startServer({ root: SERVER_ROOT }); t.after(() => srv.stop()); const c = client(srv.base);
  assert.equal((await c.get("/api/me")).json.setup, true); assert.equal((await c.post("/api/setup", { name: "admin", password: PW })).status, 200);
  assert.equal((await c.get("/api/config")).json.data, null); assert.equal((await c.put("/api/config", { baseVersion: 0, data: cfg("新标题") })).status, 200);
});
test("RC.1–RC.4 正常数据双向读写、未知字段和默认 cookie 兼容", { timeout: 60000 }, async t => {
  for (const [name, ref] of [["RC.1", "2ee0983"], ["RC.2", "3d5beaf"], ["RC.3", "e4de70b"], ["RC.4", "f516629"]]) {
    const code = temp(t); for (const f of ["server.js", "package.json", "public/urlcheck.js", "public/spaces.js"]) { fs.mkdirSync(path.dirname(path.join(code, f)), { recursive: true }); fs.writeFileSync(path.join(code, f), execFileSync("git", ["-C", ROOT, "show", ref + ":" + f])); }
    const d = temp(t), old = await startServer({ root: code, dataDir: d }); const oc = client(old.base); assert.equal((await oc.post("/api/setup", { name: "admin", password: PW })).status, 200); const data = cfg(name, [], { spaces: [], future: { keep: true } }); assert.equal((await oc.put("/api/config", { baseVersion: 0, data })).status, 200); await sleep(2200); await old.stop();
    const before = tree(d), current = await startServer({ root: SERVER_ROOT, dataDir: d }); t.after(() => current.stop());
    if (name === "RC.1") assert.ok(await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(d, "spaces-guard/admin.json"))).fmt === 2; } catch { return false; } }), "等待已有的 RC.1 旁路自愈完成");
    unchanged(d, before, ["spaces-guard/admin.json"]); // RC.4 已有的 RC.1 旁路 fmt:2 自愈允许，主数据不变。
    const c = client(current.base); const login = await c.post("/api/login", { name: "admin", password: PW }); assert.equal(login.status, 200); assert.ok(login.setCookie.some(x => x.startsWith("nocturne_sid="))); assert.ok(login.setCookie.some(x => x.startsWith("nocturne_dev="))); assert.deepEqual((await c.get("/api/config")).json.data, data);
    const latest = { ...data, settings: { title: "修复版保存 " + name } }; const version = (await c.get("/api/config")).json.version;
    assert.equal((await c.put("/api/config", { baseVersion: version, data: latest })).status, 200); await sleep(2200); await current.stop();
    const rollback = await startServer({ root: code, dataDir: d }); t.after(() => rollback.stop()); const rc = client(rollback.base);
    assert.equal((await rc.post("/api/login", { name: "admin", password: PW })).status, 200); assert.deepEqual((await rc.get("/api/config")).json.data, latest, name + " 能读取修复版保存的数据");
  }
});

test("缺失配置但已有快照：重启后仍不能当作首次保存", async t => {
  const d = temp(t); auth(d); fs.mkdirSync(path.join(d, "backup/admin"), { recursive: true }); fs.writeFileSync(path.join(d, "backup/admin", "old.json"), JSON.stringify({ version: 7, data: cfg("历史") }));
  const before = tree(d), s = await launch(t, d), c = client(s.base); assert.equal((await c.post("/api/login", { name: "admin", password: PW })).status, 200);
  assert.equal((await c.get("/api/config")).status, 503); assert.equal((await c.put("/api/config", { baseVersion: 0, data: cfg("覆盖") })).status, 503);
  assert.ok(!fs.existsSync(path.join(d, "config/admin.json"))); assert.ok(tree(d)["backup/admin/old.json"] === before["backup/admin/old.json"]);
});
test("损坏配置修复后保持阻断，受控重启才恢复", async t => {
  const { srv, c } = await live(t, d => { auth(d); config(d); }); const f = path.join(srv.dataDir, "config/admin.json"), good = fs.readFileSync(f);
  fs.writeFileSync(f, "{broken"); assert.equal((await c.get("/api/config")).status, 503); fs.writeFileSync(f, good);
  assert.equal((await c.put("/api/config", { baseVersion: 7, data: cfg("覆盖") })).status, 503); assert.ok(fs.readFileSync(f).equals(good));
  const d = temp(t); for (const name of ["users.json", "sessions.json"]) fs.copyFileSync(path.join(srv.dataDir, name), path.join(d, name)); fs.mkdirSync(path.join(d, "config")); fs.writeFileSync(path.join(d, "config/admin.json"), good);
  const reopened = await startServer({ root: SERVER_ROOT, dataDir: d }); t.after(() => reopened.stop()); const rc = client(reopened.base); assert.equal((await rc.post("/api/login", { name: "admin", password: PW })).status, 200); assert.equal((await rc.get("/api/config")).json.version, 7);
});
test("有效认证文件被外部替换也不能被旧内存覆盖", async t => {
  const { srv, c } = await live(t); const f = path.join(srv.dataDir, "users.json"), u = JSON.parse(fs.readFileSync(f)); u.future.changed = true; fs.writeFileSync(f, JSON.stringify(u)); const before = tree(srv.dataDir);
  assert.equal((await c.post("/api/login", { name: "admin", password: PW })).status, 503); unchanged(srv.dataDir, before);
});
test("延迟会话落盘遇到损坏账户时保持全部原文件", async t => {
  const srv = await startServer({ root: SERVER_ROOT, seed: d => auth(d) }); t.after(() => srv.stop()); const c = client(srv.base); assert.equal((await c.post("/api/login", { name: "admin", password: PW })).status, 200);
  fs.writeFileSync(path.join(srv.dataDir, "users.json"), "{broken"); const before = tree(srv.dataDir); await sleep(2200); unchanged(srv.dataDir, before); assert.equal((await c.get("/api/health")).status, 503);
});
for (const users of [[null], [{ name: "admin", hash: "scrypt$bad$bad" }], [{ name: "admin", hash: HASH }, { name: "ADMIN", hash: HASH }], [{ name: "admin", hash: HASH, devices: {} }]]) {
  test("认证记录结构异常不得启动", async t => { const d = temp(t); fs.writeFileSync(path.join(d, "users.json"), JSON.stringify({ users })); const before = tree(d), s = await launch(t, d); assert.notEqual(s.child.exitCode, null); unchanged(d, before); });
}
for (const kind of ["legacy", "guard", "snapshot"]) {
  test("缺失配置但已有历史证据不得首次同步：" + kind, async t => {
    const d = temp(t); auth(d);
    if (kind === "snapshot") { const r = path.join(d, "pre-v2-snapshot-20261009-000000"); fs.mkdirSync(r); auth(r); config(r); }
    else { const dir = path.join(d, kind === "guard" ? "spaces-guard" : "backup"); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "admin.json"), "{}"); }
    const s = await launch(t, d), c = client(s.base); assert.equal((await c.post("/api/login", { name: "admin", password: PW })).status, 200);
    assert.equal((await c.get("/api/config")).status, 503); assert.equal((await c.put("/api/config", { baseVersion: 0, data: cfg("覆盖") })).status, 503); assert.ok(!fs.existsSync(path.join(d, "config/admin.json")));
  });
}
test("固定快照中同名旧账户不阻止明确重建的新账户首次保存", async t => {
  const d = temp(t); auth(d, { created: "2026-10-09T00:00:00.000Z" }); const r = path.join(d, "pre-v2-snapshot-20261008-000000"); fs.mkdirSync(r); auth(r, { created: "2026-10-08T00:00:00.000Z" }); config(r);
  const srv = await startServer({ root: SERVER_ROOT, dataDir: d }); t.after(() => srv.stop()); const c = client(srv.base); assert.equal((await c.post("/api/login", { name: "admin", password: PW })).status, 200); assert.equal((await c.put("/api/config", { baseVersion: 0, data: cfg("新账户") })).status, 200);
});
test("NO_AUTH 正常旧账户仍参与既有旁路迁移，关闭不重写认证文件", async t => {
  const d = temp(t); auth(d); config(d, "default"); config(d);
  const f = path.join(d, "config/admin.json"), doc = JSON.parse(fs.readFileSync(f)); doc.writer = { app: "nocturne", gen: 2 }; fs.writeFileSync(f, JSON.stringify(doc));
  const before = fs.readFileSync(path.join(d, "users.json"));
  const srv = await startServer({ root: SERVER_ROOT, dataDir: d, env: { NOCTURNE_NO_AUTH: "1" } }); t.after(() => srv.stop());
  assert.ok(await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(d, "spaces-guard/admin.json"))).fmt === 2; } catch { return false; } }));
  assert.equal((await client(srv.base).get("/api/config")).status, 200);
  srv.child.kill("SIGTERM"); await once(srv.child, "exit"); assert.ok(fs.readFileSync(path.join(d, "users.json")).equals(before));
});
for (const file of ["config/admin.json", "users.json"]) {
  test("临时写入期间目标损坏：提交前复核阻止覆盖 " + file, async t => {
    const { srv, c, ctl } = await live(t, d => { auth(d); config(d); });
    fs.writeFileSync(ctl, "corrupt_before_sync " + file.replaceAll(".", "\\.") + "\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
    const result = file === "users.json" ? await c.post("/api/users", { name: "bob", password: PW }) : await c.put("/api/config", { baseVersion: 7, data: cfg("覆盖") });
    assert.equal(result.status, 503); assert.equal(result.json.code, "storage_unavailable");
    assert.equal(fs.readFileSync(path.join(srv.dataDir, file), "utf8"), "{injected-corrupt");
    assert.ok(!Object.keys(tree(srv.dataDir)).some(n => n.endsWith(".tmp")), "清除本次临时文件");
    assert.equal((await c.get("/api/health")).status, 503);
  });
}
test("配置写入期间账户文件损坏也必须阻止配置提交", async t => {
  const { srv, c, ctl } = await live(t, d => { auth(d); config(d); }); const f = path.join(srv.dataDir, "config/admin.json"), before = fs.readFileSync(f);
  fs.writeFileSync(ctl, "corrupt_auth_before_sync config/admin\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
  const result = await c.put("/api/config", { baseVersion: 7, data: cfg("覆盖") });
  assert.equal(result.status, 503); assert.ok(fs.readFileSync(f).equals(before));
  assert.equal(fs.readFileSync(path.join(srv.dataDir, "users.json"), "utf8"), "{injected-corrupt");
  assert.ok(!Object.keys(tree(srv.dataDir)).some(n => n.endsWith(".tmp")));
});
test("程序自身认证文件提交不能被并发请求误判为外部修改", async t => {
  const { srv, c, ctl } = await live(t);
  fs.writeFileSync(ctl, "delay_rename_result sessions\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
  let done = false; const pending = c.post("/api/logout").finally(() => { done = true; });
  let bad = false;
  while (!done) { await sleep(5); if ((await c.get("/api/health")).status !== 200) bad = true; }
  assert.equal((await pending).status, 200); assert.equal(bad, false, "rename 与内存指纹更新之间不能误报损坏");
  assert.equal((await c.get("/api/health")).status, 200);
});
