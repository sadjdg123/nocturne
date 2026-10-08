"use strict";
/* V2.0 阶段 2 · 纯静态模式（没有 window.NOCTURNE）：python3 -m http.server 与 file:// 两种打开方式。
 * 空间存在本机配置缓存 yeqv.v1 里（随 commit 保存）、当前空间存在 nocturne.space:~local；不发任何同步请求；
 * 通过真实界面新建空间 / 勾选分组 / 切换 / 重载 / 导出导入；没有 spaces 的旧缓存照常显示「全部」且不被改写。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { openStatic, importFile, SKIP, sleep, ROOT, byText } = require("./browser");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
const HAS_PY = spawnSync("python3", ["--version"]).status === 0;
const NO_PY = HAS_PY ? false : (process.env.CI ? false : "python3 不可用（CI 上有）");
if (!HAS_PY && process.env.CI) throw new Error("CI 里必须有 python3（纯静态模式测试）");

function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); }); }
async function pyServer(t) {
  const port = await freePort();
  const child = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: path.join(ROOT, "public"), stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/index.html")).ok) break; } catch (e) { /* not yet */ } await sleep(50); }
  return base + "/index.html";
}

async function flow(t, url) {
  const p = await openStatic({ url, storage: { "yeqv.v1": JSON.stringify(FIX) } });
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  assert.deepEqual(p.errors, []);
  assert.equal(win.NOCTURNE, undefined, "static mode");
  assert.ok(!("spaces" in JSON.parse(p.storage()["yeqv.v1"])), "old cache not rewritten with a spaces field");
  assert.equal(doc.querySelectorAll("#x-groups .x-group").length, FIX.groups.length, "全部");
  // create a space through the real sheet
  doc.querySelector('[data-m="spaces"]').click();
  const sh = doc.querySelector(".x-spm");
  byText(sh, "[data-tpl]", "娱乐").click();
  sh.querySelector("[data-spm-new]").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  const sid = A.spaces.list()[0].id;
  sh.querySelector('input[data-sp-group="mzq1a0lq8x2"]').click();
  const cached = JSON.parse(p.storage()["yeqv.v1"]);
  assert.deepEqual(JSON.parse(JSON.stringify(cached.spaces)), [{ id: sid, name: "娱乐", groupIds: ["mzq1a0lq8x2"] }], "spaces persisted in the local cache");
  assert.equal(p.storage()["nocturne.space:~local"], sid, "selection key for static mode");
  assert.deepEqual([...doc.querySelectorAll("#x-groups .x-group")].map((s) => s.getAttribute("data-gid")), ["mzq1a0lq8x2"]);
  assert.ok(p.reqs.every((r) => !/\/api\//.test(r.path)), "no sync / api requests in static mode");
  // reload on the same device
  const p2 = await openStatic({ url, storage: p.storage() });
  t.after(() => p2.close());
  assert.equal(p2.A.spaces.selected(), sid);
  assert.deepEqual([...p2.win.document.querySelectorAll("#x-groups .x-group")].map((s) => s.getAttribute("data-gid")), ["mzq1a0lq8x2"]);
  assert.equal(p2.win.document.querySelector('.x-sp[aria-current="true"]').textContent.replace(/\d+$/, ""), "娱乐");
  // export carries spaces; import validates (malformed → refused) and accepts a valid file
  const exported = JSON.parse(JSON.stringify(p2.A.state));
  assert.equal(exported.spaces[0].name, "娱乐");
  const bad = structuredClone(exported); bad.spaces[0].theme = "neon";
  importFile(p2, bad); await sleep(80);
  assert.equal(p2.A.state.spaces[0].theme, undefined, "malformed import refused");
  const good = structuredClone(exported); good.spaces.push({ id: "s-x", name: "导入的", groupIds: ["st0rage9kq2"], accent: { hue: 1 } });
  importFile(p2, good); await sleep(80);
  assert.deepEqual(JSON.parse(JSON.stringify(p2.A.spaces.list().map((s) => s.name))), ["娱乐", "导入的"]);
  assert.deepEqual(JSON.parse(JSON.stringify(p2.A.spaces.list()[1].accent)), { hue: 1 }, "extension field survives import");
  assert.deepEqual(p.errors.concat(p2.errors), []);
}

test("static: python3 -m http.server", { skip: SKIP || NO_PY, timeout: 60000 }, async (t) => { await flow(t, await pyServer(t)); });
test("static: file://", { skip: SKIP, timeout: 60000 }, async (t) => { await flow(t, "file://" + path.join(ROOT, "public", "index.html")); });
