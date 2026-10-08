"use strict";
/* V2.0 RC.3 · 管理员提示：回滚写保护旁路（spaces-guard）写入失败时，前端要告诉管理员。
 * RC.2 的前端不看保存响应里的 guardWarning，也不看 /api/health 的 guard（只有接口，没有界面）。
 * RC.3：用现有的 toast 提示（不改界面）——只给管理员；每次「发生」（服务器记的 账户 + 连续失败开始时间 since）只提示一次，刷新不重复；
 * 文字说明「空间保护记录未能保存」，建议检查磁盘空间 / 权限并备份；设置里的管理员连接诊断行也写明。
 * jsdom 真实运行 public/index.html + nocturne.js，对着真实 server.js 子进程；旁路写入故障用 test/fsfail.js 注入。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer, client, sleep } = require("./helpers");
const { openPage, SKIP } = require("./browser");

const FSFAIL = path.join(__dirname, "fsfail.js");
const GUARD_ANY = "/spaces-guard/[^/]+\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$";
const MSG = /空间保护记录未能保存.*检查 NAS 磁盘空间和 data 目录的写入权限.*备份/;

function failEnv(t) {
  const ctl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-gwui-")), "ctl");
  t.after(() => fs.rmSync(path.dirname(ctl), { recursive: true, force: true }));
  return { ctl, env: { FSFAIL_CTL: ctl, NODE_OPTIONS: ((process.env.NODE_OPTIONS || "") + " --require " + JSON.stringify(FSFAIL)).trim() } };
}
/** 包住 App.toast 记下所有提示（nocturne.js 调用时现取 A.toast，所以页面载入后包也拦得到） */
function spy(p) {
  const seen = [], orig = p.A.toast;
  p.A.toast = function (msg, o) { seen.push(String(msg)); return orig.call(this, msg, o); };
  return seen;
}
const guardToasts = (seen) => seen.filter((m) => MSG.test(m));
async function edit(p, title) { p.A.commit((s) => { s.settings.title = title; }, "edit-title"); await p.idle(2200); }

test("旁路写入失败：管理员看到一次提示（同一轮连续失败不重复、刷新不重复），磁盘修好后再失败会再提示；诊断行写明", { skip: SKIP, timeout: 90000 }, async (t) => {
  const { ctl, env } = failEnv(t);
  const srv = await startServer({ env });
  t.after(() => srv.stop());
  const c = client(srv.base);
  assert.equal((await c.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);

  let p = await openPage(srv.base, c, {});
  let seen = spy(p);
  await edit(p, "正常保存");
  assert.equal(p.puts().at(-1).status, 200);
  assert.deepEqual(guardToasts(seen), [], "旁路正常时没有提示");

  fs.writeFileSync(ctl, "open " + GUARD_ANY + "\n"); // 磁盘满：旁路写不进去
  await edit(p, "旁路失败 1");
  const put = p.puts().at(-1);
  assert.equal(put.status, 200, "配置照常保存");
  assert.equal(put.res.guardWarning, "spaces_guard_write_failed");
  await sleep(300);
  assert.equal(guardToasts(seen).length, 1, "管理员看到提示");
  assert.match(guardToasts(seen)[0], /账户 admin/);
  await edit(p, "旁路失败 2");
  await sleep(300);
  assert.equal(p.puts().at(-1).res.guardWarning, "spaces_guard_write_failed");
  assert.equal(guardToasts(seen).length, 1, "同一轮连续失败只提示一次");
  const storage = p.storage();
  await p.close();

  // 同一台设备刷新：不重复提示
  p = await openPage(srv.base, c, { storage, settle: 0 });
  seen = spy(p);
  await sleep(800);
  assert.equal(guardToasts(seen).length, 0, "刷新后不重复提示同一次失败");
  await p.close();

  // 另一台设备（管理员，本机没记过）：打开页面时从 /api/health 看到，提示一次
  const c2 = client(srv.base);
  assert.equal((await c2.post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 200);
  p = await openPage(srv.base, c2, { settle: 0 });
  seen = spy(p);
  await sleep(800);
  assert.equal(guardToasts(seen).length, 1, "另一台管理员设备打开时提示一次");
  // 设置 → 账户：管理员连接诊断行写明
  const tab = p.win.document.querySelector('.x-set [data-tab="账户"]');
  assert.ok(tab, "设置里有「账户」页");
  tab.click();
  await sleep(600);
  const diag = p.win.document.querySelector("[data-diag]");
  assert.ok(diag && !diag.hidden, "管理员诊断行");
  assert.match(diag.textContent, /空间保护异常：admin（记录未能保存：ENOSPC，请检查磁盘空间 \/ 权限并备份）/);
  await p.close();

  // 磁盘修好：一次正常保存清掉诊断；之后再失败 = 新的一次 → 再提示
  fs.writeFileSync(ctl, "");
  p = await openPage(srv.base, c, { storage, settle: 0 });
  seen = spy(p);
  await sleep(500);
  await edit(p, "修好了");
  assert.equal(p.puts().at(-1).res.guardWarning, undefined);
  assert.equal((await c.get("/api/health")).json.guard.ok, true);
  fs.writeFileSync(ctl, "open " + GUARD_ANY + "\n");
  await edit(p, "又失败了");
  await sleep(300);
  assert.equal(guardToasts(seen).length, 1, "新的一次失败再提示");
  assert.deepEqual(p.errors, []);
  await p.close();
});

test("非管理员：保存响应带 guardWarning 也不提示", { skip: SKIP, timeout: 60000 }, async (t) => {
  const { ctl, env } = failEnv(t);
  const srv = await startServer({ env });
  t.after(() => srv.stop());
  const a = client(srv.base);
  assert.equal((await a.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  assert.equal((await a.post("/api/users", { name: "bob", password: "bob-pass-12" })).status, 200);
  const b = client(srv.base);
  assert.equal((await b.post("/api/login", { name: "bob", password: "bob-pass-12" })).status, 200);
  const p = await openPage(srv.base, b, {});
  t.after(() => p.close());
  const seen = spy(p);
  fs.writeFileSync(ctl, "open " + GUARD_ANY + "\n");
  await edit(p, "bob 的保存");
  assert.equal(p.puts().at(-1).res.guardWarning, "spaces_guard_write_failed", "响应确实带警告");
  await sleep(500);
  assert.deepEqual(guardToasts(seen), [], "非管理员不提示");
});
