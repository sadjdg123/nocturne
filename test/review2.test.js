"use strict";
/* 复查第二轮：opId 与内容绑定（SHA-256）、baseVersion 必填、旧值豁免绑定到 项目 id + 字段 + 原值、
 * 上传途中账户被删、X-Forwarded-Proto 按跳数取值 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { startServer, client, cfg, sleep } = require("./helpers");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const rawConfig = (srv, name = "admin") => JSON.parse(fs.readFileSync(path.join(srv.dataDir, "config", name + ".json"), "utf8"));

/* 前端里的哈希：旧的 32 位 djb2 与新的纯 JS SHA-256（直接从 public/nocturne.js 里取出来跑） */
const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "nocturne.js"), "utf8");
const clientSha256 = new Function(SRC.slice(SRC.indexOf("var SHA_K"), SRC.indexOf("var hashMemo")) + "; return sha256;")();
const oldWeakHash = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + "." + str.length.toString(36); };
const A_RAW = JSON.stringify({ settings: { title: "ab" }, groups: [] }), B_RAW = JSON.stringify({ settings: { title: "bA" }, groups: [] });

test("client SHA-256 matches node:crypto; the reported collision pair no longer collides", () => {
  assert.equal(oldWeakHash(A_RAW), oldWeakHash(B_RAW), "old 32-bit hash really collided (" + oldWeakHash(A_RAW) + ")");
  for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "夜曲 🎬 Nocturne", A_RAW, B_RAW, "x".repeat(100000)]) {
    assert.equal(clientSha256(s), crypto.createHash("sha256").update(s, "utf8").digest("hex"));
  }
  assert.notEqual(clientSha256(A_RAW), clientSha256(B_RAW));
});

test("opId is bound to content: same opId + different data → 422 opid_mismatch, never a silent duplicate", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const a = client(srv.base);
  await a.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  const A = JSON.parse(A_RAW), B = JSON.parse(B_RAW);

  let r = await a.put("/api/config", { baseVersion: 0, opId: "op-collide-1", data: A });
  assert.equal(r.status, 200); assert.equal(r.json.version, 1);
  // 响应「丢了」：客户端仍以为在 v0，又改成了 B，旧前端会因为弱哈希相同而复用同一个 opId
  r = await a.put("/api/config", { baseVersion: 0, opId: "op-collide-1", data: B });
  assert.equal(r.status, 422, "must not be reported as synced");
  assert.equal(r.json.code, "opid_mismatch");
  assert.notEqual(r.json.duplicate, true);
  let doc = (await a.get("/api/config")).json;
  assert.equal(doc.version, 1); assert.equal(doc.data.settings.title, "ab", "nothing written");
  // 前端换新 opId 正常重推：服务器已在 v1 → 冲突（交给用户），而不是当成已同步
  r = await a.put("/api/config", { baseVersion: 0, opId: "op-collide-2", data: B });
  assert.equal(r.status, 409); assert.equal(r.json.conflict, true);
  // 同一个 opId + 同样的内容：照常识别为重复推送
  r = await a.put("/api/config", { baseVersion: 0, opId: "op-collide-1", data: A });
  assert.equal(r.status, 200); assert.equal(r.json.duplicate, true); assert.equal(r.json.version, 1);
  const ops = rawConfig(srv).ops;
  assert.match(ops.find((o) => o.id === "op-collide-1").h, /^[0-9a-f]{64}$/, "server stores sha256 of canonical data per opId");
});

test("legacy ops entries without a stored hash are verified against hist, otherwise refused", async (t) => {
  const A = JSON.parse(A_RAW), B = JSON.parse(B_RAW);
  const canon = (v) => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v);
  const hA = crypto.createHash("sha256").update(canon(A)).digest("hex");
  const srv = await startServer({ seed: (dir) => {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "admin.json"), JSON.stringify({ version: 2, updatedAt: "2026-10-01T00:00:00Z", data: A,
      hist: [{ v: 2, h: hA }], ops: [{ id: "op-legacy-0001", v: 2 }, { id: "op-legacy-0002", v: 1 }] }));
  } });
  t.after(() => srv.stop());
  const a = client(srv.base);
  await a.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  assert.equal((await a.put("/api/config", { baseVersion: 1, opId: "op-legacy-0001", data: A })).json.duplicate, true, "hash recovered from hist");
  assert.equal((await a.put("/api/config", { baseVersion: 1, opId: "op-legacy-0001", data: B })).status, 422);
  assert.equal((await a.put("/api/config", { baseVersion: 0, opId: "op-legacy-0002", data: A })).status, 422, "unverifiable legacy entry is not trusted");
  assert.equal((await a.get("/api/config")).json.version, 2);
});

test("baseVersion is required for every PUT /api/config", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const a = client(srv.base);
  await a.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  assert.equal((await a.put("/api/config", { data: cfg("no base on empty server") })).status, 400, "missing baseVersion → 400 even with no config yet");
  assert.equal((await a.put("/api/config", { baseVersion: 0, opId: "op-base-0001", data: cfg("v1") })).status, 200, "0 is fine when no config exists");
  for (const bad of [undefined, null, "1", 1.5, -1, true, [1], {}]) {
    const body = { opId: "op-base-x" + String(Math.random()).slice(2, 10), data: cfg("hijack") };
    if (bad !== undefined) body.baseVersion = bad;
    const r = await a.put("/api/config", body);
    assert.equal(r.status, 400, "baseVersion " + JSON.stringify(bad) + " must be rejected");
    assert.equal(r.json.code, "bad_base_version");
  }
  // force / restore / replay without baseVersion also refused
  assert.equal((await a.put("/api/config", { force: true, expectVersion: 1, data: cfg("forced") })).status, 400);
  assert.equal((await a.put("/api/config", { restore: true, data: cfg("restored") })).status, 400);
  const doc = (await a.get("/api/config")).json;
  assert.equal(doc.version, 1); assert.equal(doc.data.settings.title, "v1", "data / version unchanged");
  assert.equal((await a.put("/api/config", { baseVersion: 0, opId: "op-base-0002", data: cfg("stale") })).status, 409, "0 is a mismatch once a config exists");
  assert.equal((await a.put("/api/config", { baseVersion: 1, opId: "op-base-0003", data: cfg("v2") })).json.version, 2);
});

test("legacy unsafe-URL exemption is bound to item id + field + exact original value", async (t) => {
  const BAD = "javascript:alert(1)";
  const srv = await startServer({ seed: (dir) => {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "admin.json"), JSON.stringify({ version: 3, updatedAt: "2026-01-01T00:00:00Z", data: cfg("旧配置", [
      { id: "itemA", title: "A", lan: BAD, wan: "" },
      { id: "itemC", title: "C", lan: "http://192.168.1.3", wan: "" },
    ]) }));
  } });
  t.after(() => srv.stop());
  const a = client(srv.base);
  await a.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  let cur = (await a.get("/api/config")).json;
  const put = (d) => a.put("/api/config", { baseVersion: cur.version, data: d });

  let d = structuredClone(cur.data); d.groups[0].items[0].title = "A 改名";
  let r = await put(d);
  assert.equal(r.status, 200, "old item A keeps its own value");
  cur = (await a.get("/api/config")).json;

  d = structuredClone(cur.data); d.groups[0].items.push({ id: "itemB", title: "B", lan: BAD, wan: "" });
  r = await put(d);
  assert.equal(r.status, 400, "new item B copying A's value → 400");
  assert.equal(r.json.invalid[0].id, "itemB");

  d = structuredClone(cur.data); d.groups[0].items[0].lan = ""; d.groups[0].items[0].wan = BAD;
  assert.equal((await put(d)).status, 400, "A's value moved to A's other field → 400");

  d = structuredClone(cur.data); d.groups[0].items[1].wan = BAD;
  assert.equal((await put(d)).status, 400, "existing item C copying the value → 400");

  d = structuredClone(cur.data); d.groups[0].items.push({ title: "no id", lan: BAD });
  assert.equal((await put(d)).status, 400, "items without an id never get the exemption");

  d = structuredClone(cur.data); d.groups[0].items[0].lan = BAD + "x";
  assert.equal((await put(d)).status, 400, "only the exact original value");

  // backups count only for the same item id: clear A, then put the old value back on A (e.g. restore) → OK, on B → 400
  d = structuredClone(cur.data); d.groups[0].items[0].lan = "http://192.168.1.2";
  assert.equal((await put(d)).status, 200);
  cur = (await a.get("/api/config")).json;
  assert.ok((await a.get("/api/config/backups")).json.length >= 1, "legacy version is in a backup");
  d = structuredClone(cur.data); d.groups[0].items.push({ id: "itemB", title: "B", lan: BAD });
  assert.equal((await put(d)).status, 400);
  d = structuredClone(cur.data); d.groups[0].items[0].lan = BAD;
  assert.equal((await put(d)).status, 200, "A's own old value from a backup is still accepted");
});

/** 慢速上传：先发请求头和一半请求体，回调里做别的事，再发剩下的 */
function slowUpload(base, method, p, cookie, type, buf, between) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers: { Cookie: cookie, "Content-Type": type, "Content-Length": buf.length } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { /* */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", reject);
    req.write(buf.subarray(0, 20));
    sleep(150).then(between).then(() => sleep(100)).then(() => req.end(buf.subarray(20)), reject);
  });
}

test("wallpaper / icon upload finishing after the account was deleted writes nothing", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const admin = client(srv.base);
  await admin.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  const cookieOf = (c) => [...c.jar].map(([k, v]) => k + "=" + v).join("; ");
  const big = Buffer.concat([PNG, Buffer.alloc(4096)]);

  for (const kind of ["wallpaper", "icon-post", "icon-put"]) {
    const name = "bob" + kind.replace(/\W/g, "");
    assert.equal((await admin.post("/api/users", { name, password: "bob-pass-12" })).status, 200);
    const bob = client(srv.base);
    assert.equal((await bob.post("/api/login", { name, password: "bob-pass-12" })).status, 200);
    const [method, p] = kind === "wallpaper" ? ["PUT", "/api/wallpaper"] : kind === "icon-post" ? ["POST", "/api/icons"] : ["PUT", "/api/icons/abcdefghijklmnop1234"];
    const r = await slowUpload(srv.base, method, p, cookieOf(bob), "image/png", big, async () => {
      assert.equal((await admin.del("/api/users/" + name)).status, 200);
    });
    assert.equal(r.status, 401, kind + ": upload after account deletion must fail, got " + r.status);
    const wp = fs.readdirSync(path.join(srv.dataDir, "wallpapers"));
    assert.deepEqual(wp.filter((f) => f.startsWith(name.toLowerCase())), [], kind + ": no wallpaper file / temp file left");
    assert.equal(fs.existsSync(path.join(srv.dataDir, "icons", name.toLowerCase())), false, kind + ": no icon dir recreated");
  }
  // a still-valid account uploads fine
  assert.equal((await admin.req("PUT", "/api/wallpaper", PNG, { "Content-Type": "image/png" })).status, 200);
});

test("upload after the session was revoked (password changed elsewhere) is refused", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const d1 = client(srv.base), d2 = client(srv.base);
  await d1.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  await d2.post("/api/login", { name: "admin", password: "admin-pass-1" });
  const cookie = [...d2.jar].map(([k, v]) => k + "=" + v).join("; ");
  const r = await slowUpload(srv.base, "POST", "/api/icons", cookie, "image/png", Buffer.concat([PNG, Buffer.alloc(2048)]), async () => {
    assert.equal((await d1.post("/api/password", { old: "admin-pass-1", password: "admin-pass-2" })).status, 200);
  });
  assert.equal(r.status, 401);
  assert.equal(fs.existsSync(path.join(srv.dataDir, "icons", "admin")) && fs.readdirSync(path.join(srv.dataDir, "icons", "admin")).some((f) => /\.png$/.test(f)), false);
});

/* ---- X-Forwarded-Proto ---- */
function rawGet(base, p, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    http.get({ host: u.hostname, port: u.port, path: p, headers }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    }).on("error", reject);
  });
}

test("forwardedProto unit: right-to-left by hop count", () => {
  const S = require("../server.js");
  assert.equal(S.forwardedProto("https", 1), "https");
  assert.equal(S.forwardedProto("https, http", 1), "http", "rightmost = appended by the trusted proxy");
  assert.equal(S.forwardedProto("https, http", 2), "https");
  assert.equal(S.forwardedProto("https, http, http", 2), "http");
  assert.equal(S.forwardedProto("https", 3), "https", "shorter list (overwriting proxies) → leftmost = value the proxy wrote");
  assert.equal(S.forwardedProto(["https", "http"], 1), "http", "duplicate header lines");
  assert.equal(S.forwardedProto("", 1), "");
});

test("X-Forwarded-Proto: untrusted forgery ignored; trusted proxy's appended value wins; multi-hop; duplicate headers", async (t) => {
  const srv = await startServer({ env: { TRUSTED_PROXY_CIDRS: "127.0.0.1/32, 10.0.0.0/8" } });
  t.after(() => srv.stop());
  const admin = client(srv.base);
  await admin.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  const cookie = [...admin.jar].map(([k, v]) => k + "=" + v).join("; ");
  const H = async (h) => (await admin.get("/api/health", h)).json.client;

  assert.equal((await H({ "X-Forwarded-Proto": "https" })).https, true, "single value from trusted proxy");
  assert.equal((await H({ "X-Forwarded-Proto": "https, http" })).https, false, "client forged https, proxy appended http → http");
  assert.equal((await H({ "X-Forwarded-For": "1.2.3.4", "X-Forwarded-Proto": "https, http" })).https, false);
  assert.equal((await H({ "X-Forwarded-For": "1.2.3.4", "X-Forwarded-Proto": "http, https" })).https, true);
  // two trusted hops: client 1.2.3.4 → p1 (10.1.1.1, TLS) → p2 (127.0.0.1)
  const mh = await H({ "X-Forwarded-For": "1.2.3.4, 10.1.1.1", "X-Forwarded-Proto": "https, http" });
  assert.equal(mh.ip, "1.2.3.4"); assert.equal(mh.https, true, "value of the hop that saw the client");
  assert.equal((await H({ "X-Forwarded-For": "1.2.3.4, 10.1.1.1", "X-Forwarded-Proto": "https, http, http" })).https, false, "client-forged left-most value ignored");
  assert.equal((await H({ "X-Forwarded-For": "6.6.6.6, 1.2.3.4, 10.1.1.1", "X-Forwarded-Proto": "https, http, http" })).https, false);
  // duplicate header lines (Node joins them with ", ")
  assert.equal((await rawGet(srv.base, "/api/health", { Cookie: cookie, "X-Forwarded-Proto": ["https", "http"] })).client.https, false);
  assert.equal((await rawGet(srv.base, "/api/health", { Cookie: cookie, "X-Forwarded-Proto": ["http", "https"] })).client.https, true);
});

test("X-Forwarded-Proto from an untrusted peer never counts", async (t) => {
  const srv = await startServer({ env: { TRUSTED_PROXY_CIDRS: "10.0.0.0/8" } });
  t.after(() => srv.stop());
  const admin = client(srv.base);
  await admin.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  for (const v of ["https", "http, https", "https, https"]) assert.equal((await admin.get("/api/health", { "X-Forwarded-Proto": v, "X-Forwarded-For": "10.1.1.1" })).json.client.https, false);
});
