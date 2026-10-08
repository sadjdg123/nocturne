"use strict";
/* V2.0 RC.2 · RC.1 → RC.2 → RC.1 数据兼容（真实进程，同一个 data 目录来回切换版本）。
 * RC.1 = 远程 v2@2ee0983（2.0.0-rc.1，NAS 上已部署的镜像 sha-2ee0983）的 server.js + 前端，按 blob SHA 从 git 取出（test/rc1.js）；
 * V1.1 = main@3e6da3c（test/v11.js）。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer, client, sleep } = require("./helpers");
const { rc1Root } = require("./rc1");
const { v11Root } = require("./v11");

const RC1 = rc1Root(), V11 = v11Root();
const SKIP = RC1.skip || V11.skip || false;
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const SPACES_1 = [
  { id: "s-daily", name: "日常", groupIds: ["chips00daily", "dl92kfa0q1z"], theme: "dawn" },
  { id: "s-nas", name: "NAS", groupIds: ["st0rage9kq2"], itemIds: ["e7h2kq9b1m"], theme: "frost", density: "compact" },
];
const SPACES_2 = [{ id: "s-daily", name: "日常（RC.2 改）", groupIds: ["chips00daily"], theme: "frost" }];
const SPACES_3 = [{ id: "s-rc1", name: "回到 RC.1 后新建", groupIds: ["st0rage9kq2"], theme: "dawn" }, ...SPACES_2];
const CAPS = ["spaces", "spaces:2"];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2048), Buffer.from([0xff, 0xd9])]);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const plain = (v) => JSON.parse(JSON.stringify(v));
const disk = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const ROOTS = { rc1: () => RC1.root, rc2: () => undefined, v11: () => V11.root };

async function boot(kind, dir) { return startServer({ root: ROOTS[kind](), dataDir: dir }); }
/** 用已有 cookie 罐（模拟同一台设备）在新版本上继续 */
function reuse(c, base) { const n = client(base); for (const [k, v] of c.jar) n.jar.set(k, v); return n; }
async function login(base, name, pass) { const c = client(base); assert.equal((await c.post("/api/login", { name, password: pass })).status, 200, "login " + name); return c; }

test("RC.1 写的数据 → RC.2 原样可用（会话 / 已知设备 / 登录 / 配置 / 空间 / 图标 / 壁纸 / 第二账户 / 快照环）+ 旁路启动自愈；RC.2 → RC.1 回滚照常读写", { skip: SKIP, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-rc1compat-"));
  let srv;
  t.after(async () => { if (srv && srv.child.exitCode == null && srv.child.signalCode == null) await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  // 1. RC.1：初始化、图标、带空间的配置、壁纸、第二个账户
  srv = await boot("rc1", dir);
  let c = client(srv.base);
  assert.equal((await c.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  assert.equal((await c.get("/api/health")).json.version, "2.0.0-rc.1", "真的是 RC.1");
  const up = await c.req("POST", "/api/icons", PNG, { "Content-Type": "image/png" });
  assert.equal(up.status, 200);
  const d1 = Object.assign(serverData(), { spaces: structuredClone(SPACES_1), spacesVersion: 2 });
  d1.groups[0].items[0].icon = { type: "image", value: up.json.url, bg: "" };
  assert.equal((await c.put("/api/config", { baseVersion: 0, data: d1, caps: CAPS })).status, 200);
  assert.equal((await c.req("PUT", "/api/wallpaper", JPG, { "Content-Type": "image/jpeg" })).status, 200);
  let cur = (await c.get("/api/config")).json; cur.data.settings.wallpaper = { id: "custom", file: true, v: 1, url: "" };
  assert.equal((await c.put("/api/config", { baseVersion: cur.version, data: cur.data, caps: CAPS })).status, 200);
  assert.equal((await c.post("/api/users", { name: "bob", password: "bob-pass-12" })).status, 200);
  await sleep(2500); // sessions.json 是 2 秒防抖写入；测试用 SIGKILL 停进程，等它落盘（模拟正常运行一段时间后升级）
  await srv.stop();
  const rc1Cfg = fs.readFileSync(path.join(dir, "config/admin.json")), rc1Guard = disk(dir, "spaces-guard/admin.json");
  const rc1Users = fs.readFileSync(path.join(dir, "users.json"));
  assert.equal(rc1Guard.fmt, undefined, "RC.1 的旁路是旧格式（没有 fmt / h）");
  const v1 = JSON.parse(rc1Cfg).version;

  // 2. 升级到 RC.2
  srv = await boot("rc2", dir);
  assert.equal((await fetch(srv.base + "/api/health").then((r) => r.json())).version, require("../package.json").version);
  c = reuse(c, srv.base);
  assert.equal(((await c.get("/api/me")).json.user || {}).name, "admin", "RC.1 发的会话 cookie 在 RC.2 继续有效（默认 cookie 名不变）");
  assert.deepEqual(fs.readFileSync(path.join(dir, "users.json")), rc1Users, "启动不改 users.json");
  const fresh = await login(srv.base, "admin", "admin-pass-1"); // 登录会记一台新的已知设备（正常写入）
  assert.ok(fresh.jar.has("nocturne_sid") && fresh.jar.has("nocturne_dev"));
  const g2 = (await c.get("/api/config")).json;
  assert.equal(g2.version, v1, "读取不产生新版本");
  assert.deepEqual(plain(g2.data), plain(JSON.parse(rc1Cfg).data), "配置内容与 RC.1 写的完全相同");
  assert.deepEqual(fs.readFileSync(path.join(dir, "config/admin.json")), rc1Cfg, "配置文件逐字节不变（自愈只写旁路）");
  assert.equal(sha((await c.get("/" + up.json.url)).body), sha(PNG), "图标");
  assert.equal(sha((await c.get("/api/wallpaper")).body), sha(JPG), "壁纸");
  await login(srv.base, "bob", "bob-pass-12");
  assert.ok(Array.isArray((await c.get("/api/config/backups")).json), "快照环可读");
  const healed = disk(dir, "spaces-guard/admin.json");
  assert.equal(healed.fmt, 2); assert.equal(healed.version, v1); assert.match(healed.h, /^[0-9a-f]{64}$/);
  assert.deepEqual(plain(healed.spaces), plain(SPACES_1));
  assert.match(srv.log(), /spaces guard: healed admin v\d+ \(old format\)/);
  assert.equal((await c.get("/api/health")).json.guard.ok, true);
  // RC.2 保存一次：hist 条目带 g:2，旁路 fmt:2
  assert.equal((await c.put("/api/config", { baseVersion: v1, data: Object.assign(structuredClone(g2.data), { spaces: structuredClone(SPACES_2) }), caps: CAPS })).status, 200);
  const rc2Cfg = disk(dir, "config/admin.json");
  assert.equal(rc2Cfg.hist[rc2Cfg.hist.length - 1].g, 2);
  assert.equal(disk(dir, "spaces-guard/admin.json").version, v1 + 1);
  await sleep(2500);
  await srv.stop();
  assert.deepEqual(fs.readdirSync(path.join(dir, "config")).filter((f) => f.endsWith(".tmp")), []);

  // 3. 回滚到 RC.1：读 RC.2 写的配置 / 旁路，照常保存
  srv = await boot("rc1", dir);
  c = reuse(c, srv.base);
  assert.equal(((await c.get("/api/me")).json.user || {}).name, "admin", "RC.2 期间的会话在 RC.1 有效");
  const g3 = (await c.get("/api/config")).json;
  assert.equal(g3.version, v1 + 1);
  assert.deepEqual(plain(g3.data.spaces), plain(SPACES_2), "RC.1 读到 RC.2 写的空间");
  assert.equal(sha((await c.get("/" + up.json.url)).body), sha(PNG));
  assert.equal(sha((await c.get("/api/wallpaper")).body), sha(JPG));
  assert.equal((await c.put("/api/config", { baseVersion: g3.version, data: Object.assign(structuredClone(g3.data), { spaces: structuredClone(SPACES_3) }), caps: CAPS })).status, 200, "RC.1 照常保存");
  const afterRc1 = disk(dir, "config/admin.json");
  assert.ok(afterRc1.hist.some((x) => x.v === v1 + 1 && x.g === 2), "RC.1 原样保留 RC.2 的 hist 标记");
  assert.equal(disk(dir, "spaces-guard/admin.json").fmt, undefined, "RC.1 把旁路写回旧格式（预期，RC.2 能读）");
  assert.doesNotMatch(srv.log(), /error|TypeError/i);
  await srv.stop();

  // 4. RC.1 → V1.1（「用本机版覆盖」丢掉空间）→ 直接升到 RC.2：用 RC.1 写的旧格式旁路找回 RC.1 最后的空间
  srv = await boot("v11", dir);
  c = await login(srv.base, "admin", "admin-pass-1");
  cur = (await c.get("/api/config")).json;
  const stale = serverData(); stale.settings.title = "V1.1 旧设备覆盖";
  assert.equal((await c.put("/api/config", { baseVersion: 1, data: stale, force: true, expectVersion: cur.version })).status, 200);
  assert.ok(!("spaces" in disk(dir, "config/admin.json").data));
  await srv.stop();
  srv = await boot("rc2", dir);
  c = await login(srv.base, "admin", "admin-pass-1");
  const back = (await c.get("/api/config")).json;
  assert.deepEqual(plain(back.data.spaces), plain(SPACES_3), "找回的是 RC.1 最后写的空间");
  assert.equal(back.data.settings.title, "V1.1 旧设备覆盖");
  assert.match(srv.log(), /spaces guard: restored admin 2 spaces .*source: guard v\d+/);
  await srv.stop();

  // 5. 找回之后再回滚到 RC.1：照常读，页面提示数据可读
  srv = await boot("rc1", dir);
  c = await login(srv.base, "admin", "admin-pass-1");
  const g5 = (await c.get("/api/config")).json;
  assert.deepEqual(plain(g5.data.spaces), plain(SPACES_3));
  assert.equal(g5.recovered && g5.recovered.spaces, 2, "RC.1 能读 RC.2 写的 recovered 提示");
  await srv.stop();
});
