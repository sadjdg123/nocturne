"use strict";
/* 图标代理缓存：命中 / 去重、上游异常、超长 / 非法查询、容量淘汰、不碰 data/icons */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, client, mockServer, waitFor } = require("./helpers");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("icon proxy cache", async (t) => {
  let upstreamDown = false;
  const up = await mockServer((q, s) => {
    if (upstreamDown) { s.socket.destroy(); return; }
    if (q.url.startsWith("/huge/")) { s.writeHead(200, { "Content-Type": "image/svg+xml" }); return s.end(Buffer.alloc(300 * 1024, 32)); }
    if (q.url.startsWith("/html/")) { s.writeHead(200, { "Content-Type": "text/html" }); return s.end("<script>x</script>"); }
    if (q.url.startsWith("/err/")) { s.writeHead(500); return s.end(); }
    if (q.url.startsWith("/missing/")) { s.writeHead(404); return s.end("nf"); }
    if (q.url.startsWith("/slow/")) { setTimeout(() => { s.writeHead(200, { "Content-Type": "image/svg+xml" }); s.end("<svg/>"); }, 300); return; }
    if (q.url.startsWith("/search")) { s.writeHead(200, { "Content-Type": "application/json" }); return s.end(JSON.stringify({ icons: ["mdi:home"], echo: q.url })); }
    s.writeHead(200, { "Content-Type": "image/svg+xml" }); s.end("<svg xmlns='http://www.w3.org/2000/svg'>" + "x".repeat(1000) + "</svg>");
  });
  const srv = await startServer({ env: { ICON_UPSTREAM: "http://127.0.0.1:" + up.port + "/", CACHE_MAX_FILES: "20", CACHE_MAX_MB: "1" } });
  t.after(async () => { await srv.stop(); await up.close(); });
  const c = client(srv.base);
  await c.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  const icon = await c.req("POST", "/api/icons", PNG, { "Content-Type": "image/png" });
  assert.equal(icon.status, 200);

  let r = await c.get("/api/icon/selfhst/emby.svg");
  assert.equal(r.status, 200); assert.equal(r.headers.get("x-cache"), "MISS"); assert.match(r.headers.get("content-type"), /image\/svg\+xml/);
  r = await c.get("/api/icon/selfhst/emby.svg");
  assert.equal(r.headers.get("x-cache"), "HIT");
  assert.equal((await c.get("/api/icon/selfhst/emby.svg?color=red&x=1")).headers.get("x-cache"), "HIT", "query strings on SVGs ignored (no cache explosion)");

  const hits0 = up.hits.length;
  const rs = await Promise.all(Array.from({ length: 6 }, () => c.get("/api/icon/slow/same.svg")));
  assert.ok(rs.every((x) => x.status === 200));
  assert.equal(up.hits.length - hits0, 1, "concurrent misses deduplicated");

  assert.equal((await c.get("/api/icon/search?query=emby&limit=48&prefixes=selfhst,mdi")).status, 200);
  assert.equal((await c.get("/api/icon/search?query=emby&evil=1")).status, 400);
  assert.equal((await c.get("/api/icon/search?query=" + "a".repeat(500))).status, 400);
  assert.equal((await c.get("/api/icon/" + "a".repeat(300) + "/x.svg")).status, 400);
  assert.equal((await c.get("/api/icon/a/b/c.svg")).status, 400);
  assert.equal((await c.get("/api/icon/huge/x.svg")).status, 502, "oversize upstream response refused");
  assert.equal((await c.get("/api/icon/html/x.svg")).status, 502, "unexpected content-type refused");
  assert.equal((await c.get("/api/icon/err/x.svg")).status, 502);
  assert.equal((await c.get("/api/icon/missing/x.svg")).status, 404);

  upstreamDown = true;
  assert.equal((await c.get("/api/icon/selfhst/emby.svg")).status, 200, "cached icon still served while upstream is down");
  assert.equal((await c.get("/api/icon/selfhst/never-seen.svg")).status, 502);
  upstreamDown = false;

  for (let i = 0; i < 40; i++) assert.equal((await c.get("/api/icon/mdi/i" + i + ".svg")).status, 200);
  const cacheDir = path.join(srv.dataDir, "cache");
  const n = await waitFor(() => { const k = fs.readdirSync(cacheDir).length; return k <= 20 ? k : 0; }, 12000, 250);
  assert.ok(n > 0 && n <= 20, "cache trimmed to CACHE_MAX_FILES, now " + fs.readdirSync(cacheDir).length);
  const iconsDir = path.join(srv.dataDir, "icons", "admin");
  assert.equal(fs.readdirSync(iconsDir).filter((f) => /\.png$/.test(f)).length, 1, "uploaded icons untouched by cache cleanup");
  assert.equal((await c.get("/" + icon.json.url)).status, 200);
});
