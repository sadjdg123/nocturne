"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, client, cfg, waitFor, ROOT } = require("./helpers");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const INLINE = "data:image/png;base64," + PNG.toString("base64");
const BYTE_LIMIT = 50 * 1024 * 1024, FILE_BYTES = 512 * 1024;
const id = i => "existing_" + String(i).padStart(16, "0");
const refItem = i => ({ id: "ref-" + i, icon: { type: "image", value: "api/icons/" + id(i) } });
const inline = (count, title = "Inline migration") => cfg(title, Array.from({ length: count }, (_, i) => ({ id: "inline-" + i, icon: { type: "image", value: INLINE } })));
const doc = (data, legacy = false) => ({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", data, ...(legacy ? {} : { writer: { app: "nocturne", gen: 2 } }) });
const configPath = dir => path.join(dir, "config/default.json");
const iconPath = (dir, i) => path.join(dir, "icons/default", id(i) + ".png");
const readDoc = dir => JSON.parse(fs.readFileSync(configPath(dir), "utf8"));
function iconFiles(dir) {
  try { return fs.readdirSync(path.join(dir, "icons/default")).filter(x => /^[A-Za-z0-9_-]{16,64}\.(png|jpg|webp)$/.test(x)).sort(); } catch { return []; }
}
function mediaTree(dir) {
  const out = {};
  function visit(target, rel) {
    if (!fs.existsSync(target)) return;
    for (const item of fs.readdirSync(target, { withFileTypes: true })) {
      const name = rel + "/" + item.name, file = path.join(target, item.name);
      if (item.isDirectory()) visit(file, name); else out[name] = fs.readFileSync(file).toString("base64");
    }
  }
  visit(path.join(dir, "icons"), "icons"); visit(path.join(dir, "wallpapers"), "wallpapers");
  return out;
}
function seedIcon(dir, i, size = PNG.length) {
  const file = iconPath(dir, i);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "wx");
  try { fs.writeSync(fd, PNG); fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); }
}
function marks(dir, ids, age) {
  fs.writeFileSync(path.join(dir, "icons/default/.orphans.json"), JSON.stringify(Object.fromEntries(ids.map(i => [id(i), Date.now() - age]))));
}
async function launch(t, options = {}) {
  const original = options.data || cfg("Previous config"), legacy = !!options.legacy;
  const env = { NOCTURNE_NO_AUTH: "1", ...(options.faults ? { NODE_OPTIONS: "--require=" + path.join(ROOT, "test/fsfail.js") + " --require=" + path.join(ROOT, "test/icon-migration-fault.js") } : {}) };
  const server = await startServer({
    env,
    seed(dir) {
      fs.mkdirSync(path.join(dir, "config"));
      fs.writeFileSync(configPath(dir), JSON.stringify(doc(original, legacy)));
      if (options.seed) options.seed(dir);
      if (options.faults) {
        env.FSFAIL_CTL = path.join(dir, "fs-fault");
        env.MEDIAFAIL_CTL = path.join(dir, "media-fault");
        fs.writeFileSync(env.FSFAIL_CTL, options.rule || "");
        fs.writeFileSync(env.MEDIAFAIL_CTL, JSON.stringify(options.media || {}));
      }
    },
  });
  t.after(() => server.stop());
  const c = client(server.base);
  return { ...server, c,
    setRule(value) { fs.writeFileSync(path.join(server.dataDir, "fs-fault"), value); },
    setMedia(value) { fs.writeFileSync(path.join(server.dataDir, "media-fault"), JSON.stringify(value)); },
  };
}
async function migratedImages(c, data) {
  for (const item of data.groups[0].items.filter(x => x.id.startsWith("inline-"))) {
    assert.match(item.icon.value, /^api\/icons\/[A-Za-z0-9_-]{16,64}$/);
    const image = await c.get("/" + item.icon.value);
    assert.equal(image.status, 200); assert.deepEqual(image.body, PNG);
  }
}

for (const blocked of [false, true]) {
  test("metadata-only config GET and PUT tolerate " + (blocked ? "a regular-file icon directory blocker" : "an ordinary icon directory"), async t => {
    const original = { settings: { title: "Metadata fixture" }, groups: [] };
    const f = await launch(t, { data: original, seed(dir) {
      fs.mkdirSync(path.join(dir, "icons"));
      if (blocked) fs.writeFileSync(path.join(dir, "icons/default"), "owned icon directory blocker");
      else fs.mkdirSync(path.join(dir, "icons/default"));
    } });
    const media = mediaTree(f.dataDir), data = { settings: { title: "Metadata-only edit" }, groups: [] };
    const get = await f.c.get("/api/config");
    const put = await f.c.put("/api/config", { baseVersion: 1, data });
    assert.deepEqual({ get: get.status, put: put.status }, { get: 200, put: 200 });
    assert.deepEqual(get.json.data, original);
    assert.equal(get.json.version, 1);
    assert.equal(put.json.version, 2);
    assert.deepEqual(readDoc(f.dataDir).data, data);
    const saved = await f.c.get("/api/config");
    assert.equal(saved.status, 200);
    assert.equal(saved.json.version, 2);
    assert.deepEqual(saved.json.data, data);
    assert.deepEqual(mediaTree(f.dataDir), media);
    if (blocked) assert.equal(fs.statSync(path.join(f.dataDir, "icons/default")).isFile(), true);
    assert.equal((await f.c.get("/api/health")).status, 200);
    assert.equal(f.child.exitCode, null);
  });
}

test("eligible inline allocation reports a real icon directory error without changing config or resources", async t => {
  const f = await launch(t, { data: { settings: { title: "Retained metadata" }, groups: [] }, seed(dir) {
    fs.mkdirSync(path.join(dir, "icons"));
    fs.writeFileSync(path.join(dir, "icons/default"), "owned icon directory blocker");
    fs.mkdirSync(path.join(dir, "wallpapers"));
    fs.writeFileSync(path.join(dir, "wallpapers/default.png"), PNG);
  } });
  const before = fs.readFileSync(configPath(f.dataDir)), media = mediaTree(f.dataDir), candidate = inline(1);
  candidate.settings.wallpaper = { id: "custom", url: INLINE };
  assert.equal((await f.c.put("/api/config", { baseVersion: 1, data: candidate })).status, 500);
  assert.deepEqual(fs.readFileSync(configPath(f.dataDir)), before);
  assert.deepEqual(mediaTree(f.dataDir), media);
  const legacy = JSON.stringify(doc(candidate, true));
  fs.writeFileSync(configPath(f.dataDir), legacy);
  assert.equal((await f.c.get("/api/config")).status, 500);
  assert.equal(fs.readFileSync(configPath(f.dataDir), "utf8"), legacy);
  assert.deepEqual(mediaTree(f.dataDir), media);
  assert.match(f.log(), /ENOTDIR/);
  assert.equal((await f.c.get("/api/health")).status, 200);
  assert.equal(f.child.exitCode, null);
});

test("501 identical inline icons reject before config, icon or wallpaper writes", async t => {
  const f = await launch(t), candidate = inline(501);
  assert.equal((await f.c.req("PUT", "/api/wallpaper", PNG, { "Content-Type": "image/png" })).status, 200);
  candidate.settings.wallpaper = { id: "custom", url: INLINE };
  const before = fs.readFileSync(configPath(f.dataDir)), media = mediaTree(f.dataDir);
  const response = await f.c.put("/api/config", { baseVersion: 1, data: candidate });
  assert.equal(response.status, 413);
  assert.deepEqual(fs.readFileSync(configPath(f.dataDir)), before);
  assert.deepEqual(mediaTree(f.dataDir), media);
  assert.equal((await f.c.get("/api/config")).json.version, 1);
});

test("500 identical icons fit, opId replay allocates nothing, direct replacement stays allowed", async t => {
  const f = await launch(t), candidate = inline(500);
  const saved = await f.c.put("/api/config", { baseVersion: 1, opId: "inline-migration-500", data: candidate });
  assert.equal(saved.status, 200); assert.equal(saved.json.migrated, true);
  const current = await f.c.get("/api/config");
  assert.equal(current.json.version, 2); assert.equal(iconFiles(f.dataDir).length, 500);
  const values = current.json.data.groups[0].items.map(x => x.icon.value);
  assert.equal(new Set(values).size, 500);
  const replay = await f.c.put("/api/config", { baseVersion: 1, opId: "inline-migration-500", data: candidate });
  assert.equal(replay.status, 200); assert.equal(replay.json.duplicate, true); assert.equal(iconFiles(f.dataDir).length, 500);
  const replacement = await f.c.req("PUT", "/" + values[0], PNG, { "Content-Type": "image/png" });
  assert.equal(replacement.status, 200); assert.equal(iconFiles(f.dataDir).length, 500);
  assert.deepEqual((await f.c.get("/" + values[0])).body, PNG);
  assert.equal((await f.c.req("POST", "/api/icons", PNG, { "Content-Type": "image/png" })).status, 413);
});

test("existing account usage and all planned allocations share the count limit", async t => {
  const f = await launch(t, { data: cfg("Existing icon", [refItem(0)]), seed: dir => seedIcon(dir, 0) });
  const before = fs.readFileSync(configPath(f.dataDir)), media = mediaTree(f.dataDir);
  assert.equal((await f.c.put("/api/config", { baseVersion: 1, data: inline(500) })).status, 413);
  assert.deepEqual(fs.readFileSync(configPath(f.dataDir)), before); assert.deepEqual(mediaTree(f.dataDir), media);
});

for (const extra of [0, 1]) {
  test("aggregate planned bytes at 50MB " + (extra ? "plus one reject before media writes" : "fit exactly"), async t => {
    const refs = Array.from({ length: 100 }, (_, i) => refItem(i));
    const f = await launch(t, { data: cfg("Referenced sparse PNG files", refs), seed(dir) {
      for (let i = 0; i < 100; i++) seedIcon(dir, i, FILE_BYTES - (i === 99 ? 2 * PNG.length - extra : 0));
    } });
    const candidate = inline(2); candidate.groups[0].items.unshift(...refs); candidate.settings.wallpaper = { id: "custom", url: INLINE };
    const before = fs.readFileSync(configPath(f.dataDir));
    const response = await f.c.put("/api/config", { baseVersion: 1, data: candidate });
    assert.equal(response.status, extra ? 413 : 200);
    if (extra) {
      assert.deepEqual(fs.readFileSync(configPath(f.dataDir)), before); assert.equal(iconFiles(f.dataDir).length, 100);
      assert.equal(fs.existsSync(path.join(f.dataDir, "wallpapers/default.png")), false);
    } else {
      assert.equal(iconFiles(f.dataDir).length, 102);
      assert.equal(iconFiles(f.dataDir).reduce((sum, name) => sum + fs.statSync(path.join(f.dataDir, "icons/default", name)).size, 0), BYTE_LIMIT);
      await migratedImages(f.c, readDoc(f.dataDir).data);
      assert.equal((await f.c.req("POST", "/api/icons", PNG, { "Content-Type": "image/png" })).status, 413);
      assert.equal((await f.c.req("PUT", "/api/icons/" + id(99), PNG, { "Content-Type": "image/png" })).status, 200);
      assert.equal(iconFiles(f.dataDir).length, 102);
    }
  });
}

test("quota cleanup protects incoming candidate, current and backup icon references", async t => {
  const currentRefs = Array.from({ length: 490 }, (_, i) => refItem(i));
  const backupRefs = Array.from({ length: 5 }, (_, i) => refItem(490 + i));
  const candidateRefs = Array.from({ length: 5 }, (_, i) => refItem(495 + i));
  const f = await launch(t, { data: cfg("Current refs", currentRefs), seed(dir) {
    for (let i = 0; i < 500; i++) seedIcon(dir, i);
    marks(dir, Array.from({ length: 500 }, (_, i) => i), 25 * 3600e3);
    fs.mkdirSync(path.join(dir, "backup/default"), { recursive: true });
    fs.writeFileSync(path.join(dir, "backup/default/176000000000000-v1-auto.json"), JSON.stringify(doc(cfg("Backup refs", backupRefs))));
  } });
  const candidate = inline(1); candidate.groups[0].items.unshift(...candidateRefs);
  assert.equal((await f.c.put("/api/config", { baseVersion: 1, data: candidate })).status, 413);
  assert.equal(readDoc(f.dataDir).version, 1); assert.equal(iconFiles(f.dataDir).length, 500);
  for (const i of [0, 489, 490, 494, 495, 499]) assert.deepEqual(fs.readFileSync(iconPath(f.dataDir, i)), PNG);
});

for (const ageHours of [23, 25]) {
  test("quota cleanup " + (ageHours === 23 ? "preserves the 24h orphan grace period" : "can reclaim an expired unreferenced icon"), async t => {
    const refs = Array.from({ length: 499 }, (_, i) => refItem(i));
    const f = await launch(t, { data: cfg("Current refs", refs), seed(dir) {
      for (let i = 0; i < 500; i++) seedIcon(dir, i);
      marks(dir, [499], ageHours * 3600e3);
    } });
    const candidate = inline(1); candidate.groups[0].items.unshift(...refs);
    const response = await f.c.put("/api/config", { baseVersion: 1, data: candidate });
    assert.equal(response.status, ageHours === 23 ? 413 : 200); assert.equal(iconFiles(f.dataDir).length, 500);
    assert.equal(fs.existsSync(iconPath(f.dataDir, 499)), ageHours === 23);
    assert.equal(readDoc(f.dataDir).version, ageHours === 23 ? 1 : 2);
  });
}

for (const kind of ["nth-icon", "icon-rename-result", "config-rename"]) {
  test("handled " + kind + " failure removes only owned uncommitted icon files", async t => {
    const f = await launch(t, { faults: true, data: cfg("Pre-existing icon", [refItem(0)]), seed: dir => seedIcon(dir, 0) });
    const before = fs.readFileSync(configPath(f.dataDir)), media = mediaTree(f.dataDir);
    if (kind === "nth-icon") f.setMedia({ mode: "icon_partial", at: 2 });
    else if (kind === "icon-rename-result") f.setMedia({ mode: "after_icon_rename", at: 2 });
    else f.setRule("rename config[/\\\\]default\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
    const response = await f.c.put("/api/config", { baseVersion: 1, data: inline(3) });
    assert.equal(response.status, 500);
    assert.deepEqual(fs.readFileSync(configPath(f.dataDir)), before); assert.deepEqual(mediaTree(f.dataDir), media);
    assert.equal((await f.c.get("/api/icons/" + id(0))).status, 200);
    assert.equal(fs.readdirSync(path.join(f.dataDir, "config")).some(x => x.endsWith(".tmp")), false);
  });
}

for (const mode of ["after_config_rename", "after_config_rename_unreadable"]) {
  test(mode + " keeps every resource referenced by a committed config", async t => {
    const f = await launch(t, { faults: true }); f.setMedia({ mode });
    const response = await f.c.put("/api/config", { baseVersion: 1, data: inline(2) });
    assert.equal(response.status, 500);
    const committed = readDoc(f.dataDir); assert.equal(committed.version, 2); assert.equal(iconFiles(f.dataDir).length, 2);
    for (const item of committed.data.groups[0].items) {
      assert.match(item.icon.value, /^api\/icons\/[A-Za-z0-9_-]{16,64}$/);
      assert.deepEqual(fs.readFileSync(path.join(f.dataDir, "icons/default", item.icon.value.slice("api/icons/".length) + ".png")), PNG);
    }
    if (mode === "after_config_rename") await migratedImages(f.c, committed.data);
  });
}

test("guardWarning reports a successful migrated save and retains its resources", async t => {
  const f = await launch(t, { faults: true });
  f.setRule("rename spaces-guard[/\\\\]default\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
  const response = await f.c.put("/api/config", { baseVersion: 1, data: inline(2) });
  assert.equal(response.status, 200); assert.equal(response.json.guardWarning, "spaces_guard_write_failed");
  assert.equal(readDoc(f.dataDir).version, 2); assert.equal(iconFiles(f.dataDir).length, 2);
  await migratedImages(f.c, readDoc(f.dataDir).data);
});

for (const source of ["startup", "read"]) {
  test("optional " + source + " over-quota migration leaves legacy inline config readable", async t => {
    const original = inline(501); original.settings.wallpaper = { id: "custom", url: INLINE };
    const f = await launch(t, source === "startup" ? { data: original, legacy: true } : {});
    if (source === "read") fs.writeFileSync(configPath(f.dataDir), JSON.stringify(doc(original, true)));
    const before = fs.readFileSync(configPath(f.dataDir)), response = await f.c.get("/api/config");
    assert.equal(response.status, 200); assert.equal(response.json.version, 1); assert.deepEqual(response.json.data, original);
    assert.deepEqual(fs.readFileSync(configPath(f.dataDir)), before); assert.equal(iconFiles(f.dataDir).length, 0);
    assert.equal(fs.existsSync(path.join(f.dataDir, "wallpapers/default.png")), false);
    assert.match(f.log(), /icon migration skipped.*quota.*default/);
  });
}

for (const source of ["startup", "read"]) {
  test("optional " + source + " config commit failure cleans its new icon files", async t => {
    const original = inline(2), rule = "rename config[/\\\\]default\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n";
    const f = await launch(t, source === "startup" ? { faults: true, data: original, legacy: true, rule } : { faults: true });
    if (source === "read") {
      fs.writeFileSync(configPath(f.dataDir), JSON.stringify(doc(original, true))); f.setRule(rule);
      assert.equal((await f.c.get("/api/config")).status, 500);
    } else assert.ok(await waitFor(() => /migrate default ENOSPC/.test(f.log())));
    assert.deepEqual(readDoc(f.dataDir), doc(original, true)); assert.equal(iconFiles(f.dataDir).length, 0);
  });
}

test("ordinary legacy GET migrates all eligible images and preserves unsupported inline images", async t => {
  const f = await launch(t), original = inline(2);
  original.groups[0].items.push({ id: "svg", icon: { type: "image", value: "data:image/svg+xml;base64,PHN2Zy8+" } });
  fs.writeFileSync(configPath(f.dataDir), JSON.stringify(doc(original, true)));
  const response = await f.c.get("/api/config");
  assert.equal(response.status, 200); assert.equal(response.json.version, 2); assert.equal(iconFiles(f.dataDir).length, 2);
  assert.deepEqual(response.json.data.groups[0].items[2], original.groups[0].items[2]);
  await migratedImages(f.c, response.json.data);
});

test("migration preserves conflict, force, restore, backup, Spaces and input-hash fences", async t => {
  const original = cfg("Spaces config");
  original.spacesVersion = 1; original.spaces = [{ id: "s-home", name: "Home", groupIds: ["g1"] }];
  const f = await launch(t, { data: original }), first = inline(1, "First inline save");
  const saved = await f.c.put("/api/config", { baseVersion: 1, opId: "first-inline-save", data: first });
  assert.equal(saved.status, 200); assert.equal(saved.json.spacesKept, true);
  const v2 = (await f.c.get("/api/config")).json;
  assert.equal(v2.version, 2); assert.deepEqual(v2.data.spaces, original.spaces);
  const second = inline(1, "Forced inline save"), media = mediaTree(f.dataDir);
  assert.equal((await f.c.put("/api/config", { baseVersion: 1, data: second })).status, 409);
  assert.equal((await f.c.put("/api/config", { baseVersion: 1, force: true, expectVersion: 1, data: second })).status, 409);
  assert.deepEqual(mediaTree(f.dataDir), media);
  const request = { baseVersion: 1, opId: "force-inline-save", force: true, expectVersion: 2, data: second };
  const forced = await f.c.put("/api/config", request);
  assert.equal(forced.status, 200); assert.equal(forced.json.forced, true); assert.equal(forced.json.version, 3);
  assert.equal((await f.c.put("/api/config", request)).json.duplicate, true);
  assert.equal((await f.c.put("/api/config", { ...request, data: inline(1, "Different input") })).status, 422);
  const backups = (await f.c.get("/api/config/backups")).json, replaced = backups.find(x => x.kind === "replaced");
  assert.ok(replaced); assert.equal(replaced.version, 2);
  assert.deepEqual((await f.c.get("/api/config?backup=" + replaced.id)).json.data, v2.data);
  const restored = await f.c.put("/api/config", { baseVersion: 3, restore: true, data: v2.data, caps: ["spaces", "spaces:1"] });
  assert.equal(restored.status, 200); assert.equal(restored.json.version, 4);
  assert.deepEqual((await f.c.get("/api/config")).json.data, v2.data);
  const withRestore = (await f.c.get("/api/config/backups")).json;
  assert.ok(withRestore.some(x => x.kind === "restore" && x.version === 3)); assert.equal(iconFiles(f.dataDir).length, 2);
  const before = fs.readFileSync(configPath(f.dataDir)), beforeMedia = mediaTree(f.dataDir);
  const rejected = await f.c.put("/api/config", { baseVersion: 1, force: true, expectVersion: 4, data: inline(501) });
  assert.equal(rejected.status, 413); assert.deepEqual(fs.readFileSync(configPath(f.dataDir)), before);
  assert.deepEqual(mediaTree(f.dataDir), beforeMedia); assert.deepEqual((await f.c.get("/api/config/backups")).json, withRestore);
});
