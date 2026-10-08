"use strict";
/* 沙盒自测：用真实的 V1.1 基线 server.js（test/v11.js 按 blob 取出）造一份「生产」data：
 * 管理员 + 第二个账户、配置、上传的图标、自定义壁纸、3 个会话（管理员两台设备 + bob）、对应的已知设备。
 * 全是假数据。用法：node seed-prod.js <DATA_DIR> <COOKIES_OUT.json> */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { startServer, client, sleep } = require("../helpers");
const { v11Root } = require("../v11");

(async () => {
  const [dir, out] = process.argv.slice(2);
  const V11 = v11Root();
  if (V11.skip) throw new Error(V11.skip);
  fs.mkdirSync(dir, { recursive: true });
  const srv = await startServer({ root: V11.root, dataDir: dir });
  const a1 = client(srv.base), a2 = client(srv.base), b1 = client(srv.base);
  const must = (r, what) => { if (r.status !== 200) throw new Error(what + " " + r.status + " " + r.body); return r; };
  must(await a1.post("/api/setup", { name: "admin", password: "admin-pass-1" }), "setup");
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const up = must(await a1.req("POST", "/api/icons", PNG, { "Content-Type": "image/png" }), "icon");
  const fix = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "v1.1-config.json"), "utf8"));
  delete fix.settings.net; delete fix.recent;
  fix.groups[0].items[0].icon = { type: "image", value: up.json.url, bg: "" };
  must(await a1.put("/api/config", { baseVersion: 0, data: fix }), "config");
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2048), Buffer.from([0xff, 0xd9])]);
  must(await a1.req("PUT", "/api/wallpaper", JPG, { "Content-Type": "image/jpeg" }), "wallpaper");
  const w = (await a1.get("/api/config")).json; w.data.settings.wallpaper = { id: "custom", file: true, v: 1, url: "" };
  must(await a1.put("/api/config", { baseVersion: w.version, data: w.data }), "config2");
  must(await a1.post("/api/users", { name: "bob", password: "bob-pass-12" }), "user bob");
  must(await a2.post("/api/login", { name: "admin", password: "admin-pass-1" }), "login a2");
  must(await b1.post("/api/login", { name: "bob", password: "bob-pass-12" }), "login bob");
  await sleep(2600); // 会话延迟 2 秒落盘
  await srv.stop();
  fs.writeFileSync(out, JSON.stringify({ admin: Object.fromEntries(a1.jar), bob: Object.fromEntries(b1.jar) }), { mode: 0o600 });
  console.log("seeded", dir);
})().catch((e) => { console.error(e); process.exit(1); });
