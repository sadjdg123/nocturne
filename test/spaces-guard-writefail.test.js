"use strict";
/* V2.0 RC · 发布前待办（docs/v2.0-rc-report.md「发布前待办」P-2）：回滚写保护旁路文件写入失败。
 * server.js writeConfig() 里 `await writeGuard(name, doc).catch((e) => log("spaces guard write", …))`：
 * spaces-guard/<user>.json 写不进去（目录不可写 / 磁盘满）时只记一行日志——配置照常保存、接口 200、页面没有任何提示、/api/health 不反映，
 * 旁路文件停在旧版本。之后「回滚到 V1.1 → V1.1 的写入丢掉空间 → 再升级到 V2」时，guardRecover 只比较「配置版本 > 旁路版本」，
 * 于是把**过期的**空间定义写回去：V2 里后来改过的空间被换成旧的，V2 里明确删光的空间被复活。
 * 第 1 个测试记录现状（通过）；第 2、3 个测试写的是期望行为，现在会失败，标为 todo（不阻塞 CI），修复后去掉 todo。
 * 用 chmod 0555 模拟目录不可写：root 不受权限限制，以 root 运行时跳过。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer, client } = require("./helpers");
const { v11Root } = require("./v11");

const V11 = v11Root();
const ROOT_USER = typeof process.getuid === "function" && process.getuid() === 0;
const SKIP = V11.skip || (ROOT_USER ? "以 root 运行：chmod 模拟不了「目录不可写」" : false);
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
const plain = (v) => JSON.parse(JSON.stringify(v));
const disk = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
function tmpData(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-guardfail-"));
  t.after(() => { try { fs.chmodSync(path.join(d, "spaces-guard"), 0o755); } catch (e) { /* ignore */ } fs.rmSync(d, { recursive: true, force: true }); });
  return d;
}
async function run(kind, dataDir, first) {
  const srv = await startServer({ root: kind === "old" ? V11.root : undefined, dataDir });
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

/** V2：A（旁路正常）→ 旁路不可写 → 保存 lastSpaces → 回滚 V1.1 丢掉空间 → 修好磁盘 → 再升级。返回再升级后的配置与日志 */
async function scenario(t, lastSpaces) {
  const dir = tmpData(t);
  let { srv, c } = await run("new", dir, true);
  assert.equal((await c.put("/api/config", { baseVersion: 0, data: Object.assign(serverData(), { spaces: structuredClone(SPACES_A), spacesVersion: 2 }), caps: CAPS })).status, 200);
  assert.equal(disk(dir, "spaces-guard/admin.json").version, 1);
  if (!lockGuard(dir)) { t.skip("目录权限不起作用"); await srv.stop(); return null; }
  const r = await c.put("/api/config", { baseVersion: 1, data: Object.assign(serverData(), { spaces: structuredClone(lastSpaces), spacesVersion: 2 }), caps: CAPS });
  assert.equal(r.status, 200);
  await srv.stop();
  unlockGuard(dir);
  ({ srv, c } = await run("old", dir));
  const cur = (await c.get("/api/config")).json;
  const d = serverData(); d.settings.title = "回滚期间的保存";
  assert.equal((await c.put("/api/config", { baseVersion: cur.version, data: d })).status, 200);
  assert.ok(!("spaces" in disk(dir, "config/admin.json").data), "V1.1 的写入丢掉了空间");
  await srv.stop();
  ({ srv, c } = await run("new", dir));
  const back = (await c.get("/api/config")).json;
  const log = srv.log();
  await srv.stop();
  return { back, log };
}

test("现状：旁路文件写入失败时配置照常保存（200）、接口 / 页面 / health 都没有提示，旁路停在旧版本，只有一行日志", { skip: SKIP, timeout: 60000 }, async (t) => {
  const dir = tmpData(t);
  const { srv, c } = await run("new", dir, true);
  t.after(() => srv.stop());
  assert.equal((await c.put("/api/config", { baseVersion: 0, data: Object.assign(serverData(), { spaces: structuredClone(SPACES_A), spacesVersion: 2 }), caps: CAPS })).status, 200);
  if (!lockGuard(dir)) return t.skip("目录权限不起作用");
  const r = await c.put("/api/config", { baseVersion: 1, data: Object.assign(serverData(), { spaces: structuredClone(SPACES_B), spacesVersion: 2 }), caps: CAPS });
  assert.equal(r.status, 200, "配置保存成功");
  assert.equal(r.json.version, 2);
  assert.deepEqual(Object.keys(r.json).filter((k) => /guard|warn/i.test(k)), [], "响应里没有任何写保护失败的提示");
  assert.deepEqual(plain(disk(dir, "config/admin.json").data.spaces), plain(SPACES_B), "配置文件已是新空间");
  const g = disk(dir, "spaces-guard/admin.json");
  assert.equal(g.version, 1, "旁路文件停在 v1");
  assert.deepEqual(plain(g.spaces), plain(SPACES_A), "旁路里还是旧空间");
  assert.match(srv.log(), /spaces guard write admin EACCES/, "只记了一行日志");
  const h = (await c.get("/api/health")).json;
  assert.ok(!JSON.stringify(h).includes("guard"), "/api/health 不反映（管理员也看不到）");
  const html = (await c.get("/")).body.toString("utf8");
  assert.doesNotMatch(html, /guard|写保护/, "页面启动数据里没有提示");
  unlockGuard(dir);
});

test("期望：旁路过期时，再升级不能把空间换成更旧的版本（现状：换回了 V2 早先的空间）", { skip: SKIP, todo: "P-2：旁路版本校验 / 诊断标记，见 docs/v2.0-rc-report.md", timeout: 90000 }, async (t) => {
  const r = await scenario(t, SPACES_B);
  if (!r) return;
  // 现状：r.back.data.spaces 深等于 SPACES_A（过期），日志 "spaces guard: restored admin 2 spaces"
  assert.notDeepEqual(plain(r.back.data.spaces || null), plain(SPACES_A), "不能用过期的旁路覆盖");
});

test("期望：V2 里明确删光的空间，旁路写入失败后也不能在再升级时复活（现状：复活了）", { skip: SKIP, todo: "P-2：旁路版本校验 / 诊断标记，见 docs/v2.0-rc-report.md", timeout: 90000 }, async (t) => {
  const r = await scenario(t, []);
  if (!r) return;
  assert.equal(r.back.data.spaces, undefined, "删光的空间不应被找回");
});
