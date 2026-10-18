"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { seedAccount, startServer } = require("./helpers");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("pre-v2 snapshot preserves tmp-named directories and ordinary files with an exact manifest", async (t) => {
  const expected = new Map([
    ["config/bob.tmp.json", Buffer.from(JSON.stringify({ version: 1, data: { settings: {}, groups: [] } }))],
    ["config/ordinary.tmp", Buffer.from("legacy metadata")],
    ["icons/bob.tmp/abcdefghijklmnop.png", PNG],
    ["icons/bob.tmp/ordinary.tmp", Buffer.from("account metadata")],
    ["icons/bob.tmp/nested.123.abcdef12.tmp/qrstuvwxyzABCDEF.png", PNG],
    ["icons/foo.123.abcdef12.tmp/abcdefghijklmnop.png", PNG],
    ["icons/plain/abcdefghijklmnop.png", PNG],
    ["wallpapers/bob.tmp.png", PNG],
  ]);
  const excluded = [
    "config/bob.tmp.json.12345.cafebabe.tmp",
    "icons/bob.tmp/abcdefghijklmnop.png.12345.deadbeef.tmp",
    "icons/plain/abcdefghijklmnop.png.12345.deadbeef.tmp",
    "wallpapers/bob.tmp.png.12345.cafebabe.tmp",
  ];
  const srv = await startServer({ seed(dir) {
    seedAccount(dir, "bob.tmp");
    expected.set("users.json", fs.readFileSync(path.join(dir, "users.json")));
    for (const [rel, bytes] of expected) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    for (const rel of excluded) fs.writeFileSync(path.join(dir, rel), "incomplete atomic write");
  } });
  t.after(() => srv.stop());

  const names = fs.readdirSync(srv.dataDir).filter(name => name.startsWith("pre-v2-snapshot-") && !name.endsWith(".tmp"));
  assert.equal(names.length, 1, "legacy startup creates one completed upgrade snapshot");
  const snapshotDir = path.join(srv.dataDir, names[0]);
  const copied = fs.readdirSync(snapshotDir, { recursive: true })
    .filter(rel => rel !== "MANIFEST.json" && fs.statSync(path.join(snapshotDir, rel)).isFile())
    .map(rel => rel.split(path.sep).join("/")).sort();
  assert.deepEqual(copied, [...expected.keys()].sort(), "snapshot contains every original file except recognized atomic temporary files");

  const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, "MANIFEST.json"), "utf8"));
  assert.deepEqual(manifest.files.map(file => file.path).sort(), copied, "manifest covers exactly the copied files");
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(snapshotDir, file.path));
    assert.deepEqual(bytes, expected.get(file.path), "snapshot retains exact original bytes for " + file.path);
    assert.equal(file.bytes, bytes.length, "manifest byte count for " + file.path);
    assert.equal(file.sha256, crypto.createHash("sha256").update(bytes).digest("hex"), "manifest hash for " + file.path);
  }
});
