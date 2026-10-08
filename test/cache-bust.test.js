"use strict";
/* V2.0 RC · 部署后更新能不能到达浏览器：
 *  1. index.html 引用的每个本地脚本 / 样式：内容和 V1.1（main@3e6da3c，按 blob SHA）不同 → ?v= 也必须不同（否则升级后浏览器最多一天还在用 V1.1 的缓存文件）
 *  2. 缓存头：index.html no-store；字体文件 immutable；fonts.css 与其他静态文件 1 天后重新校验 + ETag / 304 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startServer, client } = require("./helpers");

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
  const js = await c.get("/nocturne.js?v=8");
  assert.equal(js.headers.get("cache-control"), "public, max-age=86400, must-revalidate");
  const etag = js.headers.get("etag"); assert.ok(etag);
  assert.equal((await c.get("/nocturne.js?v=8", { "If-None-Match": etag })).status, 304);
  assert.match(idx.body.toString("utf8"), /nocturne\.js\?v=8/);
});
