"use strict";
/* V2.0 RC · 部署后更新能不能到达浏览器：
 *  1. index.html 引用的每个本地脚本 / 样式：内容和 V1.1（main@3e6da3c，按 blob SHA）不同 → ?v= 也必须不同（否则升级后浏览器最多一天还在用 V1.1 的缓存文件）
 *  2. 对每个已发布版本（V1.1 / RC.1 / RC.2 / RC.3 / RC.4 / RC.5 / V2.0.0 / V2.1.0，清单 test/fixtures/released-assets.json，由 tools/gen-released-assets.js 从远程提交生成）：
 *     浏览器会按固定 URL 缓存的每个本地静态文件（index.html 的 src / href / url()、css 里的 url()、manifest 图标），
 *     现在的 URL（路径 + ?v=）若和该版本用过的相同，内容必须逐字节相同；内容变了就必须换 ?v=。清单不依赖 git，CI 有完整历史时再按提交核对清单本身。
 *  3. 缓存头：index.html no-store；字体文件 immutable；fonts.css 与其他静态文件 1 天后重新校验 + ETag / 304 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startServer, client } = require("./helpers");
const { collectRefs, sha256, gitBlob, changedURLs } = require("./asset-refs");

const ROOT = path.join(__dirname, "..");
const V11_INDEX = "cbc42170a30b33c6a4f20c3afb0dc2ab0160ddbe";
const V11_ASSETS = { // V1.1 时这些文件的 blob（git ls-tree main@3e6da3c public）
  "Sortable.min.js": "95423a64911d06109c228d8cc8f9c69d23beebee", "urlcheck.js": "3881cfd472158cbf41d63389188cb4c224470533",
  "netmode.js": "8796f9d9b7eca5fd7d47ca08f6bbf48ed2f453d7", "cmdrank.js": "c68134e9be337e3679c97fb9a9ccd26e0736a3d7",
  "nocturne.js": "7944742de2ee6a1c856b334c6231abd5bd22c691", "fonts/fonts.css": "74c1b13c2228d56b0e47282f10961ea0ae45d64f",
};
const blob = (buf) => crypto.createHash("sha1").update("blob " + buf.length + "\0").update(buf).digest("hex");
function refs(html) {
  const out = new Map();
  for (const m of html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="stylesheet"[^>]*\shref)="([^"]+)"/g)) {
    const [p, q] = m[1].split("?");
    if (!/^[\w./-]+$/.test(p) || /^https?:/.test(m[1])) continue;
    out.set(p, q || "");
  }
  return out;
}
let oldIndex = null;
try { oldIndex = execFileSync("git", ["-C", ROOT, "cat-file", "blob", V11_INDEX], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8"); } catch (e) {
  if (process.env.CI) throw new Error("取不到 V1.1 index.html（需要 fetch-depth: 0）");
}

test("every asset whose content changed since V1.1 has a new ?v= in index.html", { skip: oldIndex ? false : "没有 V1.1 基线 blob" }, () => {
  const now = refs(fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8")), old = refs(oldIndex);
  let checked = 0;
  for (const [p, q] of now) {
    const f = path.join(ROOT, "public", p);
    assert.ok(fs.existsSync(f), "referenced file exists: " + p);
    if (!old.has(p)) continue; // V2 新增的文件：V1.1 的浏览器缓存里不会有
    const changed = V11_ASSETS[p] ? blob(fs.readFileSync(f)) !== V11_ASSETS[p] : true;
    if (changed) assert.notEqual(q, old.get(p), p + " changed since V1.1 but its ?v= did not (" + q + ")");
    checked++;
  }
  assert.ok(checked >= 6, "compared " + checked + " assets");
  assert.ok(Object.keys(V11_ASSETS).every((p) => old.has(p)), "V1.1 table matches V1.1 index.html");
});

const MANIFEST = require("./fixtures/released-assets.json");
const PUB = path.join(ROOT, "public");
const readPub = (p) => { const f = path.join(PUB, p); return fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f) : null; };
function git(args) { try { return execFileSync("git", ["-C", ROOT, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }); } catch (e) { return null; } }

test("released-assets manifest covers every released version", () => {
  assert.deepEqual(MANIFEST.releases.map((r) => r.name), ["V1.1", "RC.1", "RC.2", "RC.3", "RC.4", "RC.5", "V2.0.0", "V2.1.0"]);
  const commits = { "V1.1": "3e6da3c", "RC.1": "2ee0983", "RC.2": "3d5beaf", "RC.3": "e4de70b", "RC.4": "f516629", "RC.5": "c5f36ad", "V2.0.0": "93d9bec", "V2.1.0": "1bb4b20" };
  for (const r of MANIFEST.releases) {
    assert.ok(r.commit.startsWith(commits[r.name]), r.name + " commit");
    assert.ok(r.image.endsWith(":sha-" + commits[r.name]), r.name + " image");
    assert.ok(Object.keys(r.assets).some((u) => u.startsWith("nocturne.js?v=")), r.name + " has nocturne.js");
    assert.ok(Object.keys(r.assets).length >= 20, r.name + " URL count");
  }
});

for (const rel of MANIFEST.releases) {
  test("same URL as " + rel.name + " (" + rel.commit.slice(0, 7) + ") ⇒ same content (changed asset needs a new ?v=)", () => {
    const now = collectRefs(readPub);
    assert.ok(now.size >= 20, "found " + now.size + " cacheable URLs in index.html / css / manifest");
    const stale = changedURLs(readPub, rel);
    let shared = 0;
    for (const [url, ref] of now) {
      const old = rel.assets[url];
      if (!old) continue;
      shared++;
    }
    assert.deepEqual(stale, [], "content changed since " + rel.name + " but URL unchanged (browser may serve the cached " + rel.name + " file for up to 86400s): " + stale.join(", "));
    assert.ok(shared >= 10, "compared " + shared + " URLs with " + rel.name);
  });
}

test("manifest matches the released commits (git objects; required in CI with fetch-depth: 0)", (t) => {
  let commitsSeen = 0, blobsSeen = 0;
  for (const rel of MANIFEST.releases) {
    for (const [url, a] of Object.entries(rel.assets)) {
      const buf = git(["cat-file", "blob", a.blob]);
      if (buf) { blobsSeen++; assert.equal(gitBlob(buf), a.blob); assert.equal(sha256(buf), a.sha256, rel.name + " " + url + " sha256"); }
    }
    const idx = git(["rev-parse", rel.commit + ":public/index.html"]);
    if (!idx) continue;
    commitsSeen++;
    assert.equal(idx.toString().trim(), rel.indexBlob, rel.name + " index.html blob");
    for (const [url, a] of Object.entries(rel.assets)) {
      assert.equal(git(["rev-parse", rel.commit + ":public/" + a.path]).toString().trim(), a.blob, rel.name + " " + url + " blob");
    }
  }
  if (process.env.CI) assert.equal(commitsSeen, MANIFEST.releases.length, "CI must have every released commit (fetch-depth: 0)");
  if (!commitsSeen) t.diagnostic("released commits not in local git (remote commit SHAs differ from local); checked " + blobsSeen + " blobs only");
});

test("cache headers: index no-store; woff2 immutable; fonts.css and scripts revalidate with ETag / 304", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = client(srv.base);
  const idx = await c.get("/");
  assert.equal(idx.headers.get("cache-control"), "no-store");
  const font = fs.readdirSync(path.join(ROOT, "public", "fonts")).find((f) => f.endsWith(".woff2"));
  assert.match((await c.get("/fonts/" + font)).headers.get("cache-control"), /immutable/);
  const css = await c.get("/fonts/fonts.css");
  assert.equal(css.headers.get("cache-control"), "public, max-age=86400, must-revalidate", "fonts.css is not pinned for a year");
  const jsUrl = "/" + idx.body.toString("utf8").match(/<script src="(nocturne\.js\?v=\d+)"/)[1];
  const js = await c.get(jsUrl);
  assert.equal(js.headers.get("cache-control"), "public, max-age=86400, must-revalidate");
  const etag = js.headers.get("etag"); assert.ok(etag);
  assert.equal((await c.get(jsUrl, { "If-None-Match": etag })).status, 304);
});
