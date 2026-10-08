"use strict";
/* 沙盒自测：扮演「用户在测试站上的操作」。
 *   node user.js old-cookies <BASE> <COOKIES.json>  生产站留下的旧 cookie（nocturne_sid / nocturne_dev）在测试站必须无效
 *   node user.js edit <BASE>                        用生产账户密码登录测试站，改一处配置（第一个分组改名）并保存 */
const fs = require("node:fs");
const { client } = require("../helpers");

(async () => {
  const [cmd, base, file] = process.argv.slice(2);
  if (cmd === "old-cookies") {
    const jar = JSON.parse(fs.readFileSync(file, "utf8")).admin;
    if (!jar.nocturne_sid || !jar.nocturne_dev) throw new Error("seed cookies missing");
    const c = client(base); for (const [k, v] of Object.entries(jar)) c.jar.set(k, v);
    const me = (await c.get("/api/me")).json, cfg = await c.get("/api/config");
    if (me.user || cfg.status !== 401) { console.log("FAIL old cookies accepted", JSON.stringify(me), cfg.status); process.exit(1); }
    console.log("ok old session rejected (me.user=null, /api/config 401)");
    return;
  }
  if (cmd === "edit") {
    const c = client(base);
    const r = await c.post("/api/login", { name: "admin", password: "admin-pass-1" });
    if (r.status !== 200) throw new Error("login " + r.status);
    const g = (await c.get("/api/config")).json;
    g.data.groups[0].name = g.data.groups[0].name + "（V2 测试改名）";
    const p = await c.put("/api/config", { baseVersion: g.version, data: g.data });
    if (p.status !== 200) throw new Error("put " + p.status + " " + p.body);
    console.log("ok edited, version " + g.version + " -> " + p.json.version);
    return;
  }
  throw new Error("usage");
})().catch((e) => { console.error(e.message); process.exit(1); });
