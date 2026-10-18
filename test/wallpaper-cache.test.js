"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { seedAccount, startServer, client } = require("./helpers");

function png(value) {
  function chunk(type, data) {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, bytes, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, value, 0, 0, 255]), { level: 0 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG = png(10), REPLACEMENT = png(11);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 7), Buffer.from([0xff, 0xd9])]);

async function launch(t, auth = false) {
  const server = await startServer({ env: auth ? {} : { NOCTURNE_NO_AUTH: "1" }, seed(dir) {
    if (auth) seedAccount(dir);
    fs.mkdirSync(path.join(dir, "config"));
    fs.writeFileSync(path.join(dir, "config", (auth ? "admin" : "default") + ".json"), JSON.stringify({
      version: 1, writer: { app: "nocturne", gen: 2 }, data: { settings: { title: "Wallpaper cache fixture" }, groups: [] },
    }));
    if (auth) {
      fs.mkdirSync(path.join(dir, "wallpapers"));
      fs.writeFileSync(path.join(dir, "wallpapers/admin.png"), PNG);
    }
  } });
  t.after(() => server.stop());
  return { ...server, c: client(server.base), file: path.join(server.dataDir, "wallpapers/default.png") };
}
async function upload(c, bytes = PNG, type = "image/png") {
  const response = await c.req("PUT", "/api/wallpaper", bytes, { "Content-Type": type });
  assert.equal(response.status, 200);
  return "/" + response.json.url;
}
function revalidates(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-cache");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.match(response.headers.get("etag"), /^"[^"\r\n]+"$/);
}

test("every wallpaper query form revalidates GET, HEAD and conditional responses", async t => {
  const { c } = await launch(t), url = await upload(c);
  for (const [name, target] of [
    ["no query", "/api/wallpaper"], ["upload version", url], ["old version", "/api/wallpaper?v=old"],
    ["empty version", "/api/wallpaper?v="], ["arbitrary query", "/api/wallpaper?other=value"],
    ["repeated version", "/api/wallpaper?v=one&v=two"],
  ]) await t.test(name, async () => {
    const get = await c.get(target);
    assert.equal(get.status, 200); assert.deepEqual(get.body, PNG); revalidates(get);
    const head = await c.req("HEAD", target);
    assert.equal(head.status, 200); assert.equal(head.body.length, 0); revalidates(head);
    assert.equal(head.headers.get("content-length"), String(PNG.length));
    assert.equal(head.headers.get("etag"), get.headers.get("etag"));
    for (const method of ["GET", "HEAD"]) {
      const same = await c.req(method, target, undefined, { "If-None-Match": get.headers.get("etag") });
      assert.equal(same.status, 304); assert.equal(same.body.length, 0); revalidates(same);
    }
  });
});

test("changed bytes with identical size and mtime invalidate an old wallpaper ETag", async t => {
  const { c, file } = await launch(t), url = await upload(c);
  const time = new Date("2026-01-01T00:00:00.000Z");
  fs.utimesSync(file, time, time);
  const first = await c.get(url), before = fs.statSync(file), oldTag = first.headers.get("etag");
  assert.deepEqual(first.body, PNG); assert.equal(PNG.length, REPLACEMENT.length);
  await upload(c, REPLACEMENT);
  fs.utimesSync(file, before.atime, before.mtime);
  const after = fs.statSync(file);
  assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
  const current = await c.get(url, { "If-None-Match": oldTag });
  assert.equal(current.status, 200); assert.deepEqual(current.body, REPLACEMENT); revalidates(current);
  assert.notEqual(current.headers.get("etag"), oldTag);
  const head = await c.req("HEAD", url, undefined, { "If-None-Match": oldTag });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(head.headers.get("etag"), current.headers.get("etag"));
  assert.equal(head.headers.get("content-length"), String(REPLACEMENT.length));
  for (const method of ["GET", "HEAD"]) {
    const same = await c.req(method, url, undefined, { "If-None-Match": current.headers.get("etag") });
    assert.equal(same.status, 304); assert.equal(same.body.length, 0); revalidates(same);
  }
});

test("unchanged wallpaper bytes retain their ETag when the file timestamp changes", async t => {
  const { c, file } = await launch(t), url = await upload(c), first = await c.get(url);
  const time = new Date("2025-01-01T00:00:00.000Z");
  fs.utimesSync(file, time, time);
  const same = await c.get(url, { "If-None-Match": first.headers.get("etag") });
  assert.equal(same.status, 304); assert.equal(same.body.length, 0);
  assert.equal(same.headers.get("etag"), first.headers.get("etag")); revalidates(same);
});

test("old PNG URLs and validators return the current JPEG after a format switch", async t => {
  const { c, file } = await launch(t), url = await upload(c), first = await c.get(url);
  await upload(c, JPEG, "image/jpeg");
  assert.equal(fs.existsSync(file), false);
  const current = await c.get(url, { "If-None-Match": first.headers.get("etag") });
  assert.equal(current.status, 200); assert.deepEqual(current.body, JPEG);
  assert.equal(current.headers.get("content-type"), "image/jpeg");
  assert.notEqual(current.headers.get("etag"), first.headers.get("etag"));
  const head = await c.req("HEAD", url);
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(head.headers.get("content-type"), "image/jpeg");
  assert.equal(head.headers.get("content-length"), String(JPEG.length));
  assert.equal(head.headers.get("etag"), current.headers.get("etag"));
  const same = await c.get(url, { "If-None-Match": current.headers.get("etag") });
  assert.equal(same.status, 304); assert.equal(same.body.length, 0);
});

test("anonymous wallpaper requests stay unauthorized with existing or absent account media", async t => {
  const { c, dataDir } = await launch(t, true);
  for (const present of [true, false]) {
    if (!present) fs.unlinkSync(path.join(dataDir, "wallpapers/admin.png"));
    for (const method of ["GET", "HEAD"]) for (const url of ["/api/wallpaper", "/api/wallpaper?v=old"]) {
      const response = await c.req(method, url, undefined, { "If-None-Match": "*" });
      assert.equal(response.status, 401); assert.equal(response.headers.get("etag"), null);
      if (method === "HEAD") assert.equal(response.body.length, 0);
    }
  }
});

test("deleting the current wallpaper leaves no image at its old version URL", async t => {
  const { c } = await launch(t);
  assert.equal((await c.get("/api/wallpaper")).status, 404);
  const url = await upload(c);
  assert.equal((await c.del("/api/wallpaper")).status, 200);
  for (const method of ["GET", "HEAD"]) {
    const response = await c.req(method, url);
    assert.equal(response.status, 404); assert.equal(response.headers.get("etag"), null);
    if (method === "HEAD") assert.equal(response.body.length, 0);
  }
});
