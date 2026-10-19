"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { startServer, client, ROOT } = require("./helpers");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const iconId = i => "existing_" + String(i).padStart(16, "0");
async function fixture(t, count) {
  const data = { settings: { title: "retained quota fixture" }, groups: [{ id: "group", items: Array.from({ length: count }, (_, i) => ({ id: "item-" + i, icon: { type: "image", value: "api/icons/" + iconId(i) } })) }] };
  const env = { NOCTURNE_NO_AUTH: "1", NODE_OPTIONS: "--require=" + path.join(ROOT, "test/icon-quota-fault.js") };
  const server = await startServer({ env, seed(dir) {
    fs.mkdirSync(path.join(dir, "config"));
    fs.writeFileSync(path.join(dir, "config/default.json"), JSON.stringify({ version: 1, data, writer: { app: "nocturne", gen: 2 } }));
    env.ICON_QUOTA_FAULT_CTL = path.join(dir, "quota-fault.json");
    fs.writeFileSync(env.ICON_QUOTA_FAULT_CTL, "{}");
    if (count) {
      fs.mkdirSync(path.join(dir, "icons/default"), { recursive: true });
      for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, "icons/default", iconId(i) + ".png"), PNG);
    }
  } });
  t.after(() => server.stop());
  const c = client(server.base), dir = path.join(server.dataDir, "icons/default"), config = path.join(server.dataDir, "config/default.json");
  return { ...server, c, dir, config,
    arm(rule) { fs.writeFileSync(env.ICON_QUOTA_FAULT_CTL, JSON.stringify(rule)); },
    async add(kind) {
      if (kind === "upload") return c.req("POST", "/api/icons", PNG, { "Content-Type": "image/png" });
      const candidate = structuredClone(data);
      candidate.groups[0].items.push({ id: "new-inline", icon: { type: "image", value: "data:image/png;base64," + PNG.toString("base64") } });
      return c.put("/api/config", { baseVersion: 1, data: candidate });
    },
    files() { return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".png")).sort() : []; },
  };
}
for (const kind of ["inline", "upload"]) {
  for (const operation of ["readdir", "stat"]) for (const code of ["EIO", "EACCES"]) {
    test(kind + " allocation fails closed on inventory " + operation + " " + code, async t => {
      const f = await fixture(t, 500), before = fs.readFileSync(f.config), names = f.files();
      assert.equal((await f.add(kind)).status, 413, "healthy inventory enforces the exact limit");
      f.arm({ operation, code, path: operation === "readdir" ? f.dir : path.join(f.dir, iconId(0) + ".png") });
      const result = await f.add(kind);
      assert.equal(result.status, 500, "an unknown inventory must not authorize allocation");
      assert.deepEqual(fs.readFileSync(f.config), before);
      assert.deepEqual(f.files(), names);
      for (const file of names) assert.deepEqual(fs.readFileSync(path.join(f.dir, file)), PNG);
      assert.deepEqual(fs.readdirSync(f.dir).sort(), names, "no orphan ledger or temporary media was written");
      f.arm({});
      assert.equal((await f.c.get("/api/config")).json.version, 1);
      assert.equal((await f.add(kind)).status, 413, "a retry still enforces quota after the I/O fault clears");
      fs.unlinkSync(path.join(f.dir, iconId(0) + ".png"));
      assert.equal((await f.add(kind)).status, 200, "the next valid allocation works without a restart");
      assert.equal(f.files().length, 500);
      assert.equal((await f.c.get("/api/health")).json.ok, true);
    });
  }
  test(kind + " allocation tolerates a real ENOENT stat race without exceeding quota", async t => {
    const f = await fixture(t, 500);
    f.arm({ operation: "stat", code: "ENOENT", path: path.join(f.dir, iconId(0) + ".png"), remove: true });
    assert.equal((await f.add(kind)).status, 200);
    assert.equal(f.files().length, 500);
    assert.equal((await f.c.get("/api/health")).json.ok, true);
  });
  test(kind + " allocation accepts an absent icon directory (ENOENT)", async t => {
    const f = await fixture(t, 0);
    assert.equal(fs.existsSync(f.dir), false);
    assert.equal((await f.add(kind)).status, 200);
    assert.equal(f.files().length, 1);
    const response = await f.c.get("/api/icons/" + f.files()[0].slice(0, -4));
    assert.equal(response.status, 200); assert.deepEqual(response.body, PNG);
  });
}
