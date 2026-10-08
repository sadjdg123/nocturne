"use strict";
/* V2.0 RC.2 · P-2：回滚写保护旁路文件（spaces-guard/<user>.json）写入失败。
 * RC.1 的问题：writeConfig() 里旁路写入失败被吞掉、只记一行日志；旁路停在旧版本，之后「回滚到 V1.1 → V1.1 的写入丢掉空间 → 再升级」
 * 时把**过期**空间写回去（改过的空间被换成旧的、明确删光的空间被复活）。
 * RC.2：旁路绑定配置版本 + 指纹（fmt:2 / version / h），配置 hist 里 V2 写的版本带 g:2；写入失败 → 删掉旧旁路（删不掉由校验拦住）、
 * 错误日志、保存响应 guardWarning、管理员 /api/health 的 guard；找回前校验，校验不过只用快照环里版本号 + 指纹都对上的「最后一个 V2 版本」；
 * 启动自愈按当前 V2 配置重写旁路。
 * 故障：chmod 0555（目录不可写，root 下跳过）/ test/fsfail.js 注入 ENOSPC 半截写、EIO、rename 失败（root 下也能跑）/ 直接写坏旁路文件。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer, client } = require("./helpers");
const { v11Root } = require("./v11");

const V11 = v11Root();
const ROOT_USER = typeof process.getuid === "function" && process.getuid() === 0;
const SKIP = V11.skip || false;
const SKIP_CHMOD = SKIP || (ROOT_USER ? "以 root 运行：chmod 模拟不了「目录不可写」" : false);
const FSFAIL = path.join(__dirname, "fsfail.js");
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const SPACES_A = [
  { id: "s-daily", name: "日常", groupIds: ["chips00daily", "dl92kfa0q1z"], theme: "dawn" },
  { id: "s-nas", name: "NAS", groupIds: ["st0rage9kq2"], itemIds: ["e7h2kq9b1m"], theme: "frost", density: "compact" },
];
const SPACES_B = [ // V2 里后来的修改：改名 + 换主题 + 去掉一个空间
  { id: "s-daily", name: "日常（新）", groupIds: ["chips00daily", "dl92kfa0q1z", "st0rage9kq2"], theme: "frost" },
];
const CAPS = ["spaces", "spaces:2"];
const GUARD_TMP = "/spaces-guard/admin\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$";
const plain = (v) => JSON.parse(JSON.stringify(v));
const disk = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const tmps = (dir) => fs.readdirSync(path.join(dir, "spaces-guard")).filter((f) => f.endsWith(".tmp"));

function tmpData(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-guardfail-"));
  const ctl = path.join(d, "..", path.basename(d) + ".fsfail");
  t.after(() => { try { fs.chmodSync(path.join(d, "spaces-guard"), 0o755); } catch (e) { /* ignore */ } fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(ctl, { force: true }); });
  return { dir: d, ctl, env: { FSFAIL_CTL: ctl, NODE_OPTIONS: ((process.env.NODE_OPTIONS || "") + " --require " + JSON.stringify(FSFAIL)).trim() } };
}
async function run(kind, T, first) {
  const srv = await startServer({ root: kind === "old" ? V11.root : undefined, dataDir: T.dir, env: kind === "old" ? {} : T.env });
  const c = client(srv.base);
  const r = first ? await c.post("/api/setup", { name: "admin", password: "admin-pass-1" }) : await c.post("/api/login", { name: "admin", password: "admin-pass-1" });
  assert.equal(r.status, 200, kind + " login");
  return { srv, c };
}
function lockGuard(dir) { // 模拟 spaces-guard/ 不可写；确认真的写不进去
  const g = path.join(dir, "spaces-guard");
  fs.chmodSync(g, 0o555);
  try { fs.writeFileSync(path.join(g, "probe"), "x"); fs.rmSync(path.join(g, "probe")); return false; } catch (e) { return true; }
}
const unlockGuard = (dir) => fs.chmodSync(path.join(dir, "spaces-guard"), 0o755);
const putSpaces = (c, base, spaces) => c.put("/api/config", { baseVersion: base, data: Object.assign(serverData(), { spaces: structuredClone(spaces), spacesVersion: 2 }), caps: CAPS });

/** 回滚到 V1.1，写一次丢掉空间（force：「用本机版覆盖」，V1.1 会把被替换的版本存进快照环）；返回 V1.1 写完后的配置 */
async function rollbackDrop(T, force) {
  const { srv, c } = await run("old", T);
  const cur = (await c.get("/api/config")).json;
  const d = serverData(); d.settings.title = "回滚期间的保存";
  const r = force ? await c.put("/api/config", { baseVersion: 1, data: d, force: true, expectVersion: cur.version }) : await c.put("/api/config", { baseVersion: cur.version, data: d });
  assert.equal(r.status, 200, "V1.1 保存");
  const lost = disk(T.dir, "config/admin.json");
  assert.ok(!("spaces" in lost.data), "V1.1 的写入丢掉了空间");
  await srv.stop();
  return lost;
}
async function reupgrade(T) {
  const { srv, c } = await run("new", T);
  const back = (await c.get("/api/config")).json;
  const log = srv.log();
  await srv.stop();
  return { back, log };
}

/** V2：v1 = SPACES_A（旁路正常）→ 注入旁路写入故障 → v2 = lastSpaces。返回这次保存的响应与诊断 */
async function failedGuardSave(t, T, how, lastSpaces) {
  const { srv, c } = await run("new", T, true);
  assert.equal((await putSpaces(c, 0, SPACES_A)).status, 200);
  assert.equal(disk(T.dir, "spaces-guard/admin.json").version, 1);
  if (how === "eacces") { if (!lockGuard(T.dir)) { await srv.stop(); return null; } } else fs.writeFileSync(T.ctl, how + " " + GUARD_TMP + "\n");
  const r = await putSpaces(c, 1, lastSpaces);
  const health = (await c.get("/api/health")).json;
  const anon = (await fetch(srv.base + "/api/health").then((x) => x.json()));
  const log = srv.log();
  await srv.stop();
  if (how === "eacces") unlockGuard(T.dir); else fs.writeFileSync(T.ctl, ""); // 「修好磁盘」
  return { r, health, anon, log };
}

for (const how of ["eacces", "enospc", "partial", "rename"]) {
  const opt = { skip: how === "eacces" ? SKIP_CHMOD : SKIP, timeout: 90000 };
  test("旁路写入失败（" + how + "）：配置照常保存，但不静默——响应 guardWarning、管理员 health、错误日志；旧旁路作废或被校验拦住、不留临时文件", opt, async (t) => {
    const T = tmpData(t);
    const f = await failedGuardSave(t, T, how, SPACES_B);
    if (!f) return t.skip("目录权限不起作用");
    assert.equal(f.r.status, 200, "配置保存成功");
    assert.equal(f.r.json.version, 2);
    assert.equal(f.r.json.guardWarning, "spaces_guard_write_failed", "响应带警告");
    assert.deepEqual(plain(disk(T.dir, "config/admin.json").data.spaces), plain(SPACES_B), "配置文件已是新空间");
    assert.equal(f.health.guard.ok, false, "管理员 /api/health：guard 不正常");
    const issue = f.health.guard.issues.find((x) => x.user === "admin");
    assert.equal(issue.kind, "write_failed"); assert.equal(issue.error, how === "eacces" ? "EACCES" : how === "partial" ? "EIO" : "ENOSPC");
    assert.equal(f.anon.guard, undefined, "未登录看不到诊断");
    assert.match(f.log, /ERROR spaces guard write failed admin (EACCES|ENOSPC|EIO)/);
    assert.deepEqual(tmps(T.dir), [], "没有残留临时文件");
    if (how === "eacces") {
      assert.equal(issue.invalidated, false, "目录不可写：旧旁路删不掉");
      assert.equal(disk(T.dir, "spaces-guard/admin.json").version, 1, "旧旁路还在（过期），靠版本 + 指纹校验拦住");
      const cfg = disk(T.dir, "config/admin.json");
      assert.ok(cfg.hist.some((x) => x.v === 2 && x.g === 2), "配置历史里记着 v2 是 V2 写的");
    } else {
      assert.equal(issue.invalidated, true);
      assert.ok(!fs.existsSync(path.join(T.dir, "spaces-guard/admin.json")), "旧旁路被删掉（作废）");
    }
  });

  test("旁路写入失败（" + how + "）→ 回滚 V1.1 普通保存丢掉空间 → 再升级：不能换回更旧的空间（快照环里没有最后的 V2 版本：不找回，记日志）", opt, async (t) => {
    const T = tmpData(t);
    const f = await failedGuardSave(t, T, how, SPACES_B);
    if (!f) return t.skip("目录权限不起作用");
    await rollbackDrop(T, false);
    const r = await reupgrade(T);
    assert.notDeepEqual(plain(r.back.data.spaces || null), plain(SPACES_A), "不能用过期的旁路覆盖");
    assert.equal(r.back.data.spaces, undefined, "校验不过、快照环里也没有 v2：不找回");
    assert.equal(r.back.data.settings.title, "回滚期间的保存", "V1.1 的修改保留");
    assert.match(r.log, /spaces guard: skipped admin last V2 version v2 is not in the backup ring/);
    if (how === "eacces") assert.match(r.log, /spaces guard: stale admin config v2 was written by V2 after guard v1/);
    assert.doesNotMatch(r.log, /spaces guard: restored/);
  });
}

test("旁路写入失败 → 回滚 V1.1「用本机版覆盖」（被替换的 v2 进了快照环）→ 再升级：找回的是最后的 V2 空间（SPACES_B），不是旧旁路里的", { skip: SKIP_CHMOD, timeout: 90000 }, async (t) => {
  const T = tmpData(t);
  const f = await failedGuardSave(t, T, "eacces", SPACES_B);
  if (!f) return t.skip("目录权限不起作用");
  await rollbackDrop(T, true);
  const r = await reupgrade(T);
  assert.deepEqual(plain(r.back.data.spaces), plain(SPACES_B), "从快照环里版本号 + 指纹都对上的 v2 找回");
  assert.equal(r.back.data.settings.title, "回滚期间的保存");
  assert.equal(r.back.recovered.spaces, 1);
  assert.match(r.log, /spaces guard: restored admin 1 spaces .*source: backup v2/);
});

for (const how of ["eacces", "enospc"]) {
  test("V2 里明确删光的空间（" + how + "：旁路写入失败）→ 回滚 → 再升级：不复活（普通保存 / 用本机版覆盖都一样）", { skip: how === "eacces" ? SKIP_CHMOD : SKIP, timeout: 120000 }, async (t) => {
    for (const force of [false, true]) {
      const T = tmpData(t);
      const f = await failedGuardSave(t, T, how, []);
      if (!f) return t.skip("目录权限不起作用");
      assert.equal(f.r.json.guardWarning, "spaces_guard_write_failed");
      await rollbackDrop(T, force);
      const r = await reupgrade(T);
      assert.equal(r.back.data.spaces, undefined, "删光的空间不应被找回（force=" + force + "）");
      assert.doesNotMatch(r.log, /spaces guard: restored/);
    }
  });
}

test("旁路写入失败后磁盘修好、V2 重启（启动自愈按当前配置重写旁路）→ 回滚 → 再升级：找回最新的空间", { skip: SKIP, timeout: 90000 }, async (t) => {
  const T = tmpData(t);
  const f = await failedGuardSave(t, T, "enospc", SPACES_B);
  assert.equal(f.r.json.guardWarning, "spaces_guard_write_failed");
  const cfgBefore = fs.readFileSync(path.join(T.dir, "config/admin.json"));
  let { srv, c } = await run("new", T);
  const g = disk(T.dir, "spaces-guard/admin.json");
  assert.equal(g.fmt, 2); assert.equal(g.version, 2); assert.deepEqual(plain(g.spaces), plain(SPACES_B));
  assert.match(srv.log(), /spaces guard: healed admin v2 \(missing\)/);
  assert.equal((await c.get("/api/health")).json.guard.ok, true, "自愈后诊断恢复正常");
  assert.deepEqual(fs.readFileSync(path.join(T.dir, "config/admin.json")), cfgBefore, "自愈只写旁路，配置文件逐字节不变");
  await srv.stop();
  await rollbackDrop(T, false);
  const r = await reupgrade(T);
  assert.deepEqual(plain(r.back.data.spaces), plain(SPACES_B));
  assert.match(r.log, /spaces guard: restored admin 1 spaces .*source: guard v2/);
});

test("启动自愈：旁路缺失 / 写坏（半截 JSON）/ 旧格式（RC.1）/ 版本落后 → 按当前 V2 配置重写；已经一致时不写；配置文件始终不变", { skip: SKIP, timeout: 90000 }, async (t) => {
  const T = tmpData(t);
  let { srv, c } = await run("new", T, true);
  assert.equal((await putSpaces(c, 0, SPACES_A)).status, 200);
  assert.equal((await putSpaces(c, 1, SPACES_B)).status, 200);
  await srv.stop();
  const gf = path.join(T.dir, "spaces-guard/admin.json"), cf = path.join(T.dir, "config/admin.json");
  const good = fs.readFileSync(gf), cfg = fs.readFileSync(cf);
  const g0 = JSON.parse(good);
  assert.equal(g0.fmt, 2); assert.equal(g0.version, 2); assert.match(g0.h, /^[0-9a-f]{64}$/);
  const legacy = Object.assign({}, g0); delete legacy.fmt; delete legacy.h;
  const cases = {
    missing: () => fs.rmSync(gf),
    unreadable: () => fs.writeFileSync(gf, good.subarray(0, Math.floor(good.length / 2))),
    "old format": () => fs.writeFileSync(gf, JSON.stringify(legacy)),
    "guard v1 != config v2": () => fs.writeFileSync(gf, JSON.stringify(Object.assign({}, g0, { version: 1, spaces: SPACES_A }))),
    "hash mismatch": () => fs.writeFileSync(gf, JSON.stringify(Object.assign({}, g0, { h: "0".repeat(64) }))),
  };
  for (const [why, damage] of Object.entries(cases)) {
    damage();
    ({ srv, c } = await run("new", T));
    const log = srv.log();
    await srv.stop();
    assert.ok(log.includes("spaces guard: healed admin v2 (" + why + ")"), why + "：" + log);
    const g = disk(T.dir, "spaces-guard/admin.json");
    assert.equal(g.fmt, 2); assert.equal(g.version, 2); assert.equal(g.h, g0.h); assert.deepEqual(plain(g.spaces), plain(SPACES_B));
    assert.deepEqual(fs.readFileSync(cf), cfg, why + "：配置文件逐字节不变");
  }
  ({ srv, c } = await run("new", T));
  assert.doesNotMatch(srv.log(), /spaces guard: healed/, "一致时不重写");
  await srv.stop();
});

test("写坏的旁路 + 已被 V1.1 写过的配置（不能自愈）：再升级不复活，只按快照环里对得上的 V2 版本找回", { skip: SKIP, timeout: 90000 }, async (t) => {
  const T = tmpData(t);
  let { srv, c } = await run("new", T, true);
  assert.equal((await putSpaces(c, 0, SPACES_A)).status, 200);
  assert.equal((await putSpaces(c, 1, [])).status, 200, "V2 里删光空间");
  await srv.stop();
  fs.writeFileSync(path.join(T.dir, "spaces-guard/admin.json"), JSON.stringify({ version: 1, spaces: SPACES_A })); // 伪造一份过期的旧格式旁路
  await rollbackDrop(T, true);
  const r = await reupgrade(T);
  assert.equal(r.back.data.spaces, undefined, "旧旁路 v1 之后有 V2 写的 v2 → 过期；快照环里的 v2 是 [] → 不找回");
  assert.match(r.log, /spaces guard: stale admin config v2 was written by V2 after guard v1/);
});
