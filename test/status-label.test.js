"use strict";
/* V2.0 阶段 3 · 可信的服务状态：
 *   - status.js：只有服务器真的测到才说「在线 / 离线 / ms / 检测于」；浏览器 no-cors 探测只说「可能在线 / 无法确认」，从不给延迟和时间；
 *     没地址 / 示例域名 / 服务器不探测 →「未检测」；汇总文字与读屏播报；
 *   - NAS 模式（jsdom 真实页面 + 真实 server.js + 本地模拟服务）：图标小点 / tooltip / 状态卡来自 /api/status 的 state + ms + checkedAt；
 *   - 纯静态模式：浏览器探测成功也只标「可能在线」，状态卡写明浏览器无法确认；
 *   - 生产代码里没有「模拟数据」字样。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ST = require("../public/status.js");
const { startServer, client, mockServer, waitFor } = require("./helpers");
const { openPage, openStatic, SKIP, sleep } = require("./browser");

const NOW = new Date(2026, 9, 8, 21, 50, 0);
const ISO = new Date(2026, 9, 8, 21, 46, 12).toISOString();

test("classify: server results are definite (ms + 检测于 only when measured); browser probes never are", () => {
  let c = ST.classify({ source: "server", up: true, status: "up", ms: 23.4, checkedAt: ISO }, NOW);
  assert.deepEqual([c.s, c.label, c.ms, c.at, c.certain], ["on", "在线", 23, "21:46", true]);
  assert.equal(ST.text(c), "在线 · 23 ms · 检测于 21:46"); assert.equal(ST.short(c), "23 ms");
  c = ST.classify({ source: "server", up: true, status: "up", ms: null, checkedAt: ISO }, NOW);
  assert.equal(ST.text(c), "在线 · 检测于 21:46", "docker-based: no latency invented"); assert.equal(ST.short(c), "在线");
  c = ST.classify({ source: "server", up: true, status: "auth", code: 401, ms: 40, checkedAt: ISO }, NOW);
  assert.equal(c.s, "auth"); assert.equal(c.label, "在线 · 需登录");
  c = ST.classify({ source: "server", up: false, status: "down", ms: 3000, checkedAt: ISO }, NOW);
  assert.deepEqual([c.s, c.label, c.ms], ["off", "离线", null], "no latency for a failed probe");
  assert.equal(ST.text(c), "离线 · 检测于 21:46");
  assert.equal(ST.classify({ source: "server", up: false, status: "down", checkedAt: null, error: "reserved domain" }).s, "na");
  assert.equal(ST.classify({ source: "server", up: false, status: "blocked", checkedAt: ISO }).label, "未检测");
  assert.equal(ST.classify({ source: "server", up: true, status: "up", ms: -5, checkedAt: ISO }, NOW).ms, null, "junk ms dropped");
  assert.match(ST.text(ST.classify({ source: "server", up: true, status: "up", checkedAt: new Date(2026, 9, 7, 8, 5).toISOString() }, NOW)), /检测于 10月7日 08:05/);
  // browser
  c = ST.classify({ source: "browser", reachable: true });
  assert.deepEqual([c.s, c.label, c.ms, c.at, c.certain], ["maybe", "可能在线", null, "", false]);
  c = ST.classify({ source: "browser", reachable: false });
  assert.deepEqual([c.s, c.label, c.ms], ["unknown", "无法确认", null]);
  for (const r of ["noaddr", "reserved", "policy"]) assert.equal(ST.classify({ source: "none", reason: r }).label, "未检测");
  assert.equal(ST.classify({ source: "none", reason: "offlan" }).label, "无法确认");
  assert.equal(ST.classify(null).s, "checking");
});

test("summary: server mode counts only definite results; browser mode says it cannot confirm; 未检测 excluded from totals", () => {
  const k = (r) => ST.classify(r, NOW);
  const srv = [k({ source: "server", up: true, status: "up", ms: 9, checkedAt: ISO }), k({ source: "server", up: true, status: "auth", checkedAt: ISO }),
    k({ source: "server", up: false, status: "down", checkedAt: ISO }), k({ source: "none", reason: "noaddr" })];
  let s = ST.summary(srv);
  assert.deepEqual([s.mode, s.total, s.online, s.certain, s.tone, s.note], ["server", 3, 2, 3, "off", "1 个未检测"]);
  assert.equal(ST.spoken(s), "2 个服务在线，1 个离线");
  s = ST.summary([k({ source: "browser", reachable: true }), k({ source: "browser", reachable: false })]);
  assert.equal(s.mode, "browser"); assert.equal(s.online, 0, "nothing is called online");
  assert.equal(s.line, "浏览器无法确认真实状态：1 个可能在线，1 个无法确认");
  assert.equal(ST.spoken(s), "1 个可能在线，1 个无法确认（浏览器探测）");
  s = ST.summary([k({ source: "server", up: true, status: "up", checkedAt: ISO }), k({ source: "browser", reachable: true })]);
  assert.equal(s.mode, "mixed"); assert.equal(s.line, "全部正常（另有 1 个无法确认）");
  assert.equal(ST.summary([k(null)]).line, "检测中…");
  assert.equal(ST.summary([]).line, "还没有图标服务");
});

test("no mock / simulated values in production code", () => {
  const pub = path.join(__dirname, "..", "public");
  for (const f of fs.readdirSync(pub).filter((x) => /\.(html|js|css)$/.test(x))) {
    const src = fs.readFileSync(path.join(pub, f), "utf8");
    assert.doesNotMatch(src, /模拟数据|模拟在线|mock(ed)? (status|latency)/i, f);
  }
  const html = fs.readFileSync(path.join(pub, "index.html"), "utf8");
  assert.doesNotMatch(html, /Math\.round\(performance\.now\(\) - t0\)/, "browser probes are not timed");
});

test("NAS mode: dots, tooltips and the status card come from /api/status (state + ms + checkedAt); missing results fall back to labelled browser probes", { skip: SKIP, timeout: 90000 }, async (t) => {
  const mock = await mockServer((q, s) => {
    if (q.url.startsWith("/login")) { s.writeHead(401); return s.end(); }
    if (q.url.startsWith("/broken")) { s.writeHead(503); return s.end(); }
    s.writeHead(200); s.end("ok");
  });
  const srv = await startServer({ env: { PROBE_TIMEOUT: "2" } });
  t.after(async () => { await srv.stop(); await mock.close(); });
  const c = client(srv.base);
  assert.equal((await c.post("/api/setup", { name: "admin", password: "admin-pass-1" })).status, 200);
  const M = (p) => "http://127.0.0.1:" + mock.port + p;
  const items = [
    { id: "up", title: "Up", lan: M("/ok"), icon: { type: "text", value: "U" } },
    { id: "auth", title: "Auth", lan: M("/login"), icon: { type: "text", value: "A" } },
    { id: "down", title: "Down", lan: M("/broken"), icon: { type: "text", value: "D" } },
    { id: "demo", title: "Demo", wan: "https://emby.example.com", icon: { type: "text", value: "E" } },
    { id: "noaddr", title: "NoAddr", icon: { type: "text", value: "N" } },
  ];
  await c.put("/api/config", { baseVersion: 0, data: { settings: { title: "夜曲" }, groups: [{ id: "g1", name: "组", style: "icon", items }] } });
  const st = await waitFor(async () => { const r = (await c.get("/api/status")).json; return r.up && r.auth && r.down ? r : null; }, 8000);
  assert.ok(st && st.up.checkedAt && typeof st.up.ms === "number");
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  await p.idle(900);
  const dot = (id) => doc.querySelector('#x-groups [data-id="' + id + '"] > .dot');
  assert.equal(dot("up").className, "dot on"); assert.match(dot("up").title, /^在线 · \d+ ms · 检测于 \d\d:\d\d$/);
  assert.equal(dot("auth").className, "dot auth");
  assert.equal(dot("down").className, "dot off"); assert.match(dot("down").title, /^离线 · 检测于/); assert.doesNotMatch(dot("down").title, /ms/);
  assert.equal(dot("demo").className, "dot na"); assert.match(dot("demo").title, /^未检测/);
  assert.equal(dot("noaddr").className, "dot na");
  assert.equal(A.statusOf("up").source, "server");
  assert.match(doc.querySelector(".x-side .x-cnt").textContent, /^2 \/ 3在线/);
  assert.match(doc.querySelector(".x-side .x-sline").textContent, /离线：Down/);
  assert.match(doc.querySelector(".x-side .x-snote").textContent, /2 个未检测/);
  assert.deepEqual(p.errors, []);
});

test("static mode: a successful no-cors probe is only 可能在线 (no ms, no time); failures are 无法确认", { skip: SKIP, timeout: 60000 }, async (t) => {
  const data = { settings: { title: "夜曲" }, groups: [{ id: "g1", name: "组", style: "icon", items: [
    { id: "a", title: "A", wan: "https://a.nocturne-test.net", icon: { type: "text", value: "A" } },
    { id: "b", title: "B", wan: "https://b.nocturne-test.net", icon: { type: "text", value: "B" } },
  ] }] };
  const p = await openStatic({ url: "file://" + path.join(__dirname, "..", "public", "index.html"), storage: { "yeqv.v1": JSON.stringify(data) }, probe: (u) => /\/\/a\./.test(u) });
  t.after(() => p.close());
  const doc = p.win.document;
  await p.idle(400);
  const dot = (id) => doc.querySelector('#x-groups [data-id="' + id + '"] > .dot');
  assert.equal(dot("a").className, "dot maybe"); assert.equal(dot("a").title, "可能在线 · 浏览器探测，无法确认真实状态");
  assert.doesNotMatch(dot("a").title, /ms|检测于/);
  assert.equal(dot("b").className, "dot unknown"); assert.match(dot("b").title, /^无法确认/);
  assert.equal(doc.querySelector(".x-side .x-cnt").textContent, "1 / 2可能在线");
  assert.match(doc.querySelector(".x-side .x-sline").textContent, /浏览器无法确认真实状态/);
  assert.doesNotMatch(doc.querySelector(".x-side").textContent, /全部正常|\d+ ms/);
  assert.deepEqual(p.errors, []);
});
