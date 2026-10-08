"use strict";
/* V2.0 阶段 3 · 本设备外观（经典 / 新版）、手机列数迁移、空间外观（theme / density）与底栏「快速打开」：
 *   - 外观只存本机 localStorage「nocturne.ui」：默认新版；切换不 commit、不 PUT、不改 state（壁纸 / 显示开关原样），重载保持；
 *   - 手机列数「nocturne.v2.cols」：没设过时按经典「手机每行」迁移（只有 5 列 → 紧凑 4 列，其余 3 列），设置后本机保存、不同步；
 *   - 空间外观：没设 theme / density 时按名称模板给默认；管理空间里选的外观走 commit（同步、可撤销）；
 *   - 底栏「快速打开」打开命令面板；首帧前就设好 html[data-ui]（不闪经典）。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { seedAccount, startServer, client } = require("./helpers");
const { openPage, SKIP, sleep } = require("./browser");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
const [G_AV, G_DL, G_ST] = FIX.groups.map((g) => g.id);
function data(cols) {
  const d = structuredClone(FIX); delete d.settings.net; delete d.recent;
  if (cols) d.settings.cols = cols;
  d.spacesVersion = 2;
  d.spaces = [{ id: "s-fun", name: "娱乐", groupIds: [G_AV, G_DL] }, { id: "s-nas", name: "NAS", groupIds: [G_ST] }, { id: "s-x", name: "书房", groupIds: [G_AV], theme: "frost", density: "compact" }];
  return d;
}
async function boot(t, d) {
  const srv = await startServer({ seed: (dir) => {
    seedAccount(dir);
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "admin.json"), JSON.stringify({ version: 3, updatedAt: "Thu 2026-10-01 8:00 AM CST (UTC+08:00)", data: d }));
  } });
  t.after(() => srv.stop());
  const c = client(srv.base);
  assert.equal((await c.post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 200);
  return { srv, c };
}
const opt = { skip: SKIP, timeout: 90000 };

test("index.html sets html[data-ui] before first paint (head script, before midnight.css) and defaults to 新版", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const boot = html.indexOf('localStorage.getItem("nocturne.ui")'), css = html.indexOf('href="midnight.css'), body = html.indexOf("<body");
  assert.ok(boot > 0 && boot < css && css < body, "boot script → stylesheet → body");
  assert.match(html, /v === "classic" \? "classic" : "v2"/);
});

test("appearance toggle is device-local: no commit, no PUT, wallpaper / show settings untouched, survives reload; classic keeps every feature", opt, async (t) => {
  const d = data(); d.settings.wallpaper = { id: "dusk", dim: 50, blur: 4 }; d.settings.show = { clock: true, sec: false, date: true, greet: true, search: true, status: true, recent: true };
  const { srv, c } = await boot(t, d);
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  await p.idle(800);
  assert.equal(doc.documentElement.getAttribute("data-ui"), "v2", "default = 新版 on the v2 branch");
  assert.equal(A.appearance.get(), "v2");
  const before = JSON.stringify(A.state), puts = p.puts().length;
  const btn = doc.querySelector('.x-set [data-ui-set="classic"]');
  assert.ok(btn, "toggle lives in 设置 → 外观");
  btn.click(); await sleep(50);
  assert.equal(doc.documentElement.getAttribute("data-ui"), "classic");
  assert.equal(win.localStorage.getItem("nocturne.ui"), "classic");
  assert.equal(doc.querySelector('.x-set [data-ui-set="classic"]').getAttribute("aria-pressed"), "true");
  await p.idle(400);
  assert.equal(JSON.stringify(A.state), before, "state untouched (wallpaper, show toggles, cols)");
  assert.equal(p.puts().length, puts, "nothing synced");
  // classic: same DOM + features (switcher, palette, edit) still work
  A.spaces.select("s-fun"); assert.ok(doc.querySelector('#x-groups [data-id="e7h2kq9b1m"]'));
  A.palette.open(""); assert.ok(doc.querySelector(".x-cmdk.is-on, .x-cmdk:not([hidden])")); A.palette.close();
  // reload on the same device → still classic
  const p2 = await openPage(srv.base, c, { storage: p.storage() });
  t.after(() => p2.close());
  await p2.idle(600);
  assert.equal(p2.win.document.documentElement.getAttribute("data-ui"), "classic");
  p2.A.appearance.set("v2");
  assert.equal(p2.win.document.documentElement.getAttribute("data-ui"), "v2");
  assert.equal(p2.win.localStorage.getItem("nocturne.ui"), "v2");
  assert.deepEqual(p.errors, []); assert.deepEqual(p2.errors, []);
});

test("phone columns: migrated from classic 手机每行 (5 → compact 4, else 3), then device-local; never synced", opt, async (t) => {
  for (const [cols, want] of [[undefined, 3], [3, 3], [4, 3], [5, 4]]) {
    const { srv, c } = await boot(t, data(cols));
    const p = await openPage(srv.base, c, {});
    await p.idle(500);
    assert.equal(p.A.appearance.cols(), want, "settings.cols=" + cols);
    assert.equal(p.win.document.documentElement.getAttribute("data-mcols"), String(want));
    if (cols === 5) {
      const puts = p.puts().length, st = JSON.stringify(p.A.state);
      p.win.document.querySelector('.x-set [data-mcols="3"]').click(); await sleep(30);
      assert.equal(p.win.localStorage.getItem("nocturne.v2.cols"), "3");
      assert.equal(p.win.document.documentElement.getAttribute("data-mcols"), "3");
      await p.idle(300);
      assert.equal(p.puts().length, puts); assert.equal(JSON.stringify(p.A.state), st, "classic cols (5) untouched");
    }
    assert.deepEqual(p.errors, []);
    await p.close();
  }
});

test("space look: name templates give defaults (日常 dawn / 娱乐 dusk+poster / NAS frost+compact), explicit fields win; the picker commits and syncs", opt, async (t) => {
  const { srv, c } = await boot(t, data());
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  await p.idle(700);
  assert.deepEqual({ ...A.appearance.look() }, { theme: "default", density: "comfortable" }, "全部 = neutral");
  A.spaces.select("s-fun"); assert.deepEqual({ ...A.appearance.look() }, { theme: "dusk", density: "poster" });
  assert.equal(doc.body.getAttribute("data-theme"), "dusk"); assert.equal(doc.getElementById("x-groups").getAttribute("data-density"), "poster");
  A.spaces.select("s-nas"); assert.deepEqual({ ...A.appearance.look() }, { theme: "frost", density: "compact" });
  A.spaces.select("s-x"); assert.deepEqual({ ...A.appearance.look() }, { theme: "frost", density: "compact" }, "explicit fields");
  // compact rows carry host + trustworthy status text
  const row = doc.querySelector('#x-groups [data-id="e7h2kq9b1m"]');
  assert.equal(row.querySelector(".x-host").textContent, "192.168.1.20:8096");
  assert.ok(row.querySelector(".x-st").textContent.length > 0);
  // picker in 管理空间 → commit (theme) → synced
  A.spaces.manage("s-fun"); await sleep(30);
  doc.querySelector('.x-spm [data-sp-look="theme"][data-v="dawn"][data-sid="s-fun"]').click(); await sleep(30);
  assert.equal(A.spaces.model.get(A.state, "s-fun").theme, "dawn");
  A.spaces.select("s-fun"); assert.deepEqual({ ...A.appearance.look() }, { theme: "dawn", density: "poster" });
  await p.idle();
  assert.equal((await c.get("/api/config")).json.data.spaces[0].theme, "dawn");
  A.undo(); assert.equal(A.spaces.model.get(A.state, "s-fun").theme, undefined);
  assert.deepEqual(p.errors, []);
});

test("dock 快速打开 opens the command palette; 更多 opens the menu", opt, async (t) => {
  const { srv, c } = await boot(t, data());
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  const doc = p.win.document;
  await p.idle(600);
  doc.querySelector('.x-dock [data-act="palette"]').click(); await sleep(30);
  assert.ok(!doc.querySelector(".x-cmdk").hidden, "palette opened");
  assert.equal(doc.activeElement, doc.querySelector(".x-cmdk input"), "input focused in the same tap (iOS keyboard)");
  p.A.palette.close(); await sleep(250);
  doc.querySelector('.x-dock [data-act="more"]').click(); await sleep(30);
  assert.ok(!doc.querySelector(".x-menu").hidden, "menu opened");
  assert.deepEqual(p.errors, []);
});

test("RC: the appearance switch stays visible in classic (CSS), so classic can switch back to Midnight", () => {
  const css = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "public", "midnight.css"), "utf8");
  assert.match(css, /html\[data-ui="classic"\] \.mn-setui[^{]*\{ display: block; \}|html\[data-ui="v2"\] \.mn-setui, html\[data-ui="classic"\] \.mn-setui \{ display: block; \}/);
  assert.match(css, /html\[data-ui="classic"\] \.mn-v2only \{ display: none; \}/, "only the phone-columns row is v2-only");
});
