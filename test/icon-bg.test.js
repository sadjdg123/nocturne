"use strict";
/* 图标背景色（icon.bg）只允许颜色值：手工导入的 JSON 里塞进别的 CSS 声明（position、url()、expression()…）时，
 * iconHTML 不输出 background，避免改写 style 里的其它属性 / 发起外部请求。纯静态模式（file://）下用 jsdom 真实运行页面。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { openStatic, SKIP, ROOT } = require("./browser");

const URL_FILE = "file://" + path.join(ROOT, "public", "index.html");
const OK = ["#2A3142", "#fff", "transparent", "rgb(1, 2, 3)", "hsla(10, 20%, 30%, .5)"];
const BAD = ["red;position:fixed;inset:0", "url(https://evil.example/x)", "#fff;background-image:url(//e)", "expression(alert(1))", "rgb(1,2,3);x:y"];

test("index.html iconHTML: icon.bg accepts color values only", { skip: SKIP, timeout: 60000 }, async (t) => {
  const p = await openStatic({ url: URL_FILE });
  t.after(() => p.close());
  const html = (bg) => p.A.util.iconHTML({ type: "text", value: "A", bg }, "A");
  for (const bg of OK) assert.ok(html(bg).includes(";background:"), "allowed: " + bg);
  for (const bg of BAD) assert.ok(!html(bg).includes("background:"), "rejected: " + bg);
  assert.deepEqual(p.errors, []);
});
