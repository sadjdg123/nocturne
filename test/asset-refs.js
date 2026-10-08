"use strict";
/* 缓存刷新检查用：找出浏览器会按「固定 URL」缓存的每个本地静态文件（相对 public/ 的路径 + 查询串）。
 * 来源（都是静态写死的引用，运行时动态拼的 API 地址 api/... 不算）：
 *   - index.html 里 src="…" / href="…"（脚本、样式、图标、manifest、<img>）以及 url(…)
 *   - 被引用的 .css 里的 url(…)（如 fonts/fonts.css → *.woff2，相对该 css 所在目录）
 *   - site.webmanifest 的 icons[].src
 * 只收能在 public/ 里找到的文件；外链、data:、#锚点、带 JS 拼接的字符串都跳过。
 * test/cache-bust.test.js 和 tools/gen-released-assets.js 共用这一份，保证「发布时的 URL 表」与「现在的 URL 表」口径一致。 */
const path = require("node:path");
const crypto = require("node:crypto");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const gitBlob = (buf) => crypto.createHash("sha1").update("blob " + buf.length + "\0").update(buf).digest("hex");
const LOCAL = /^[\w][\w./-]*(\?v=[\w.-]+)?$/;

function norm(baseDir, ref) {
  const [p, q] = ref.split("?");
  const full = path.posix.normalize(path.posix.join(baseDir, p));
  if (full.startsWith("..")) return null;
  return { path: full, v: q ? q.replace(/^v=/, "") : "" };
}

/** read(relPath) → Buffer | null（相对 public/）。返回 Map<"path?v=…" 或 "path", {path, v}> */
function collectRefs(read) {
  const out = new Map();
  const add = (baseDir, ref) => {
    if (!LOCAL.test(ref)) return;
    const n = norm(baseDir, ref);
    if (!n || !read(n.path)) return;
    out.set(n.v ? n.path + "?v=" + n.v : n.path, n);
  };
  const html = read("index.html");
  if (!html) throw new Error("index.html missing");
  const h = html.toString("utf8");
  for (const m of h.matchAll(/\s(?:src|href)="([^"]+)"/g)) add("", m[1]);
  for (const m of h.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) add("", m[1]);
  for (const r of [...out.values()]) {
    if (r.path.endsWith(".css")) {
      const css = read(r.path).toString("utf8");
      const dir = path.posix.dirname(r.path) === "." ? "" : path.posix.dirname(r.path);
      for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) add(dir, m[1]);
    }
    if (r.path.endsWith(".webmanifest")) {
      try { for (const ic of JSON.parse(read(r.path).toString("utf8")).icons || []) if (ic && typeof ic.src === "string") add("", ic.src); } catch (e) { /* 坏的 manifest：不收 */ }
    }
  }
  return out;
}
module.exports = { collectRefs, sha256, gitBlob };
