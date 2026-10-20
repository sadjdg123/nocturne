"use strict";
/* V2.2.0 · 首页瘦身 + 长期缓存 + CSP：
 *  1. index.html 只剩骨架 + 首帧前必须执行的两段内联脚本（data-ui、后端启动），没有内联 <style>；脚本 / 样式拆成 app.js、app-ui.js、app.css、app-ui.css
 *  2. 这四个文件的 ?v= 必须等于内容 sha256 前 10 位（改了内容就必须换 URL，否则 immutable 缓存会一直用旧文件）
 *  3. 首页响应带 CSP：script-src 只有 'self' + 内联脚本的 sha256（不含 'unsafe-inline'），hash 与实际下发的内联脚本一致；启动数据是不执行的 JSON 数据块
 *  4. 页面里不再有内联事件处理器（on*=），图标加载失败改由 document 捕获阶段统一处理；jsdom 真实运行页面（含设置 / 编辑 / 命令面板 / 添加）后 DOM 里也没有 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { seedAccount, startServer, client } = require("./helpers");
const { openPage, SKIP, sleep } = require("./browser");

const PUB = path.join(__dirname, "..", "public");
const HTML = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
const SPLIT = ["app.css", "app-ui.css", "app.js", "app-ui.js"];
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
const inlineScripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const hash = (s) => "'sha256-" + crypto.createHash("sha256").update(s, "utf8").digest("base64") + "'";

test("index.html is a small shell: no inline <style>, only the two pre-paint inline scripts, split files referenced in order", () => {
  assert.ok(Buffer.byteLength(HTML) < 10 * 1024, "index.html " + Buffer.byteLength(HTML) + " bytes (was ~240KB before V2.2.0)");
  assert.ok(zlib.gzipSync(HTML, { level: 6 }).length < 4 * 1024, "gzipped index.html stays a few KB (was ~67KB)");
  assert.doesNotMatch(HTML, /<style[\s>]/, "no inline <style> blocks");
  const inl = inlineScripts(HTML);
  assert.equal(inl.length, 2, "data-ui + backend boot only");
  assert.match(inl[0], /localStorage\.getItem\("nocturne\.ui"\)/);
  assert.match(inl[1], /getElementById\("nocturne-boot"\)/);
  assert.ok(inl.every((s) => s.length < 3000), "inline scripts stay tiny");
  const order = ["fonts/fonts.css", "app.css", "midnight.css", "app-ui.css", "config-shape.js", "app.js", "nocturne.js", "app-ui.js", "midnight.js"].map((f) => HTML.indexOf('"' + f + "?") >= 0 ? HTML.indexOf('"' + f + "?") : HTML.indexOf('"' + f + '"'));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), "cascade / execution order preserved: " + order);
});

test("split files: ?v= is the content sha256 (first 10 hex) — content change ⇒ new immutable URL", () => {
  for (const f of SPLIT) {
    const m = HTML.match(new RegExp('"' + f.replace(".", "\\.") + '\\?v=([0-9a-f]+)"'));
    assert.ok(m, f + " referenced with ?v=");
    const want = crypto.createHash("sha256").update(fs.readFileSync(path.join(PUB, f))).digest("hex").slice(0, 10);
    assert.equal(m[1], want, f + " changed: set ?v=" + want + " in index.html");
  }
});

test("no inline event handlers anywhere in the page sources (CSP blocks them)", () => {
  for (const f of fs.readdirSync(PUB).filter((x) => /\.(html|js)$/.test(x) && x !== "Sortable.min.js")) {
    const src = fs.readFileSync(path.join(PUB, f), "utf8");
    assert.doesNotMatch(src, /\son[a-z]+\s*=\s*\\?["']/i, f + " has an inline on*= handler");
    assert.doesNotMatch(src, /href=\\?["']javascript:/i, f + " has a javascript: link");
  }
});

async function backend(t) {
  const srv = await startServer({ seed: (dir) => {
    seedAccount(dir);
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "admin.json"), JSON.stringify({ version: 3, updatedAt: "Thu 2026-10-01 8:00 AM CST (UTC+08:00)", data: structuredClone(FIX) }));
  } });
  t.after(() => srv.stop());
  const c = client(srv.base);
  assert.equal((await c.post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 200);
  return { srv, c };
}

test("served page: CSP header (no 'unsafe-inline' scripts, hashes match the served inline scripts), boot data as a JSON block", async (t) => {
  const { srv, c } = await backend(t);
  for (const who of [client(srv.base), c]) {
    const r = await who.get("/"), html = r.body.toString("utf8"), csp = r.headers.get("content-security-policy");
    assert.ok(csp, "CSP header present");
    const dir = Object.fromEntries(csp.split(/;\s*/).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));
    assert.deepEqual(dir["default-src"], ["'self'"]);
    assert.ok(!dir["script-src"].includes("'unsafe-inline'") && !dir["script-src"].some((x) => /unsafe-eval|\*|https?:/.test(x)), "script-src: " + dir["script-src"]);
    assert.deepEqual(dir["script-src"].filter((x) => x.startsWith("'sha256-")).sort(), inlineScripts(html).map(hash).sort(), "every executable inline script is hash-allowed, nothing more");
    for (const [k, v] of [["object-src", "'none'"], ["base-uri", "'none'"], ["frame-ancestors", "'none'"]]) assert.deepEqual(dir[k], [v], k);
    assert.ok(dir["img-src"].includes("'self'") && dir["img-src"].includes("https:"), "icons may be any https URL (static mode uses api.iconify.design)");
    assert.equal(r.headers.get("cache-control"), "no-store");
    const m = html.match(/<script type="application\/json" id="nocturne-boot">([^<]*)<\/script>/);
    assert.ok(m, "boot data block");
    const boot = JSON.parse(m[1]);
    assert.equal(boot.backend, true);
    assert.equal(boot.user ? boot.user.name : null, who === c ? "admin" : null);
    assert.doesNotMatch(html, /window\.NOCTURNE=/, "no executable injected boot script");
  }
  // JSON 块里的 < 一律转义（数据里出现 </script> 也不会提前结束数据块）
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /'<script type="application\/json" id="nocturne-boot">' \+ JSON\.stringify\(boot\)\.replace\(\/<\/g, "\\\\u003c"\)/);
});

test("jsdom (backend): page runs with the boot block; no on*= attributes or unlisted inline scripts after opening settings / edit / palette / add; icon error → letter fallback", { skip: SKIP, timeout: 90000 }, async (t) => {
  const { srv, c } = await backend(t);
  const r = await c.get("/"), csp = r.headers.get("content-security-policy");
  const p = await openPage(srv.base, c, {});
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  await p.idle(600);
  assert.deepEqual(p.errors, []);
  assert.equal(win.NOCTURNE.user.name, "admin", "window.NOCTURNE read from the JSON block");
  assert.ok(doc.querySelectorAll("#x-groups [data-id]").length >= 8, "groups rendered from the server config");
  const imgs = [...doc.querySelectorAll("#x-groups img[data-l]")];
  assert.ok(imgs.length >= 1, "iconify / image icons rendered as <img data-l>");
  const scan = (where) => {
    for (const el of doc.querySelectorAll("*")) for (const a of el.getAttributeNames()) assert.ok(!/^on/i.test(a), where + ": <" + el.localName + " " + a + "> inline handler");
    for (const s of doc.querySelectorAll("script")) {
      if (s.src) assert.ok(new URL(s.src).origin === new URL(srv.base).origin, "script from self: " + s.src);
      else if (s.type !== "application/json") assert.ok(csp.includes(hash(s.textContent)), where + ": inline script not allowed by CSP");
    }
  };
  scan("home");
  A.emit("settings", {}); await sleep(80); scan("settings");
  A.emit("settings", {}); await sleep(30);
  A.emit("edit", {}); await sleep(50); scan("edit");
  A.emit("add-item", { gid: A.state.groups[0].id }); await sleep(80); scan("add sheet");
  doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(30);
  A.palette.open(""); await sleep(50); scan("palette");
  // 图标加载失败：error 事件不冒泡，靠 document 捕获阶段监听换成字母徽记
  const img = doc.querySelector("#x-groups img[data-l]"), letter = img.getAttribute("data-l"), parent = img.parentNode;
  img.dispatchEvent(new win.Event("error"));
  assert.ok(!img.isConnected, "failed <img> removed");
  assert.equal(parent.querySelector(".x-fb").textContent, letter);
  assert.deepEqual(p.errors, []);
});
