"use strict";
/* 首页源码（按文本检查前端接线的测试用）：index.html 本身 + 它按顺序引用的每个本地脚本 / 样式表的内容。
 * V2.2.0 起内联脚本 / 样式拆到 app.js、app-ui.js、app.css、app-ui.css；只收 index.html 真正引用到的文件，
 * 所以「代码在页面里」的检查口径不变：文件没被引用，检查就会失败。 */
const fs = require("node:fs");
const path = require("node:path");

const PUB = path.join(__dirname, "..", "public");
function pageSource() {
  const html = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
  const parts = [html];
  for (const m of html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="stylesheet"[^>]*\shref)="([^"?#]+)(?:\?[^"]*)?"/g)) {
    if (/^[a-z]+:/i.test(m[1]) || m[1] === "Sortable.min.js") continue;
    parts.push(fs.readFileSync(path.join(PUB, m[1]), "utf8"));
  }
  return parts.join("\n");
}
module.exports = { pageSource, PUB };
