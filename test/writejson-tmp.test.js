"use strict";
/* V2.0 RC.2 · P-3：原子写入失败不留临时文件、不碰目标文件；启动时只清理确定是自己留下的过期临时文件。
 * 故障注入：test/fsfail.js（NODE_OPTIONS=--require 预加载到 server.js 子进程，控制文件里写规则，运行中途可开关）。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { startServer, client, cfg, waitFor } = require("./helpers");

const FSFAIL = path.join(__dirname, "fsfail.js");
const tmpsIn = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")); } catch (e) { return []; } };
function failEnv(t) {
  const ctl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-fsfail-")), "ctl");
  t.after(() => fs.rmSync(path.dirname(ctl), { recursive: true, force: true }));
  return { ctl, env: { FSFAIL_CTL: ctl, NODE_OPTIONS: ((process.env.NODE_OPTIONS || "") + " --require " + JSON.stringify(FSFAIL)).trim() } };
}
async function admin(srv) {
  const c = client(srv.base);
  assert.equal((await c.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  return c;
}

for (const mode of ["enospc", "partial", "open", "rename"]) {
  test("配置写入故障（" + mode + "）：请求失败、配置文件保持写入前的完整内容、不留临时文件", { timeout: 30000 }, async (t) => {
    const { ctl, env } = failEnv(t);
    const srv = await startServer({ env });
    t.after(() => srv.stop());
    const c = await admin(srv);
    assert.equal((await c.put("/api/config", { baseVersion: 0, data: cfg("写入前") })).status, 200);
    const file = path.join(srv.dataDir, "config", "admin.json"), before = fs.readFileSync(file);
    fs.writeFileSync(ctl, mode + " /config/admin\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
    const r = await c.put("/api/config", { baseVersion: 1, data: cfg("写入失败的这次") });
    assert.equal(r.status, 500, "保存失败如实返回错误");
    assert.deepEqual(fs.readFileSync(file), before, "目标文件逐字节不变");
    assert.deepEqual(tmpsIn(path.join(srv.dataDir, "config")), [], "没有残留临时文件");
    fs.writeFileSync(ctl, "");
    const g = (await c.get("/api/config")).json;
    assert.equal(g.version, 1); assert.equal(g.data.settings.title, "写入前");
    assert.equal((await c.put("/api/config", { baseVersion: 1, data: cfg("恢复后") })).status, 200, "磁盘恢复后照常保存");
    assert.deepEqual(tmpsIn(path.join(srv.dataDir, "config")), []);
  });
}

test("图标 / 壁纸（writeFileAtomic）写入 ENOSPC：失败、不留临时文件", { timeout: 30000 }, async (t) => {
  const { ctl, env } = failEnv(t);
  const srv = await startServer({ env });
  t.after(() => srv.stop());
  const c = await admin(srv);
  fs.writeFileSync(ctl, "enospc /(wallpapers|icons)/.*\\.tmp$\n");
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 7), Buffer.from([0xff, 0xd9])]);
  const w = await c.req("PUT", "/api/wallpaper", jpg, { "Content-Type": "image/jpeg" });
  assert.ok(w.status >= 500, "壁纸保存失败：" + w.status);
  assert.deepEqual(tmpsIn(path.join(srv.dataDir, "wallpapers")), []);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const i = await c.req("POST", "/api/icons", png, { "Content-Type": "image/png" });
  assert.ok(i.status >= 500, "图标保存失败：" + i.status);
  assert.deepEqual(tmpsIn(path.join(srv.dataDir, "icons", "admin")), []);
});

test("启动清理：只删符合 <名字>.<pid>.<8 位十六进制>.tmp、超过 1 小时、pid 已不在的普通文件；别的进程 / 新的 / 不符合格式的不动", { timeout: 30000 }, async (t) => {
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString(); // 已退出的进程 pid
  assert.match(dead, /^\d+$/);
  const old = new Date(Date.now() - 2 * 3600e3);
  const files = {
    gone: ["config/admin.json." + dead + ".0a1b2c3d.tmp", "spaces-guard/admin.json." + dead + ".deadbeef.tmp", "users.json." + dead + ".12345678.tmp", "backup/admin/000000000000001-000001-v1.json." + dead + ".abcdef01.tmp"],
    kept: [
      "config/admin.json." + process.pid + ".0a1b2c3d.tmp", // 正在运行的进程（测试进程自己）
      "config/admin.json." + dead + ".11111111.tmp", // 新的（下面不改 mtime）
      "config/notes.tmp", "config/admin.json.123.zz.tmp", "config/admin.json." + dead + ".0a1b2c3d.tmp.bak", "cache/foo." + dead + ".0a1b2c3d.tmp",
    ],
  };
  const srv = await startServer({
    seed: (d) => {
      for (const sub of ["config", "spaces-guard", "backup/admin", "cache"]) fs.mkdirSync(path.join(d, sub), { recursive: true });
      fs.writeFileSync(path.join(d, "config", "admin.json"), JSON.stringify({ version: 3, data: cfg("目标") }));
      for (const f of [...files.gone, ...files.kept]) {
        fs.writeFileSync(path.join(d, f), "{\"half\":");
        if (!f.includes(".11111111.")) fs.utimesSync(path.join(d, f), old, old);
      }
      fs.mkdirSync(path.join(d, "config", "dir." + dead + ".0a1b2c3d.tmp")); // 目录：不删
      fs.utimesSync(path.join(d, "config", "dir." + dead + ".0a1b2c3d.tmp"), old, old);
    },
  });
  t.after(() => srv.stop());
  const d = srv.dataDir;
  assert.ok(await waitFor(() => files.gone.every((f) => !fs.existsSync(path.join(d, f))), 5000), "过期的残留临时文件被删掉：" + srv.log());
  for (const f of files.kept) assert.ok(fs.existsSync(path.join(d, f)), "保留：" + f);
  assert.ok(fs.existsSync(path.join(d, "config", "dir." + dead + ".0a1b2c3d.tmp")), "同名目录不删");
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "config", "admin.json"), "utf8")).version, 3, "目标文件不动");
  assert.equal((srv.log().match(/stale tmp removed/g) || []).length, files.gone.length);
});
