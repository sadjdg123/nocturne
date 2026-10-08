"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("../public/urlcheck.js");

const EVIL_NAV = [
  "javascript:alert(1)", "JavaScript:alert(1)", "JAVASCRIPT:alert(1)", " javascript:alert(1)", "\tjavascript:alert(1)",
  "java\tscript:alert(1)", "java\nscript:alert(1)", "\u0001javascript:alert(1)", "\u200bjavascript:alert(1)", "\ufeffjavascript:alert(1)",
  "javascript://%0aalert(1)", "data:text/html,<script>alert(1)</script>", "DATA:text/html;base64,PHNjcmlwdD4=", "data:image/png;base64,iVBORw0KGgo=",
  "file:///etc/passwd", "FILE://C:/x", "vbscript:msgbox(1)", "VBScript:msgbox(1)", "blob:https://example.com/0f0f", "BLOB:http://x/1",
  "http:alert(1)", "https:/example.com", "http://", "https://", "//evil.example.com", "\thttp://example.com", "http://example.com\n",
  "http://exa\tmple.com", "http://exa\u0000mple.com", "http://example.com ", " http://example.com", "http://a\u200b.com", "ftp://example.com",
  "about:blank", "chrome://settings", "mailto:a@b.c", "x".repeat(10) + "javascript:alert(1)", 42, {}, [],
];
const GOOD_NAV = [
  "https://example.com", "HTTPS://EXAMPLE.COM/", "http://192.168.1.20:8096", "http://192.168.1.20:8096/web/index.html#!/home",
  "http://nas.local:5000", "http://nas.lan/", "https://emby.example.com", "http://localhost:3000", "https://[fd00::1]:8443/",
  "http://10.0.0.2/a?b=c&d=%20e", "http://nas/my folder",
];

test("nav: rejects dangerous schemes and obfuscated variants", () => {
  for (const u of EVIL_NAV) assert.equal(U.nav(u), false, "should reject " + JSON.stringify(u));
});
test("nav: accepts public https, LAN http, local names; empty = no address", () => {
  for (const u of GOOD_NAV) assert.equal(U.nav(u), true, "should accept " + u);
  assert.equal(U.nav(""), true);
  assert.equal(U.safeNav(""), "");
  assert.equal(U.safeNav("javascript:alert(1)"), "");
  assert.equal(U.safeNav("http://192.168.1.20:8096"), "http://192.168.1.20:8096");
});
test("engine templates need http(s) and %s", () => {
  assert.equal(U.engine("https://www.google.com/search?q=%s"), true);
  assert.equal(U.engine("http://192.168.1.5:8080/search?q=%s&x=%s"), true);
  assert.equal(U.engine("https://www.google.com/search?q="), false);
  assert.equal(U.engine("javascript:alert('%s')"), false);
  assert.equal(U.engine("data:text/html,%s"), false);
  assert.equal(U.engine(" https://g.com/?q=%s"), false);
});
test("image fields: http(s), uploaded refs, legacy data:image only", () => {
  assert.equal(U.image("https://cdn.example.com/a.png"), true);
  assert.equal(U.image("api/icons/abcdefghijklmnop1234"), true);
  assert.equal(U.image("data:image/png;base64,iVBORw0KGgo="), true);
  assert.equal(U.image("data:image/svg+xml;base64,PHN2Zz4="), true);
  assert.equal(U.image("data:text/html;base64,PHNjcmlwdD4="), false);
  assert.equal(U.image("javascript:alert(1)"), false);
  assert.equal(U.image("api/icons/../../users.json"), false);
  assert.equal(U.wallpaper("data:image/jpeg;base64,/9j/4AAQ"), true);
  assert.equal(U.wallpaper("api/icons/abcdefghijklmnop1234"), false);
  assert.equal(U.wallpaper("file:///x.jpg"), false);
});
test("checkConfig lists every unsafe field with location", () => {
  const d = {
    settings: { engines: [{ id: "e1", name: "ok", url: "https://g.com/?q=%s" }, { id: "e2", name: "bad", url: "javascript:%s" }], wallpaper: { id: "custom", url: "javascript:x" } },
    groups: [{ name: "G", items: [
      { id: "a", title: "A", lan: "http://192.168.1.2", wan: "JavaScript:alert(1)" },
      { id: "b", title: "B", lan: "", wan: "https://b.example.com", icon: { type: "image", value: "data:text/html,x" } },
      { id: "c", title: "C", url: "vbscript:x" },
    ] }],
  };
  const bad = U.checkConfig(d);
  assert.deepEqual(bad.map((x) => x.kind + ":" + (x.id || "") + ":" + x.field).sort(),
    ["engine:e2:url", "image:b:icon", "nav:a:wan", "nav:c:url", "wallpaper::wallpaper"].sort());
  assert.deepEqual(U.checkConfig({ settings: {}, groups: [{ items: [{ id: "x", title: "x", lan: "http://192.168.1.20:8096" }] }] }), []);
});
