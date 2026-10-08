"use strict";
/* 回滚 / 旧版兼容 —— 实测，不靠「未知字段透传」的推断。
 * 旧版 = V1.1 基线（远程 main@3e6da3c = 镜像 sha-3e6da3c）的 server.js + public/*，按 blob SHA 从 git 取出（test/v11.js）。
 * 前端用 jsdom 真实运行旧版 index.html + nocturne.js（test/browser.js）。
 *  (a) 旧服务端接收 / 存储带 spaces 的配置
 *  (b) 旧前端读新配置后编辑 / 保存、删分组、导入导出、本机旧缓存补推（对旧服务端和新服务端分别测）
 *  (c) 带 spaces 的备份在旧版里恢复
 *  (d) 回滚期间旧版写过的数据，再升级回新版读取 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer, client, sleep } = require("./helpers");
const { openPage, importFile, SKIP: NO_DOM } = require("./browser");
const { v11Root } = require("./v11");

const V11 = v11Root();
const SKIP = V11.skip || false;
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const SPACES = [
  { id: "s-daily", name: "日常", groupIds: ["chips00daily", "dl92kfa0q1z"], theme: "dawn" },
  { id: "s-nas", name: "NAS", groupIds: ["st0rage9kq2"], itemIds: ["e7h2kq9b1m"], theme: "frost", density: "compact" },
];
const withSpaces = () => Object.assign(serverData(), { spaces: structuredClone(SPACES) });
const plain = (v) => JSON.parse(JSON.stringify(v));
const deq = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);
const opt = { skip: SKIP, timeout: 90000 };
const optDom = { skip: SKIP || NO_DOM, timeout: 90000 };

function tmpData(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-rb-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
/** 在 dataDir 上启动 old / new 服务端并登录（第一次启动时建管理员） */
async function run(kind, dataDir, first) {
  const srv = await startServer({ root: kind === "old" ? V11.root : undefined, dataDir });
  const c = client(srv.base);
  const r = first ? await c.post("/api/setup", { name: "admin", password: "admin-pass-1" }) : await c.post("/api/login", { name: "admin", password: "admin-pass-1" });
  assert.equal(r.status, 200, kind + " server login");
  return { srv, c };
}
const cfgOf = async (c) => (await c.get("/api/config")).json;

test("(a) V1.1 server stores, returns and backs up configs with spaces unchanged — but validates nothing", opt, async (t) => {
  const dir = tmpData(t);
  const { srv, c } = await run("old", dir, true);
  t.after(() => srv.stop());
  const r = await c.put("/api/config", { baseVersion: 0, data: withSpaces(), caps: ["spaces"] });
  assert.equal(r.status, 200, "old server accepts the new field (and ignores caps)");
  const g = await cfgOf(c);
  assert.equal(JSON.stringify(g.data), JSON.stringify(withSpaces()), "returned byte-identical, spaces included");
  // force overwrite → backup of the version with spaces
  const d2 = serverData(); d2.settings.title = "旧版覆盖";
  assert.equal((await c.put("/api/config", { baseVersion: 0, data: d2, force: true, expectVersion: g.version })).status, 200);
  const bk = (await c.get("/api/config/backups")).json.find((x) => x.kind === "replaced");
  assert.ok(bk); assert.equal(bk.spaces, undefined, "old summaries do not count spaces");
  deq((await c.get("/api/config?backup=" + bk.id)).json.data.spaces, SPACES, "old backup ring keeps spaces verbatim");
  assert.ok(!("spaces" in (await cfgOf(c)).data), "MEASURED: a save without spaces simply drops them on the V1.1 server (no protection there)");
  // old server does not validate spaces at all
  const cur = await cfgOf(c);
  const junk = await c.put("/api/config", { baseVersion: cur.version, data: Object.assign(serverData(), { spaces: "garbage" }) });
  assert.equal(junk.status, 200, "MEASURED: V1.1 accepts malformed spaces (validation exists only in V2)");
});

test("(b) V1.1 frontend on V1.1 server: loads a V2 config, edits / deletes a group / exports / imports → spaces preserved (dangling refs left)", optDom, async (t) => {
  const dir = tmpData(t);
  const { srv, c } = await run("old", dir, true);
  t.after(() => srv.stop());
  await c.put("/api/config", { baseVersion: 0, data: withSpaces() });
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  await p.idle(800);
  assert.deepEqual(p.errors, []);
  assert.ok(!p.win.NocturneSpaces, "really the old frontend (no spaces.js)");
  deq(p.A.state.spaces, SPACES, "old frontend keeps the unknown top-level field in its state");
  // edit an item (same path as the edit sheet: commit on the same object)
  p.A.commit((s) => { s.groups[0].items[0].title = "Emby（旧版改）"; s.groups[0].items[0].wan = "https://emby2.home.arpa"; }, "edit-item");
  await p.idle();
  let put = p.puts().at(-1);
  assert.equal(put.status, 200); assert.equal(put.body.caps, undefined, "old frontend sends no caps");
  deq(put.body.data.spaces, SPACES, "MEASURED: old frontend pushes spaces back unchanged");
  let g = await cfgOf(c);
  deq(g.data.spaces, SPACES); assert.equal(g.data.groups[0].items[0].title, "Emby（旧版改）");
  // delete a referenced group in the old frontend → old server stores a dangling groupId
  p.A.commit((s) => { s.groups = s.groups.filter((x) => x.id !== "st0rage9kq2"); }, "delete-group");
  await p.idle();
  g = await cfgOf(c);
  deq(g.data.spaces[1].groupIds, ["st0rage9kq2"], "MEASURED: dangling ref remains under V1.1 (cleaned later by V2, see (d))");
  // export (设置 → 数据 → 导出配置) keeps spaces
  p.win.document.querySelector('[data-d="export"]').click();
  await sleep(200);
  const blob = (p.win.__downloads || []).at(-1);
  const txt = await new Promise((r) => { const fr = new p.win.FileReader(); fr.onload = () => r(fr.result); fr.readAsText(blob); });
  const exported = JSON.parse(txt);
  deq(exported.spaces, SPACES, "old export contains spaces");
  // import a V2 export into the old frontend → spaces kept
  const v2file = withSpaces(); v2file.spaces[0].name = "导入的日常";
  importFile(p, v2file);
  await p.idle();
  assert.equal((await cfgOf(c)).data.spaces[0].name, "导入的日常", "MEASURED: old import keeps spaces (Object.assign of the file)");
  // 恢复默认 in the old frontend → spaces gone (user-intended full reset)
  p.win.document.querySelector('[data-d="confirm"]').click();
  await p.idle();
  assert.ok(!("spaces" in (await cfgOf(c)).data), "MEASURED: old 恢复默认 drops spaces (as it drops everything)");
});

test("(b) stale V1.1 device cache without spaces: V1.1 server LOSES spaces on 用本机版覆盖; V2 server keeps them", optDom, async (t) => {
  for (const kind of ["old", "new"]) {
    const dir = tmpData(t);
    const { srv, c } = await run(kind, dir, true);
    // server: v1 = V1.1 data, v2 = data + spaces (set by a V2 device)
    await c.put("/api/config", { baseVersion: 0, data: serverData() });
    await c.put("/api/config", { baseVersion: 1, data: withSpaces(), caps: ["spaces"] });
    // a V1.1 tab/device that made an offline edit at v1 (cache has no spaces, dirty)
    const local = structuredClone(FIX); local.groups[1].items[0].title = "离线改的 MoviePilot";
    const c2 = client(srv.base); await c2.post("/api/login", { name: "admin", password: "admin-pass-1" });
    const oldFront = kind === "old" ? srv.base : null;
    // the V1.1 frontend only exists on the V1.1 server; against the V2 server the same V1.1 sync body is sent by the old page still open in a tab.
    let p;
    if (oldFront) {
      p = await openPage(srv.base, c2, { storage: { "yeqv.v1": JSON.stringify(local), "nocturne.owner": "admin", "nocturne.ver": "1", "nocturne.dirty": "1" } });
      await p.idle();
      assert.ok(p.puts().some((x) => x.status === 409), "old frontend hits 409 (server moved on)");
      p.win.document.querySelector('.nc-cfs [data-cf="local"]').click(); // 用本机版覆盖
      await p.idle();
      await p.close();
    } else {
      const body = { baseVersion: 1, opId: "oldtab000001", data: (() => { const d = structuredClone(local); delete d.settings.net; delete d.recent; return d; })() };
      assert.equal((await c2.put("/api/config", body)).status, 409);
      const f = await c2.put("/api/config", Object.assign(body, { force: true, expectVersion: 2 }));
      assert.equal(f.status, 200); assert.equal(f.json.spacesKept, true);
    }
    const g = await cfgOf(c);
    assert.equal(g.data.groups[1].items[0].title, "离线改的 MoviePilot", kind + ": the offline edit won");
    if (kind === "old") {
      assert.ok(!("spaces" in g.data), "MEASURED RISK: V1.1 server + V1.1 frontend overwrite drops spaces from the current version");
      const bk = (await c.get("/api/config/backups")).json.find((x) => x.kind === "replaced");
      deq((await c.get("/api/config?backup=" + bk.id)).json.data.spaces, SPACES, "…but they stay recoverable in 恢复较早的版本");
    } else {
      deq(g.data.spaces, SPACES, "V2 server mitigation: spaces kept for a client without caps");
    }
    await srv.stop();
  }
});

test("(b) V1.1 frontend (tab left open) talking to the V2 server: edits keep spaces; deleting a group is pruned server-side", optDom, async (t) => {
  const dir = tmpData(t);
  // the page is the V1.1 frontend served by V1.1, then the server is upgraded underneath it
  let { srv, c } = await run("old", dir, true);
  await c.put("/api/config", { baseVersion: 0, data: withSpaces() });
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  await p.idle(800);
  const port = srv.port;
  await srv.stop();
  const upgraded = await startServer({ dataDir: dir, port });
  t.after(() => upgraded.stop());
  assert.equal(upgraded.base, srv.base, "same address, new version");
  // 旧服务端被 SIGKILL，会话文件可能没来得及写：重新登录（页面和 c 共用同一个 cookie jar = 同一台设备）
  assert.equal((await c.post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 200);
  p.A.commit((s) => { s.groups[0].items[0].title = "旧页面改"; }, "edit-item");
  await p.idle();
  deq((await cfgOf(c)).data.spaces, SPACES, "spaces preserved");
  p.A.commit((s) => { s.groups = s.groups.filter((x) => x.id !== "st0rage9kq2"); }, "delete-group");
  await p.idle(2500);
  const put = p.puts().at(-1);
  assert.equal(put.res.spacesPruned, 1); assert.equal(put.res.migrated, true);
  deq((await cfgOf(c)).data.spaces[1].groupIds, [], "V2 server pruned the dangling ref");
  deq(p.A.state.spaces[1].groupIds, [], "old page re-pulled (migrated) and now holds the clean copy");
});

test("(c) backups written by V2 (with spaces) restored inside V1.1 (server + frontend UI) → spaces restored", optDom, async (t) => {
  const dir = tmpData(t);
  let { srv, c } = await run("new", dir, true);
  await c.put("/api/config", { baseVersion: 0, data: withSpaces(), caps: ["spaces"] });
  const v1 = (await cfgOf(c)).data; const d2 = structuredClone(v1); d2.spaces[0].name = "v2 改名"; d2.settings.title = "v2";
  assert.equal((await c.put("/api/config", { baseVersion: 1, data: d2, caps: ["spaces"] })).status, 200); // v1 goes into the ring (first snapshot)
  await srv.stop();
  // roll back to V1.1 on the same data/
  ({ srv, c } = await run("old", dir, false));
  t.after(() => srv.stop());
  const g = await cfgOf(c);
  assert.equal(g.data.spaces[0].name, "v2 改名", "V1.1 reads V2's config file");
  const list = (await c.get("/api/config/backups")).json;
  const bk = list.find((x) => x.version === 1);
  assert.ok(bk, "V1.1 lists the backup ring written by V2");
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  await p.idle(800);
  const doc = p.win.document;
  doc.querySelector('[data-tab="账户"]').click();
  doc.querySelector('[data-u="bk"]').click();
  await sleep(500);
  const go = doc.querySelector('[data-bk] [data-id="' + bk.id + '"] [data-u="bk-go"]'); go.click(); go.click();
  await p.idle(2000);
  const after = await cfgOf(c);
  assert.equal(after.data.settings.title, "夜曲");
  deq(after.data.spaces, SPACES, "MEASURED: V1.1 restore brings the backup's spaces back verbatim");
});

test("(d) data written by V1.1 after a rollback (dangling refs, extra versions) loads in V2; refs cleaned without crash or version bump on load", optDom, async (t) => {
  const dir = tmpData(t);
  let { srv, c } = await run("new", dir, true);
  await c.put("/api/config", { baseVersion: 0, data: withSpaces(), caps: ["spaces"], opId: "v2op00000001" });
  await srv.stop();
  ({ srv, c } = await run("old", dir, false));
  // V1.1 deletes a referenced group and a pinned item (as its frontend would), twice
  let g = await cfgOf(c), d = structuredClone(g.data);
  d.groups = d.groups.filter((x) => x.id !== "chips00daily"); d.groups[0].items = d.groups[0].items.filter((i) => i.id !== "e7h2kq9b1m");
  assert.equal((await c.put("/api/config", { baseVersion: g.version, data: d })).status, 200);
  g = await cfgOf(c);
  deq(g.data.spaces[0].groupIds, ["chips00daily", "dl92kfa0q1z"], "dangling under V1.1");
  await srv.stop();
  // upgrade again
  ({ srv, c } = await run("new", dir, false));
  t.after(() => srv.stop());
  const g2 = await cfgOf(c);
  assert.equal(g2.version, g.version, "GET does not rewrite / bump");
  deq(g2.data.spaces, g.data.spaces, "server returns what V1.1 wrote");
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  await p.idle(1500);
  assert.deepEqual(p.errors, []);
  deq(p.A.state.spaces, [{ id: "s-daily", name: "日常", groupIds: ["dl92kfa0q1z"], theme: "dawn" }, { id: "s-nas", name: "NAS", groupIds: ["st0rage9kq2"], itemIds: [], theme: "frost", density: "compact" }], "V2 frontend cleans dangling refs on load");
  assert.equal(p.puts().length, 0, "loading alone pushes nothing");
  assert.equal((await cfgOf(c)).version, g.version);
  p.A.commit((s) => { s.settings.title = "回到 V2"; }, "settings");
  await p.idle();
  const g3 = await cfgOf(c);
  deq(g3.data.spaces[0].groupIds, ["dl92kfa0q1z"], "next save stores the clean refs");
  // V2 opId bookkeeping written before the rollback still works (V1.1 kept the ops list)
  const dup = await c.put("/api/config", { baseVersion: 0, data: withSpaces(), caps: ["spaces"], opId: "v2op00000001" });
  assert.equal(dup.status, 200); assert.equal(dup.json.duplicate, true, "a late replay of the pre-rollback V2 push is still recognised (V1.1 kept the ops list)");
  assert.equal((await cfgOf(c)).data.settings.title, "回到 V2", "…and does not overwrite newer data");
  const mis = await c.put("/api/config", { baseVersion: 0, data: serverData(), caps: ["spaces"], opId: "v2op00000001" });
  assert.equal(mis.status, 422, "same opId + different content is still refused after V2→V1.1→V2");
});
