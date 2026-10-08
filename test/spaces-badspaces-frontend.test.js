"use strict";
/* 复查修正 A：服务器以 400 bad_spaces 拒收空间设置时的前端处理（jsdom 真实运行 index.html + nocturne.js，对着真实 server.js）：
 * 提示用户（中文 toast）、本机修改和脏标记保留、同一份内容不再自动重推（防抖 / 15 秒重试 / 切后台 keepalive / pagehide / online 全部跳过），
 * 用户再改一次或点「重试」才重新推送；其他 400（bad_aliases）/ 409 路径不受影响。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, client, sleep } = require("./helpers");
const { openPage, SKIP } = require("./browser");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const opt = { skip: SKIP, timeout: 60000 };
const plain = (v) => JSON.parse(JSON.stringify(v));
const deq = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);

async function seeded(t, data, version = 7) {
  const srv = await startServer({ seed: (dir) => {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "admin.json"), JSON.stringify({ version, updatedAt: "2026-10-01T00:00:00.000Z", data }));
  } });
  t.after(() => srv.stop());
  const c = client(srv.base);
  assert.equal((await c.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  return { srv, c };
}
function v11Device(ver = 7) { return { "yeqv.v1": JSON.stringify(FIX), "nocturne.owner": "admin", "nocturne.ver": String(ver) }; }
const toastText = (p) => p.win.document.getElementById("x-toast-msg").textContent;
const toastOn = (p) => p.win.document.getElementById("x-toast").classList.contains("is-on");
/** 页面上所有会触发推送的入口：保存 / 渲染、切到后台（keepalive）、切回、online、pagehide */
async function pokeEverything(p) {
  const { win } = p;
  p.A.save(); p.A.render();
  Object.defineProperty(win.document, "hidden", { configurable: true, get: () => true });
  win.document.dispatchEvent(new win.Event("visibilitychange"));
  await sleep(50);
  Object.defineProperty(win.document, "hidden", { configurable: true, get: () => false });
  win.document.dispatchEvent(new win.Event("visibilitychange"));
  win.dispatchEvent(new win.Event("online"));
  win.dispatchEvent(new win.Event("pagehide"));
}
/** 能通过 commit 的 prune、但服务器结构校验会拒收的空间。阶段 2 起合法的扩展字段会被放行（向前兼容），
 *  所以这里用畸形的扩展字段（脚本地址）来模拟「服务器拒收」 */
const BAD = { id: "s-bad", name: "坏空间", groupIds: ["chips00daily"], color: "javascript:red" };

test("400 bad_spaces: Chinese toast, local edit + dirty flag kept, no automatic re-push over simulated time", opt, async (t) => {
  const { srv, c } = await seeded(t, serverData());
  const p = await openPage(srv.base, c, { storage: v11Device(), timeScale: 100 }); // 1 秒真实时间 ≈ 100 秒页面时间
  t.after(() => p.close());
  await p.idle(800);
  deq(p.errors, []);
  p.A.commit((s) => { s.spaces = [structuredClone(BAD)]; }, "space-add");
  await p.idle(1500);
  const puts = p.puts();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].status, 400); assert.equal(puts[0].res.code, "bad_spaces");
  assert.ok(toastOn(p) || /空间设置格式有误/.test(toastText(p)));
  assert.match(toastText(p), /空间设置格式有误，服务器未保存。本机修改已保留/);
  assert.equal(p.win.document.getElementById("x-toast-act").textContent, "重试");
  // local state kept: nothing reverted, cache + dirty flag persisted, server untouched
  deq(p.A.state.spaces, [BAD]);
  assert.ok(p.storage()["yeqv.v1"].includes('"color":"javascript:red"'), "local cache keeps the edit");
  assert.equal(p.storage()["nocturne.dirty"], "1", "dirty marker kept");
  assert.equal((await c.get("/api/config")).json.version, 7);
  // simulated intervals: ~5 minutes of page time (20+ cycles of the 15 s retry), plus every push trigger
  for (let i = 0; i < 3; i++) { await pokeEverything(p); await sleep(1000); }
  assert.equal(p.puts().length, 1, "no retries / keepalive / pagehide for the rejected payload");
  assert.equal(p.reqs.filter((r) => r.method === "PUT").length, 1);
  deq(p.A.state.spaces, [BAD], "still kept");
  assert.equal(p.storage()["nocturne.dirty"], "1");
  // pulling (switch back to the tab) must not overwrite the unsynced local edit
  assert.equal((await c.get("/api/config")).json.version, 7);
  deq(p.errors, []);
});

test("bad_spaces: explicit 重试 sends once more; a new commit resumes syncing; fixing the space saves", opt, async (t) => {
  const { srv, c } = await seeded(t, serverData());
  const p = await openPage(srv.base, c, { storage: v11Device(), timeScale: 100 });
  t.after(() => p.close());
  await p.idle(800);
  p.A.commit((s) => { s.spaces = [structuredClone(BAD)]; }, "space-add");
  await p.idle(1500);
  assert.equal(p.puts().length, 1);
  // explicit retry (toast action) → exactly one more PUT, still rejected, then quiet again
  p.win.document.getElementById("x-toast-act").click();
  await p.idle(800);
  assert.equal(p.puts().length, 2); assert.equal(p.puts()[1].res.code, "bad_spaces");
  await pokeEverything(p); await sleep(1500);
  assert.equal(p.puts().length, 2, "quiet again after the explicit retry");
  // a new (still bad) change → one push for the new payload, then quiet
  p.A.commit((s) => { s.spaces[0].name = "坏空间二"; }, "rename");
  await p.idle(1500);
  assert.equal(p.puts().length, 3); assert.equal(p.puts()[2].body.data.spaces[0].name, "坏空间二");
  await pokeEverything(p); await sleep(1500);
  assert.equal(p.puts().length, 3);
  // user fixes it → saved, dirty cleared
  p.A.commit((s) => { delete s.spaces[0].color; }, "fix");
  await p.idle(1500);
  const last = p.puts().at(-1);
  assert.equal(last.status, 200);
  const g = (await c.get("/api/config")).json;
  assert.equal(g.version, 8);
  deq(g.data.spaces, [{ id: "s-bad", name: "坏空间二", groupIds: ["chips00daily"] }]);
  assert.equal(p.storage()["nocturne.dirty"], undefined, "synced → dirty marker cleared");
  // after a successful save normal syncing continues
  p.A.commit((s) => { s.spaces[0].name = "好空间"; }, "rename");
  await p.idle(1500);
  assert.equal((await c.get("/api/config")).json.data.spaces[0].name, "好空间");
  deq(p.errors, []);
});

test("other 400 / 409 paths unchanged: bad_aliases keeps its own message; 409 still opens the conflict flow", opt, async (t) => {
  const { srv, c } = await seeded(t, serverData());
  const p = await openPage(srv.base, c, { storage: v11Device(), timeScale: 100 });
  t.after(() => p.close());
  await p.idle(800);
  p.A.commit((s) => { s.groups[0].items[0].aliases = ["x".repeat(40)]; }, "alias");
  await p.idle(1500);
  const a = p.puts().at(-1);
  assert.equal(a.status, 400); assert.equal(a.res.code, "bad_aliases");
  assert.match(toastText(p), /别名/);
  assert.doesNotMatch(toastText(p), /空间设置/);
  p.A.commit((s) => { s.groups[0].items[0].aliases = ["ok"]; }, "alias-fix");
  await p.idle(1500);
  assert.equal(p.puts().at(-1).status, 200);
  const v = (await c.get("/api/config")).json.version;
  // another device writes → our next push is a 409 → conflict sheet opens, nothing overwritten
  const cur = (await c.get("/api/config")).json, d = structuredClone(cur.data); d.settings.title = "另一台设备";
  assert.equal((await c.put("/api/config", { baseVersion: cur.version, data: d, caps: ["spaces"] })).status, 200);
  p.A.commit((s) => { s.settings.title = "本机"; }, "title");
  await p.idle(1500);
  assert.equal(p.puts().at(-1).status, 409);
  assert.ok(p.win.document.querySelector('[data-cf="server"]'), "conflict sheet shown");
  assert.doesNotMatch(toastText(p), /空间设置/);
  assert.equal((await c.get("/api/config")).json.data.settings.title, "另一台设备");
  assert.equal((await c.get("/api/config")).json.version, v + 1);
  deq(p.errors, []);
});
