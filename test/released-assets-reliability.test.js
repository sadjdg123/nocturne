"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { RELEASES, generate, writeManifest } = require("../tools/gen-released-assets");
const { changedURLs, collectRefs } = require("./asset-refs");
const ROOT = path.join(__dirname, "..");
const fixture = JSON.parse(fs.readFileSync(process.env.RELEASED_ASSETS_BASELINE || path.join(__dirname, "fixtures/released-assets.json")));
const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
const blobs = new Map();
async function getBlob(sha) {
  if (!blobs.has(sha)) blobs.set(sha, git("cat-file", "blob", sha));
  return blobs.get(sha);
}
async function getTree(url) {
  const sha = url.match(/trees\/([a-f0-9]{40})/)[1];
  return { tree: git("ls-tree", "-r", sha, "public").toString().trim().split("\n").map((line) => {
    const [mode, type, hash, p] = line.split(/[\t ]/); return { mode, type, sha: hash, path: p };
  }) };
}
test("RC.4 必须以完整提交和发布镜像列入缓存基线", () => {
  const rc = fixture.releases.find((r) => r.name === "RC.4");
  assert.ok(rc, "原清单遗漏 RC.4");
  assert.equal(rc.commit, "f51662961ba7a86782cb863104917d75fb587553");
  assert.equal(rc.image, "ghcr.io/sadjdg123/nocturne:sha-f516629");
});
test("离线 git 内容与六个远程发布基线逐字节相符", async () => {
  assert.deepEqual(await generate(getTree, getBlob), fixture);
  assert.equal(RELEASES.length, 6);
});
for (const release of ["RC.1", "RC.2", "RC.3", "RC.4", "RC.5"]) {
  test(release + " 内容变更但固定 URL 未变时缓存回归必须报警", async () => {
    const rel = fixture.releases.find((r) => r.name === release);
    assert.ok(rel);
    const read = (p) => { try { return git("show", rel.commit + ":public/" + p); } catch (_) { return null; } };
    const url = Object.keys(rel.assets).find((u) => u.startsWith("nocturne.js?v="));
    assert.deepEqual(changedURLs(read, rel), []);
    assert.ok(changedURLs((p) => p === "nocturne.js" ? Buffer.concat([read(p), Buffer.from("\n/* injected change */")]) : read(p), rel).includes(url));
    const forged = structuredClone(rel); forged.assets[url].sha256 = "0".repeat(64);
    assert.ok(changedURLs(read, forged).includes(url), "伪造 hash 不得掩盖内容差异");
    const newURL = url + "-regression";
    const updated = (p) => p === "index.html" ? Buffer.from(read(p).toString().replaceAll(url, newURL)) :
      p === "nocturne.js" ? Buffer.concat([read(p), Buffer.from("\n/* injected change */")]) : read(p);
    assert.ok(collectRefs(updated).has(newURL));
    assert.deepEqual(changedURLs(updated, rel), [], "变更内容且更新版本 URL 应通过");
  });
}
for (const failure of ["network", "401", "truncated", "blob"]) {
  test("生成阶段 " + failure + " 失败保留旧基线", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-assets-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "released-assets.json"); fs.writeFileSync(file, "original");
    const tree = failure === "truncated" ? async () => ({ truncated: true }) :
      ["network", "401"].includes(failure) ? async () => { throw new Error(failure); } : getTree;
    await assert.rejects(async () => writeManifest(file, JSON.stringify(await generate(tree, failure === "blob" ? async () => Buffer.from("corrupt") : getBlob))));
    assert.equal(fs.readFileSync(file, "utf8"), "original");
    assert.deepEqual(fs.readdirSync(dir), ["released-assets.json"]);
  });
}
for (const operation of ["openSync", "writeFileSync", "fsyncSync", "renameSync"]) {
  test("清单 " + operation + " 故障不得截断原文件", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-assets-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "released-assets.json"); fs.writeFileSync(file, "original");
    const io = { ...fs, [operation](...args) {
      if (operation === "writeFileSync") fs.writeSync(args[0], "partial");
      throw Object.assign(new Error("injected " + operation), { code: "EIO" });
    } };
    assert.throws(() => writeManifest(file, "replacement", io), /injected/);
    assert.equal(fs.readFileSync(file, "utf8"), "original");
    assert.deepEqual(fs.readdirSync(dir), ["released-assets.json"]);
  });
}
