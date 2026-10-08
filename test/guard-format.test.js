"use strict";
/* V2.0 RC.3 · P-2 补强：旁路记录必须是 fmt:2 + 合法 h（64 位小写十六进制 sha256），且 h 与配置历史里那个版本的指纹一致，才可用于自动找回。
 * RC.2 的漏洞：guardMatches() 在 h 缺失（RC.1 旧格式：没有 fmt / h）时跳过指纹校验、也不看 fmt，
 * 而 RC.1 写的 hist 条目没有 g:2 标记，于是「RC.1 旁路写入失败（静默）→ 之后删掉空间 → 回滚 V1.1 → 直接升级」会把删掉的空间找回来。
 * RC.3：旧格式 / fmt 不对 / h 不合法 / h 对不上 → 一律不用；后备只看快照环里「最后一个 V2 版本」（g:2 + 版本号 + 指纹），
 * 而且旧格式旁路的版本比那个 V2 版本还新（= RC.1 在那之后又写过）时也不找回——宁可不找回，也不复活 / 换回旧空间。
 * 启动自愈照旧：配置最后是 V2 写的 → 按当前配置重写旁路（只写旁路，不动配置）。
 * RC.1 = 远程 v2@2ee0983（test/rc1.js 按 blob SHA 取出）；RC.1 的旁路写入失败用 test/fsfail.js 注入（RC.1 只记一行日志，静默）。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer, client } = require("./helpers");
const { rc1Root } = require("./rc1");
const { v11Root } = require("./v11");

const RC1 = rc1Root(), V11 = v11Root();
const SKIP = RC1.skip || V11.skip || false;
const FSFAIL = path.join(__dirname, "fsfail.js");
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const SPACES_A = [
  { id: "s-daily", name: "日常", groupIds: ["chips00daily", "dl92kfa0q1z"], theme: "dawn" },
  { id: "s-nas", name: "NAS", groupIds: ["st0rage9kq2"], itemIds: ["e7h2kq9b1m"], theme: "frost", density: "compact" },
];
const SPACES_B = [{ id: "s-daily", name: "日常（新）", groupIds: ["chips00daily", "dl92kfa0q1z", "st0rage9kq2"], theme: "frost" }];
const SPACES_X = [{ id: "s-evil", name: "伪造的旧空间", groupIds: ["chips00daily"], theme: "dawn" }];
const CAPS = ["spaces", "spaces:2"];
const GUARD_TMP = "/spaces-guard/admin\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$";
const plain = (v) => JSON.parse(JSON.stringify(v));
const disk = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const ROOTS = { rc1: () => RC1.root, v11: () => V11.root, new: () => undefined };

function tmpData(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-guardfmt-"));
  const ctl = path.join(d, "..", path.basename(d) + ".fsfail");
  t.after(() => { fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(ctl, { force: true }); });
  return { dir: d, ctl, env: { FSFAIL_CTL: ctl, NODE_OPTIONS: ((process.env.NODE_OPTIONS || "") + " --require " + JSON.stringify(FSFAIL)).trim() } };
}
async function run(kind, T, first) {
  const srv = await startServer({ root: ROOTS[kind](), dataDir: T.dir, env: kind === "v11" ? {} : T.env });
  const c = client(srv.base);
  const r = first ? await c.post("/api/setup", { name: "admin", password: "admin-pass-1" }) : await c.post("/api/login", { name: "admin", password: "admin-pass-1" });
  assert.equal(r.status, 200, kind + " login");
  return { srv, c };
}
const putSpaces = (c, base, spaces) => c.put("/api/config", { baseVersion: base, data: Object.assign(serverData(), { spaces: structuredClone(spaces), spacesVersion: 2 }), caps: CAPS });
async function rollbackDrop(T, force) {
  const { srv, c } = await run("v11", T);
  const cur = (await c.get("/api/config")).json;
  const d = serverData(); d.settings.title = "回滚期间的保存";
  const r = force ? await c.put("/api/config", { baseVersion: 1, data: d, force: true, expectVersion: cur.version }) : await c.put("/api/config", { baseVersion: cur.version, data: d });
  assert.equal(r.status, 200, "V1.1 保存");
  assert.ok(!("spaces" in disk(T.dir, "config/admin.json").data), "V1.1 的写入丢掉了空间");
  await srv.stop();
}
async function reupgrade(T) {
  const { srv, c } = await run("new", T);
  const back = (await c.get("/api/config")).json;
  const health = (await c.get("/api/health")).json;
  const log = srv.log();
  await srv.stop();
  return { back, health, log };
}

/* 1. 真实 RC.1 进程：旁路写入失败（RC.1 静默）→ 之后的修改没进旁路 → 回滚 V1.1 → 直接升级到 RC.3 */
for (const [label, later] of [["删光空间", []], ["改成别的空间", SPACES_B]]) {
  for (const force of [false, true]) {
    test("RC.1 旧格式过期旁路（RC.1 旁路写入失败后" + label + "）→ 回滚 V1.1（" + (force ? "用本机版覆盖" : "普通保存") + "）→ 再升级：不用旧格式旁路，不复活 / 不换回旧空间", { skip: SKIP, timeout: 90000 }, async (t) => {
      const T = tmpData(t);
      let { srv, c } = await run("rc1", T, true);
      assert.equal((await c.get("/api/health")).json.version, "2.0.0-rc.1", "真的是 RC.1");
      assert.equal((await putSpaces(c, 0, SPACES_A)).status, 200);
      const g1 = disk(T.dir, "spaces-guard/admin.json");
      assert.equal(g1.fmt, undefined, "RC.1 写的是旧格式旁路（没有 fmt / h）");
      assert.equal(g1.version, 1);
      fs.writeFileSync(T.ctl, "open " + GUARD_TMP + "\n"); // 旁路目录写不进去（磁盘满）
      const r2 = await putSpaces(c, 1, later);
      assert.equal(r2.status, 200, "RC.1 照常保存配置");
      assert.equal(r2.json.guardWarning, undefined, "RC.1 不提示（静默失败，这正是要防的情况）");
      assert.match(srv.log(), /spaces guard write admin/);
      await srv.stop();
      fs.writeFileSync(T.ctl, "");
      assert.equal(disk(T.dir, "spaces-guard/admin.json").version, 1, "旁路停在 v1（过期）");
      assert.deepEqual(plain(disk(T.dir, "config/admin.json").data.spaces), plain(later));

      await rollbackDrop(T, force);
      const r = await reupgrade(T);
      assert.notDeepEqual(plain(r.back.data.spaces || null), plain(SPACES_A), "不能用 RC.1 的过期旁路把 v1 的空间写回来");
      assert.equal(r.back.data.spaces, undefined, "旧格式旁路不用于自动找回；RC.1 的 hist 没有 g:2，快照环里没有可确认的 V2 版本 → 不找回");
      assert.equal(r.back.data.settings.title, "回滚期间的保存", "V1.1 的修改保留");
      assert.doesNotMatch(r.log, /spaces guard: restored/);
      assert.match(r.log, /spaces guard: stale admin guard v1 has an old or invalid format/);
      assert.equal(r.health.guard.ok, false, "管理员诊断里能看到");
      assert.equal(r.health.guard.issues.find((x) => x.user === "admin").kind, "stale");
    });
  }
}

/* 2. 新版写的数据，旁路被换成各种不合格的记录：不能用于找回 */
async function v2ThenDrop(t) {
  const T = tmpData(t);
  const { srv, c } = await run("new", T, true);
  assert.equal((await putSpaces(c, 0, SPACES_A)).status, 200);
  assert.equal((await putSpaces(c, 1, SPACES_B)).status, 200);
  await srv.stop();
  const g0 = disk(T.dir, "spaces-guard/admin.json");
  assert.equal(g0.fmt, 2); assert.equal(g0.version, 2); assert.match(g0.h, /^[0-9a-f]{64}$/);
  await rollbackDrop(T, false);
  return { T, g0 };
}
const BAD = {
  "h 缺失（fmt:2）": (g) => { const x = Object.assign({}, g); delete x.h; return x; },
  "h 为 null": (g) => Object.assign({}, g, { h: null }),
  "h 不是十六进制": (g) => Object.assign({}, g, { h: "z".repeat(64) }),
  "h 长度不对": (g) => Object.assign({}, g, { h: g.h.slice(0, 40) }),
  "h 大写": (g) => Object.assign({}, g, { h: g.h.toUpperCase() }),
  "h 是数字": (g) => Object.assign({}, g, { h: 12345 }),
  "fmt 缺失（旧格式，h 却是对的）": (g) => { const x = Object.assign({}, g); delete x.fmt; return x; },
  "fmt:1": (g) => Object.assign({}, g, { fmt: 1 }),
  "fmt:3": (g) => Object.assign({}, g, { fmt: 3 }),
  "fmt:\"2\"（字符串）": (g) => Object.assign({}, g, { fmt: "2" }),
  "fmt:2 但 h 对不上": (g) => Object.assign({}, g, { h: "0".repeat(64) }),
};
for (const [why, mk] of Object.entries(BAD)) {
  test("不合格的旁路（" + why + "）+ 篡改过的空间 → 再升级不使用它", { skip: SKIP, timeout: 90000 }, async (t) => {
    const { T, g0 } = await v2ThenDrop(t);
    fs.writeFileSync(path.join(T.dir, "spaces-guard/admin.json"), JSON.stringify(Object.assign(mk(g0), { spaces: SPACES_X })));
    const r = await reupgrade(T);
    assert.notDeepEqual(plain(r.back.data.spaces || null), plain(SPACES_X), "不能找回旁路里的空间");
    assert.doesNotMatch(r.log, /spaces guard: restored admin .*source: guard/);
    assert.match(r.log, /spaces guard: stale admin guard v2 (has an old or invalid format|hash does not match)/);
  });
}
test("对照：合格的 fmt:2 旁路（h 与配置历史一致）照常找回", { skip: SKIP, timeout: 90000 }, async (t) => {
  const { T } = await v2ThenDrop(t);
  const r = await reupgrade(T);
  assert.deepEqual(plain(r.back.data.spaces), plain(SPACES_B));
  assert.match(r.log, /spaces guard: restored admin 1 spaces .*source: guard v2/);
});

/* 3. 启动自愈：最后是 V2 写的配置 + 不合格旁路 → 重写成 fmt:2；配置文件逐字节不变 */
test("启动自愈：fmt 不是数字 2 / h 不合法的旁路一律按当前 V2 配置重写，配置文件不变", { skip: SKIP, timeout: 90000 }, async (t) => {
  const T = tmpData(t);
  let { srv, c } = await run("new", T, true);
  assert.equal((await putSpaces(c, 0, SPACES_B)).status, 200);
  await srv.stop();
  const gf = path.join(T.dir, "spaces-guard/admin.json"), cf = path.join(T.dir, "config/admin.json");
  const g0 = disk(T.dir, "spaces-guard/admin.json"), cfg = fs.readFileSync(cf);
  for (const [why, g] of [["invalid format", Object.assign({}, g0, { fmt: 3 })], ["invalid format", Object.assign({}, g0, { fmt: "2" })], ["invalid format", Object.assign({}, g0, { h: g0.h.toUpperCase() })]]) {
    fs.writeFileSync(gf, JSON.stringify(Object.assign(g, { spaces: SPACES_X })));
    ({ srv, c } = await run("new", T));
    const log = srv.log();
    await srv.stop();
    assert.ok(log.includes("spaces guard: healed admin v1 (" + why + ")"), JSON.stringify(g).slice(0, 60) + "：" + log);
    const h = disk(T.dir, "spaces-guard/admin.json");
    assert.equal(h.fmt, 2); assert.equal(h.h, g0.h); assert.deepEqual(plain(h.spaces), plain(SPACES_B));
    assert.deepEqual(fs.readFileSync(cf), cfg, "配置文件逐字节不变");
  }
});
