"use strict";
/* V2.0 RC · tools/backup.sh / verify-backup.sh / restore.sh（POSIX sh，独立于夜曲进程）——真实数据目录 + 真实服务器 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { startServer, client, sleep } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const TOOLS = path.join(ROOT, "tools");
const SKIP = spawnSync("sh", ["-c", "command -v tar && command -v gzip"]).status === 0 ? false : "需要 sh / tar / gzip";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(4096), Buffer.from([0xff, 0xd9])]);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const sh = (script, args, opts = {}) => spawnSync("sh", [path.join(TOOLS, script), ...args], Object.assign({ encoding: "utf8" }, opts));
function tree(dir) { // 相对路径 → sha256（跳过 *.tmp）
  const out = {};
  (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (!f.name.endsWith(".tmp")) out[path.relative(dir, p)] = sha(fs.readFileSync(p)); } })(dir);
  return out;
}
function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-bk-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
const cfg = (title, n) => ({ settings: { title }, groups: [{ id: "g1", name: "组", style: "icon", items: Array.from({ length: n }, (_, i) => ({ id: "it" + i, title: "项目" + i, lan: "", wan: "https://e" + i + ".example" })) }],
  spaces: [{ id: "s-a", name: "日常", groupIds: ["g1"] }], spacesVersion: 2 });

async function seed(dir) {
  const srv = await startServer({ dataDir: dir });
  const c = client(srv.base);
  await c.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  const up = (await c.req("POST", "/api/icons", PNG, { "Content-Type": "image/png" })).json;
  const d = cfg("夜曲", 5); d.groups[0].items[0].icon = { type: "image", value: up.url, bg: "" };
  await c.put("/api/config", { baseVersion: 0, data: d, caps: ["spaces", "spaces:2"] });
  await c.req("PUT", "/api/wallpaper", JPG, { "Content-Type": "image/jpeg" });
  const e = cfg("夜曲 2", 6); e.groups[0].items[0].icon = d.groups[0].items[0].icon; e.settings.wallpaper = { id: "custom", file: true, v: 1, url: "" };
  await c.put("/api/config", { baseVersion: 1, data: e, caps: ["spaces", "spaces:2"], restore: true }); // 进快照环
  await c.post("/api/users", { name: "bob", password: "bob-pass-12" });
  return { srv, c, iconUrl: up.url };
}

test("backup → verify → restore into an empty dir → V2 server on it: accounts, config, spaces, icons, wallpaper, ring identical", { skip: SKIP, timeout: 60000 }, async (t) => {
  const base = tmp(t), data = path.join(base, "data"), out = path.join(base, "out");
  fs.mkdirSync(data);
  const { srv, iconUrl } = await seed(data);
  await sleep(2300); // 会话文件是防抖写入的（2 秒）；docker stop 发 SIGTERM 会立刻写，这里的测试 stop 是 SIGKILL
  await srv.stop();
  fs.writeFileSync(path.join(data, "config", "admin.json.999.abcd.tmp"), "half-written");
  const before = tree(data);
  const b = sh("backup.sh", ["-o", out, data]);
  assert.equal(b.status, 0, b.stderr);
  const arc = fs.readdirSync(out).find((f) => /^nocturne-backup-\d{8}-\d{6}\.tar\.gz$/.test(f));
  assert.ok(arc && fs.existsSync(path.join(out, arc + ".sha256")));
  assert.equal(fs.statSync(path.join(out, arc)).mode & 0o077, 0, "archive is private (600)");
  assert.doesNotMatch(b.stdout + b.stderr, /scrypt\$|admin-pass|nocturne_sid/, "no secrets in output");
  const list = spawnSync("tar", ["-tzf", path.join(out, arc)], { encoding: "utf8" }).stdout.split("\n");
  for (const want of ["SHA256SUMS", "BACKUP-INFO.txt", "data/users.json", "data/sessions.json", "data/config/admin.json", "data/spaces-guard/admin.json"]) assert.ok(list.includes(want), want);
  assert.ok(list.some((x) => x.startsWith("data/backup/admin/")) && list.some((x) => x.startsWith("data/icons/admin/")) && list.some((x) => x.startsWith("data/wallpapers/admin.")));
  assert.ok(!list.some((x) => x.endsWith(".tmp")), "in-flight temp files skipped");
  assert.equal(sh("verify-backup.sh", [path.join(out, arc)]).status, 0);

  const target = path.join(base, "restored");
  const r = sh("restore.sh", [path.join(out, arc), target]);
  assert.equal(r.status, 0, r.stderr);
  const after = tree(target);
  assert.deepEqual(after, before, "restored tree byte-identical (except *.tmp)");

  const s2 = await startServer({ dataDir: target });
  t.after(() => s2.stop());
  const c = client(s2.base);
  assert.equal((await c.post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 200);
  const g = (await c.get("/api/config")).json;
  assert.equal(g.data.settings.title, "夜曲 2"); assert.equal(g.data.groups[0].items.length, 6); assert.equal(g.data.spaces[0].name, "日常");
  assert.equal(sha((await c.get("/" + iconUrl)).body), sha(PNG));
  assert.equal(sha((await c.get("/api/wallpaper")).body), sha(JPG));
  assert.ok((await c.get("/api/config/backups")).json.length >= 1, "backup ring restored");
  assert.equal((await client(s2.base).post("/api/login", { name: "bob", password: "bob-pass-12" })).status, 200);
});

test("verify / restore refuse damaged archives and non-empty targets", { skip: SKIP, timeout: 60000 }, async (t) => {
  const base = tmp(t), data = path.join(base, "data"), out = path.join(base, "out");
  fs.mkdirSync(path.join(data, "config"), { recursive: true });
  fs.writeFileSync(path.join(data, "users.json"), '{"users":[]}');
  fs.writeFileSync(path.join(data, "config", "admin.json"), '{"version":1,"data":{"settings":{},"groups":[]}}');
  assert.equal(sh("backup.sh", ["-o", out, "--exclude-ring", "--exclude-cache", data]).status, 0);
  const arc = path.join(out, fs.readdirSync(out).find((f) => f.endsWith(".tar.gz")));
  // 1. 归档字节被改：.sha256 不一致
  const bad1 = path.join(base, "bad1.tar.gz"); const buf = fs.readFileSync(arc); buf[buf.length - 20] ^= 0xff; fs.writeFileSync(bad1, buf);
  fs.copyFileSync(arc + ".sha256", bad1 + ".sha256");
  let v = sh("verify-backup.sh", [bad1]); assert.equal(v.status, 1); assert.match(v.stderr, /sha256/);
  // 2. 重新打包、里面的文件被改（没有 .sha256）：逐个核对发现
  const x = path.join(base, "x"); fs.mkdirSync(x); spawnSync("tar", ["-xzf", arc, "-C", x]);
  fs.writeFileSync(path.join(x, "data", "users.json"), '{"users":[{"name":"evil"}]}');
  const bad2 = path.join(base, "bad2.tar.gz"); spawnSync("tar", ["-czf", bad2, "-C", x, "SHA256SUMS", "BACKUP-INFO.txt", "data"]);
  v = sh("verify-backup.sh", [bad2]); assert.equal(v.status, 1); assert.match(v.stderr, /sha256 不一致：data\/users\.json/);
  // 3. 多出清单外的文件
  fs.copyFileSync(path.join(data, "users.json"), path.join(x, "data", "users.json"));
  fs.writeFileSync(path.join(x, "data", "extra.json"), "{}");
  const bad3 = path.join(base, "bad3.tar.gz"); spawnSync("tar", ["-czf", bad3, "-C", x, "SHA256SUMS", "BACKUP-INFO.txt", "data"]);
  v = sh("verify-backup.sh", [bad3]); assert.equal(v.status, 1); assert.match(v.stderr, /清单之外/);
  // 4. 损坏的归档不会动目标目录
  const tgt = path.join(base, "tgt");
  assert.equal(sh("restore.sh", [bad2, tgt]).status, 1); assert.ok(!fs.existsSync(tgt));
  // 5. 非空目标：拒绝；--force：原目录改名保留
  fs.mkdirSync(tgt); fs.writeFileSync(path.join(tgt, "keep.txt"), "mine");
  const r = sh("restore.sh", [arc, tgt]); assert.equal(r.status, 3); assert.match(r.stderr, /不是空目录/);
  assert.equal(fs.readFileSync(path.join(tgt, "keep.txt"), "utf8"), "mine");
  assert.equal(sh("restore.sh", ["--force", arc, tgt]).status, 0);
  const kept = fs.readdirSync(base).find((f) => f.startsWith("tgt.before-restore-"));
  assert.ok(kept); assert.equal(fs.readFileSync(path.join(base, kept, "keep.txt"), "utf8"), "mine");
  assert.deepEqual(tree(tgt), tree(data));
  // 6. 用法错误 / 不是夜曲目录
  assert.notEqual(sh("backup.sh", ["-o", out, base]).status, 0);
  assert.equal(sh("backup.sh", ["-o", path.join(data, "inner"), data]).status, 1, "output inside data dir refused");
});

test("hot backup while the server keeps writing: archive is internally consistent and restorable", { skip: SKIP, timeout: 90000 }, async (t) => {
  const base = tmp(t), data = path.join(base, "data"), out = path.join(base, "out");
  fs.mkdirSync(data);
  const { srv, c } = await seed(data);
  t.after(() => srv.stop());
  let stop = false, v = (await c.get("/api/config")).json.version, writes = 0;
  const writer = (async () => { while (!stop) { const r = await c.put("/api/config", { baseVersion: v, data: cfg("写入中 " + writes, 6), caps: ["spaces", "spaces:2"] }); if (r.status === 200) { v = r.json.version; writes++; } await sleep(30); } })();
  await sleep(300);
  const w0 = writes;
  const b = await new Promise((res) => { const p = require("node:child_process").spawn("sh", [path.join(TOOLS, "backup.sh"), "-o", out, data]); let o = ""; p.stdout.on("data", (x) => (o += x)); p.stderr.on("data", (x) => (o += x)); p.on("exit", (code) => res({ code, o })); });
  stop = true; await writer;
  assert.ok(w0 >= 1 && writes > w0, "server really kept writing before and during the backup (" + w0 + " / " + writes + ")");
  if (b.code !== 0) { assert.match(b.o, /一直在变/, "only allowed failure is the explicit 'keeps changing' refusal"); return; }
  const arc = path.join(out, fs.readdirSync(out).find((f) => f.endsWith(".tar.gz")));
  assert.equal(sh("verify-backup.sh", [arc]).status, 0);
  const tgt = path.join(base, "r");
  assert.equal(sh("restore.sh", [arc, tgt]).status, 0);
  const doc = JSON.parse(fs.readFileSync(path.join(tgt, "config", "admin.json"), "utf8"));
  const guard = JSON.parse(fs.readFileSync(path.join(tgt, "spaces-guard", "admin.json"), "utf8"));
  // 配置和旁路文件是先后两次原子写入：备份的那一刻可能恰好落在两次之间（旁路文件只落后一个版本，且只在「不是 V2 写的」时才会被用到）
  assert.ok(guard.version === doc.version || guard.version === doc.version - 1, "config v" + doc.version + " / guard v" + guard.version);
});
