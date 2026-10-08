"use strict";
/* V2.0 RC · 回滚写保护（spaces-guard）+ 固定的升级前快照（pre-v2-snapshot）—— 真实进程实测。
 * 旧版 = V1.1 基线（main@3e6da3c）的 server.js + 前端，按 blob SHA 从 git 取出（test/v11.js）；同一个 data 目录上来回切换版本：
 *   V1.1 写数据 → 升级到 V2（写固定快照）→ V2 建空间 → 回滚到 V1.1，旧前端「用本机版覆盖」/ 普通保存把空间丢掉 → 再升级到 V2 → 自动找回 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer, client, sleep } = require("./helpers");
const { openPage, SKIP: NO_DOM } = require("./browser");
const { v11Root } = require("./v11");

const V11 = v11Root();
const SKIP = V11.skip || false;
const opt = { skip: SKIP, timeout: 90000 };
const optDom = { skip: SKIP || NO_DOM, timeout: 90000 };
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const SPACES = [
  { id: "s-daily", name: "日常", groupIds: ["chips00daily", "dl92kfa0q1z"], theme: "dawn" },
  { id: "s-nas", name: "NAS", groupIds: ["st0rage9kq2"], itemIds: ["e7h2kq9b1m"], theme: "frost", density: "compact" },
];
const CAPS = ["spaces", "spaces:2"];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2048), Buffer.from([0xff, 0xd9])]);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const plain = (v) => JSON.parse(JSON.stringify(v));

function tmpData(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-guard-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
async function run(kind, dataDir, first) {
  const srv = await startServer({ root: kind === "old" ? V11.root : undefined, dataDir });
  const c = client(srv.base);
  const r = first ? await c.post("/api/setup", { name: "admin", password: "admin-pass-1" }) : await c.post("/api/login", { name: "admin", password: "admin-pass-1" });
  assert.equal(r.status, 200, kind + " server login");
  return { srv, c };
}
const cfgOf = async (c) => (await c.get("/api/config")).json;
const disk = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const snapshots = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith("pre-v2-snapshot-"));

/** V1.1 上准备一份真实数据：管理员 + 第二个账户、配置、上传的图标、自定义壁纸 */
async function seedV11(dir) {
  const { srv, c } = await run("old", dir, true);
  const up = await c.req("POST", "/api/icons", PNG, { "Content-Type": "image/png" });
  assert.equal(up.status, 200, "V1.1 icon upload");
  const d = serverData(); d.groups[0].items[0].icon = { type: "image", value: up.json.url, bg: "" };
  assert.equal((await c.put("/api/config", { baseVersion: 0, data: d })).status, 200);
  assert.equal((await c.req("PUT", "/api/wallpaper", JPG, { "Content-Type": "image/jpeg" })).status, 200, "V1.1 wallpaper upload");
  const w = (await cfgOf(c)); w.data.settings.wallpaper = { id: "custom", file: true, v: 1, url: "" };
  assert.equal((await c.put("/api/config", { baseVersion: w.version, data: w.data })).status, 200);
  assert.equal((await c.post("/api/users", { name: "bob", password: "bob-pass-12" })).status, 200);
  await srv.stop();
  return { iconUrl: up.json.url };
}

test("upgrade → spaces → rollback to V1.1 → old writes drop spaces → re-upgrade: spaces auto-recovered, nothing else lost", opt, async (t) => {
  const dir = tmpData(t);
  const { iconUrl } = await seedV11(dir);
  const v11cfg = fs.readFileSync(path.join(dir, "config", "admin.json"));
  assert.ok(!("writer" in JSON.parse(v11cfg)), "V1.1 writes no writer marker");

  // 1. upgrade: pinned pre-v2 snapshot
  let { srv, c } = await run("new", dir);
  const snap = snapshots(dir);
  assert.equal(snap.length, 1, "exactly one pinned snapshot");
  const man = disk(dir, path.join(snap[0], "MANIFEST.json"));
  const paths = man.files.map((f) => f.path).sort();
  assert.ok(paths.includes("users.json") && paths.includes("config/admin.json") && paths.some((p) => p.startsWith("icons/admin/")) && paths.some((p) => p.startsWith("wallpapers/admin.")), paths.join(","));
  for (const f of man.files) assert.equal(sha(fs.readFileSync(path.join(dir, snap[0], f.path))), f.sha256, "snapshot file hash " + f.path);
  assert.deepEqual(fs.readFileSync(path.join(dir, snap[0], "config", "admin.json")), v11cfg, "snapshot = V1.1 config byte for byte");
  assert.match(srv.log(), /pre-v2 snapshot written/);
  // V2 creates spaces → writer marker + guard sidecar
  let cur = await cfgOf(c);
  const d2 = Object.assign(cur.data, { spaces: structuredClone(SPACES), spacesVersion: 2 });
  assert.equal((await c.put("/api/config", { baseVersion: cur.version, data: d2, caps: CAPS })).status, 200);
  const onDisk = disk(dir, "config/admin.json");
  assert.equal(onDisk.writer.app, "nocturne"); assert.equal(onDisk.writer.gen, 2);
  const guard = disk(dir, "spaces-guard/admin.json");
  assert.deepEqual(plain(guard.spaces), plain(onDisk.data.spaces)); assert.equal(guard.version, onDisk.version);
  assert.ok(!("writer" in (await cfgOf(c))), "marker is not part of the API document");
  const v2ver = onDisk.version;
  await srv.stop();

  // 2. rollback to V1.1: ordinary edit keeps spaces, then 用本机版覆盖 with a pre-V2 copy drops them
  ({ srv, c } = await run("old", dir));
  cur = await cfgOf(c);
  assert.equal(cur.data.spaces.length, 2, "V1.1 reads V2 config");
  const edit = structuredClone(cur.data); edit.groups[0].items.push({ id: "rbitem0001", title: "回滚期间新增", lan: "", wan: "https://rollback.example", icon: { type: "", value: "", bg: "" } });
  assert.equal((await c.put("/api/config", { baseVersion: cur.version, data: edit })).status, 200);
  const stale = serverData(); stale.groups[0].items[0].icon = { type: "image", value: iconUrl, bg: "" }; stale.settings.wallpaper = { id: "custom", file: true, v: 1, url: "" };
  stale.groups[0].items.push({ id: "rbitem0001", title: "回滚期间新增", lan: "", wan: "https://rollback.example", icon: { type: "", value: "", bg: "" } });
  stale.settings.title = "旧设备覆盖";
  const ver = (await cfgOf(c)).version;
  assert.equal((await c.put("/api/config", { baseVersion: v2ver - 1, data: stale })).status, 409);
  assert.equal((await c.put("/api/config", { baseVersion: v2ver - 1, data: stale, force: true, expectVersion: ver })).status, 200);
  const lost = disk(dir, "config/admin.json");
  assert.ok(!("spaces" in lost.data), "MEASURED: V1.1 drops the spaces"); assert.ok(!("writer" in lost), "and the V2 marker");
  await srv.stop();

  // 3. re-upgrade: recovered automatically
  ({ srv, c } = await run("new", dir));
  const back = await cfgOf(c);
  assert.deepEqual(plain(back.data.spaces), plain(SPACES), "spaces recovered");
  assert.equal(back.data.spacesVersion, 2);
  assert.equal(back.data.settings.title, "旧设备覆盖", "the V1.1 edit is kept (not reverted)");
  assert.ok(back.data.groups[0].items.some((x) => x.id === "rbitem0001"), "item added during rollback kept");
  assert.equal(back.version, lost.version + 1, "one new version");
  assert.equal(back.recovered.spaces, 2, "API carries the recovery notice"); assert.equal(back.recovered.at, back.updatedAt);
  assert.match(srv.log(), /spaces guard: restored admin 2 spaces v\d+ -> v\d+/);
  const bk = (await c.get("/api/config/backups")).json.find((x) => x.kind === "guard");
  assert.ok(bk, "the pre-recovery version is in the backup ring"); assert.equal(bk.spaces, null); assert.equal(bk.version, lost.version);
  // icons / wallpaper / accounts untouched
  assert.equal(sha((await c.get("/" + iconUrl)).body), sha(PNG), "uploaded icon intact");
  assert.equal(sha((await c.get("/api/wallpaper")).body), sha(JPG), "wallpaper intact");
  const bob = client(srv.base); assert.equal((await bob.post("/api/login", { name: "bob", password: "bob-pass-12" })).status, 200, "second account intact");
  const html = (await c.get("/")).body.toString("utf8");
  assert.match(html, /"recovered":\{"at":"[^"]+","spaces":2\}/, "page boot carries the notice");
  assert.equal(snapshots(dir).length, 1, "no second pinned snapshot on re-upgrade");
  await srv.stop();
  // 4. another restart: idempotent
  ({ srv, c } = await run("new", dir));
  assert.equal((await cfgOf(c)).version, back.version, "no further writes on restart");
  assert.doesNotMatch(srv.log(), /spaces guard: restored/);
  await srv.stop();
});

test("guard does not resurrect spaces the user removed in V2, nor touch configs swapped back by hand", opt, async (t) => {
  // (a) V2 explicitly deletes all spaces ([]) → rollback forced overwrite drops the field → re-upgrade: stays without spaces
  const dir = tmpData(t);
  let { srv, c } = await run("new", dir, true);
  await c.put("/api/config", { baseVersion: 0, data: Object.assign(serverData(), { spaces: structuredClone(SPACES) }), caps: CAPS });
  await c.put("/api/config", { baseVersion: 1, data: Object.assign(serverData(), { spaces: [] }), caps: CAPS });
  assert.deepEqual(disk(dir, "spaces-guard/admin.json").spaces, []);
  assert.equal(snapshots(dir).length, 0, "fresh V2 install: no pre-v2 snapshot");
  await srv.stop();
  ({ srv, c } = await run("old", dir));
  const d = serverData(); d.settings.title = "x";
  await c.put("/api/config", { baseVersion: 0, data: d, force: true, expectVersion: 2 });
  await srv.stop();
  ({ srv, c } = await run("new", dir));
  let g = await cfgOf(c);
  assert.ok(!("spaces" in g.data) && !g.recovered, "explicit delete is respected");
  assert.equal(snapshots(dir).length, 1, "V1.1 stripped every V2 marker → the re-upgrade pins the rolled-back state too (only when no snapshot exists yet)");
  // (b) V2 write without a spaces field (恢复默认) → guard null → nothing to recover
  await c.put("/api/config", { baseVersion: g.version, data: Object.assign(serverData(), { spaces: structuredClone(SPACES) }), caps: CAPS });
  g = await cfgOf(c);
  await c.put("/api/config", { baseVersion: g.version, data: serverData(), caps: CAPS });
  assert.equal(disk(dir, "spaces-guard/admin.json").spaces, null);
  await srv.stop();
  ({ srv, c } = await run("old", dir));
  g = await cfgOf(c); const e = g.data; e.settings.title = "y";
  await c.put("/api/config", { baseVersion: g.version, data: e });
  await srv.stop();
  ({ srv, c } = await run("new", dir));
  assert.ok(!("spaces" in (await cfgOf(c)).data));
  // (c) config replaced by hand with an older file (version not newer than guard) → skipped + logged
  g = await cfgOf(c);
  await c.put("/api/config", { baseVersion: g.version, data: Object.assign(serverData(), { spaces: structuredClone(SPACES) }), caps: CAPS });
  const gv = disk(dir, "spaces-guard/admin.json").version;
  await srv.stop();
  fs.writeFileSync(path.join(dir, "config", "admin.json"), JSON.stringify({ version: gv - 3, updatedAt: new Date().toISOString(), data: serverData() }));
  ({ srv, c } = await run("new", dir));
  g = await cfgOf(c);
  assert.ok(!("spaces" in g.data) && !g.recovered, "hand-restored older config left alone");
  assert.match(srv.log(), /spaces guard: skipped admin config v\d+ is not newer than guard v\d+/);
  await srv.stop();
});

test("V1.1 frontend 用本机版覆盖 on the V1.1 server, then re-upgrade: V2 page shows the recovery notice once", optDom, async (t) => {
  const dir = tmpData(t);
  let { srv, c } = await run("new", dir, true);
  await c.put("/api/config", { baseVersion: 0, data: serverData(), caps: CAPS });
  await c.put("/api/config", { baseVersion: 1, data: Object.assign(serverData(), { spaces: structuredClone(SPACES) }), caps: CAPS });
  await srv.stop();
  ({ srv, c } = await run("old", dir));
  const local = structuredClone(FIX); local.groups[1].items[0].title = "离线改的 MoviePilot";
  const c2 = client(srv.base); await c2.post("/api/login", { name: "admin", password: "admin-pass-1" });
  let p = await openPage(srv.base, c2, { storage: { "yeqv.v1": JSON.stringify(local), "nocturne.owner": "admin", "nocturne.ver": "1", "nocturne.dirty": "1" } });
  await p.idle();
  assert.ok(p.puts().some((x) => x.status === 409), "old frontend hits 409");
  p.win.document.querySelector('.nc-cfs [data-cf="local"]').click(); // 用本机版覆盖（V1.1 真实代码路径）
  await p.idle();
  await p.close();
  assert.ok(!("spaces" in (await cfgOf(c)).data), "V1.1 lost the spaces");
  await srv.stop();
  ({ srv, c } = await run("new", dir));
  const g = await cfgOf(c);
  assert.deepEqual(plain(g.data.spaces), plain(SPACES));
  assert.equal(g.data.groups[1].items[0].title, "离线改的 MoviePilot");
  p = await openPage(srv.base, c, { storage: { "nocturne.owner": "admin" } });
  await p.idle(600);
  const msg = p.win.document.getElementById("x-toast-msg").textContent;
  assert.match(msg, /2 个空间已自动找回/);
  assert.ok(p.win.document.getElementById("x-toast").classList.contains("is-on"));
  assert.equal(p.A.state.spaces.length, 2, "V2 page has the spaces");
  assert.deepEqual(p.errors, []);
  const st = p.storage();
  await p.close();
  p = await openPage(srv.base, c, { storage: st });
  await p.idle(400);
  assert.doesNotMatch(p.win.document.getElementById("x-toast-msg").textContent, /自动找回/, "shown once per device");
  await p.close();
  await srv.stop();
});

test("deleting a user removes its guard sidecar; pinned snapshot stays", opt, async (t) => {
  const dir = tmpData(t);
  await seedV11(dir);
  const { srv, c } = await run("new", dir);
  t.after(() => srv.stop());
  const bob = client(srv.base); await bob.post("/api/login", { name: "bob", password: "bob-pass-12" });
  await bob.put("/api/config", { baseVersion: 0, data: Object.assign(serverData(), { spaces: structuredClone(SPACES) }), caps: CAPS });
  assert.ok(fs.existsSync(path.join(dir, "spaces-guard", "bob.json")));
  assert.equal((await c.del("/api/users/bob")).status, 200);
  await sleep(50);
  assert.ok(!fs.existsSync(path.join(dir, "spaces-guard", "bob.json")));
  assert.equal(snapshots(dir).length, 1);
});
