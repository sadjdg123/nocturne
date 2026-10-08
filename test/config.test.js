"use strict";
/* 配置：不安全 URL 拒绝 / 旧配置兼容、409 冲突、强制覆盖、opId 去重、快照与恢复、旧版补推判定 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { seedAccount, startServer, client, cfg } = require("./helpers");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("PUT /api/config rejects unsafe URLs; legacy configs keep loading and syncing", async (t) => {
  const legacy = { version: 3, updatedAt: "2026-01-01T00:00:00.000Z", data: cfg("旧配置", [
    { id: "old", title: "旧项目", lan: "javascript:alert(1)", wan: "" },
    { id: "ok", title: "Emby", lan: "http://192.168.1.20:8096", wan: "https://emby.example.com", icon: { type: "image", value: "data:image/png;base64," + PNG.toString("base64") } },
  ]) };
  legacy.data.settings.wallpaper = { id: "custom", url: "data:image/png;base64," + PNG.toString("base64") };
  const srv = await startServer({ seed: (dir) => {
    seedAccount(dir);
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "admin.json"), JSON.stringify(legacy));
  } });
  t.after(() => srv.stop());
  const c = client(srv.base);
  await c.post("/api/login", { name: "admin", password: "admin-pass-1" });

  const g = await c.get("/api/config");
  assert.equal(g.status, 200, "old config with a bad URL still loads");
  assert.equal(g.json.data.groups[0].items[0].lan, "javascript:alert(1)", "never deleted server-side");
  assert.match(g.json.data.groups[0].items[1].icon.value, /^api\/icons\//, "legacy data:image icon migrated to a file");
  assert.equal(g.json.data.settings.wallpaper.file, true, "legacy data:image wallpaper migrated to a file");
  const v = g.json.version;

  const d = structuredClone(g.json.data); d.settings.title = "改了标题";
  assert.equal((await c.put("/api/config", { baseVersion: v, data: d })).status, 200, "grandfathered bad value does not block unrelated edits");

  for (const evil of ["javascript:alert(2)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "vbscript:x", "blob:http://x/1", "java\tscript:alert(1)"]) {
    const cur = (await c.get("/api/config")).json;
    const x = structuredClone(cur.data); x.groups[0].items.push({ id: "n" + Math.random(), title: "evil", lan: "", wan: evil });
    const r = await c.put("/api/config", { baseVersion: cur.version, data: x });
    assert.equal(r.status, 400, "must reject " + JSON.stringify(evil));
    assert.ok(Array.isArray(r.json.invalid) && r.json.invalid[0].field === "wan");
  }
  const cur = (await c.get("/api/config")).json;
  const e1 = structuredClone(cur.data); e1.settings.engines = [{ id: "e", name: "bad", url: "javascript:%s", on: true }];
  assert.equal((await c.put("/api/config", { baseVersion: cur.version, data: e1 })).status, 400, "custom engine bypass blocked");
  const e2 = structuredClone(cur.data); e2.groups[0].items[1].icon = { type: "image", value: "data:text/html;base64,PHNjcmlwdD4=" };
  assert.equal((await c.put("/api/config", { baseVersion: cur.version, data: e2 })).status, 400, "non-image data: in icon field blocked");
  const ok = structuredClone(cur.data);
  ok.groups[0].items.push({ id: "lan", title: "Jellyfin", lan: "http://192.168.1.20:8920", wan: "https://jf.example.org/web/" }, { id: "loc", title: "NAS", lan: "http://nas.local:5000", wan: "" });
  ok.settings.engines = [{ id: "g", name: "G", url: "https://www.google.com/search?q=%s", on: true }];
  assert.equal((await c.put("/api/config", { baseVersion: cur.version, data: ok })).status, 200, "legit public https, LAN http, local names, engines accepted");
});

test("optimistic concurrency: 409, force, opId, snapshots, restore", async (t) => {
  const srv = await startServer({ env: { BACKUP_KEEP: "6" } });
  t.after(() => srv.stop());
  const a = client(srv.base);
  await a.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  const b = client(srv.base);
  await b.post("/api/login", { name: "admin", password: "admin-pass-1" });

  let r = await a.put("/api/config", { baseVersion: 0, opId: "op-a-000001", data: cfg("v1") });
  assert.equal(r.json.version, 1);
  // two devices edit from v1
  r = await a.put("/api/config", { baseVersion: 1, opId: "op-a-000002", data: cfg("A 的修改") });
  assert.equal(r.status, 200); assert.equal(r.json.version, 2);
  r = await b.put("/api/config", { baseVersion: 1, opId: "op-b-000001", data: cfg("B 的修改") });
  assert.equal(r.status, 409, "later writer gets a conflict, no silent overwrite");
  assert.equal(r.json.conflict, true); assert.equal(r.json.version, 2);
  assert.equal((await a.get("/api/config")).json.data.settings.title, "A 的修改");

  // duplicate opId (e.g. keepalive succeeded but the response was lost) → same result, no new version
  r = await a.put("/api/config", { baseVersion: 1, opId: "op-a-000002", data: cfg("A 的修改") });
  assert.equal(r.status, 200); assert.equal(r.json.duplicate, true); assert.equal(r.json.version, 2);
  assert.equal((await a.get("/api/config")).json.version, 2);

  // force without / with a stale expectVersion → 409; with the current one → backup + write
  assert.equal((await b.put("/api/config", { baseVersion: 1, opId: "op-b-000001", force: true, data: cfg("B 的修改") })).status, 409);
  assert.equal((await b.put("/api/config", { baseVersion: 1, opId: "op-b-000001", force: true, expectVersion: 1, data: cfg("B 的修改") })).status, 409);
  r = await b.put("/api/config", { baseVersion: 1, opId: "op-b-000001", force: true, expectVersion: 2, data: cfg("B 的修改") });
  assert.equal(r.status, 200); assert.equal(r.json.forced, true); assert.equal(r.json.version, 3);
  let list = (await a.get("/api/config/backups")).json;
  const replaced = list.find((x) => x.kind === "replaced");
  assert.ok(replaced && replaced.version === 2, "server version backed up before forced overwrite");
  assert.equal((await a.get("/api/config?backup=" + replaced.id)).json.data.settings.title, "A 的修改");

  // stash: keep the local version as a snapshot without touching current
  r = await a.post("/api/config/stash", { baseVersion: 2, data: cfg("A 本机版") });
  assert.equal(r.status, 200);
  assert.equal((await a.get("/api/config")).json.data.settings.title, "B 的修改");
  list = (await a.get("/api/config/backups")).json;
  const local = list.find((x) => x.kind === "local");
  assert.equal((await a.get("/api/config?backup=" + local.id)).json.data.settings.title, "A 本机版");

  // same content → unchanged, no new version even with a stale baseVersion
  r = await a.put("/api/config", { baseVersion: 1, opId: "op-a-000003", data: cfg("B 的修改") });
  assert.equal(r.status, 200); assert.equal(r.json.version, 3);

  // restoring an OLD version (content in hist) is a real write, never mistaken for a replay
  r = await a.put("/api/config", { baseVersion: 3, opId: "op-a-000004", restore: true, data: cfg("v1") });
  assert.equal(r.status, 200); assert.equal(r.json.version, 4);
  assert.equal((await a.get("/api/config")).json.data.settings.title, "v1");
  assert.ok((await a.get("/api/config/backups")).json.some((x) => x.kind === "restore" && x.version === 3));

  // legacy clients (no opId): replay of an accepted-then-superseded version → stale, nothing written
  r = await a.put("/api/config", { baseVersion: 2, replay: true, data: cfg("A 的修改") });
  assert.equal(r.status, 200); assert.equal(r.json.stale, true);
  assert.equal((await a.get("/api/config")).json.version, 4);

  // ring cap
  for (let i = 0; i < 8; i++) {
    const cur = (await a.get("/api/config")).json;
    await a.put("/api/config", { baseVersion: cur.version, opId: "op-r-00000" + i, restore: true, data: cfg("轮次 " + i) });
  }
  list = (await a.get("/api/config/backups")).json;
  assert.ok(list.length <= 6, "BACKUP_KEEP respected, got " + list.length);
  // responses never leak hist / ops
  const doc = (await a.get("/api/config")).json;
  assert.equal(doc.hist, undefined); assert.equal(doc.ops, undefined);
  const raw = JSON.parse(fs.readFileSync(path.join(srv.dataDir, "config", "admin.json"), "utf8"));
  assert.ok(Array.isArray(raw.ops) && raw.ops.length <= 50);
});

test("periodic snapshots on ordinary saves; uploaded icons survive restore", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const a = client(srv.base);
  await a.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  const up = await a.req("POST", "/api/icons", PNG, { "Content-Type": "image/png" });
  assert.equal(up.status, 200);
  const ref = up.json.url;
  let v = 0;
  const save = async (title, icon) => {
    const r = await a.put("/api/config", { baseVersion: v, opId: "op-s-" + String(v).padStart(6, "0"), data: cfg(title, [{ id: "i", title: "x", lan: "http://192.168.1.2", icon }]) });
    assert.equal(r.status, 200); v = r.json.version;
  };
  await save("with icon", { type: "image", value: ref });
  for (let i = 0; i < 22; i++) await save("edit " + i, { type: "emoji", value: "🎬" });
  const list = (await a.get("/api/config/backups")).json;
  const autos = list.filter((x) => x.kind === "auto");
  assert.ok(autos.length >= 2, "first save + every 20 versions → auto snapshots, got " + autos.length);
  const withIcon = autos.find((x) => x.version === 1);
  assert.ok(withIcon, "v1 (the one with the icon) snapshotted");
  const old = (await a.get("/api/config?backup=" + withIcon.id)).json;
  assert.equal(old.data.groups[0].items[0].icon.value, ref);
  assert.equal((await a.get("/" + ref)).status, 200, "icon referenced only by a snapshot is kept");
  assert.equal((await a.put("/api/config", { baseVersion: v, opId: "op-s-restore", restore: true, data: old.data })).status, 200);
  assert.equal((await a.get("/" + ref)).status, 200);
});
