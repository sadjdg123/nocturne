"use strict";
/* V2.0 RC.3 · P-3 补强：atomicWrite() 用 open(tmp, "wx") 建临时文件；名字撞上一个已存在的文件（EEXIST）时，
 * RC.2 的 finally 会把那个**别人的**文件删掉。RC.3：只有 open 成功（created）之后才清理临时文件。
 * 进程内单元测试：require server.js（不启动服务），把 crypto.randomBytes 固定住来强制撞名；ENOSPC 用 test/fsfail.js 进程内注入。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CTL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-awctl-")), "ctl");
process.env.FSFAIL_CTL = CTL; // fsfail.js 每次 open / rename 现读控制文件；空 = 不注入
require("./fsfail.js");
const S = require("../server.js");
test.after(() => fs.rmSync(path.dirname(CTL), { recursive: true, force: true }));

function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-aw-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function fixRandom(t, hex) {
  const orig = crypto.randomBytes;
  crypto.randomBytes = (n, cb) => (n === 4 && !cb ? Buffer.from(hex, "hex") : orig.call(crypto, n, cb));
  t.after(() => { crypto.randomBytes = orig; });
}

test("atomicWrite 已导出给测试", () => { assert.equal(typeof S.atomicWrite, "function"); });

test("临时文件名撞上已存在的文件（EEXIST）：那个文件原样保留、目标文件不变、写入如实失败", async (t) => {
  const d = dir(t), target = path.join(d, "admin.json");
  fs.writeFileSync(target, '{"version":1}');
  fixRandom(t, "deadbeef");
  const theirs = target + "." + process.pid + ".deadbeef.tmp";
  fs.writeFileSync(theirs, "别人的临时文件，不能删");
  await assert.rejects(S.atomicWrite(target, '{"version":2}'), (e) => e.code === "EEXIST");
  assert.equal(fs.readFileSync(theirs, "utf8"), "别人的临时文件，不能删", "撞名的文件没被删、没被改");
  assert.equal(fs.readFileSync(target, "utf8"), '{"version":1}', "目标文件逐字节不变");
  assert.deepEqual(fs.readdirSync(d).sort(), [path.basename(target), path.basename(theirs)].sort(), "没有多出别的文件");
});

test("撞名的是符号链接 / 目录：同样不动它", async (t) => {
  const d = dir(t), target = path.join(d, "x.json"), elsewhere = path.join(d, "elsewhere.txt");
  fs.writeFileSync(target, "old"); fs.writeFileSync(elsewhere, "keep");
  fixRandom(t, "0badcafe");
  const name = target + "." + process.pid + ".0badcafe.tmp";
  fs.symlinkSync(elsewhere, name);
  await assert.rejects(S.atomicWrite(target, "new"), (e) => e.code === "EEXIST");
  assert.ok(fs.lstatSync(name).isSymbolicLink(), "符号链接还在");
  assert.equal(fs.readFileSync(elsewhere, "utf8"), "keep");
  fs.rmSync(name);
  fs.mkdirSync(name);
  await assert.rejects(S.atomicWrite(target, "new"), (e) => e.code === "EEXIST");
  assert.ok(fs.statSync(name).isDirectory(), "目录还在");
  assert.equal(fs.readFileSync(target, "utf8"), "old");
});

test("ENOSPC（半截写）：只删本次自己建的临时文件，目标不变", async (t) => {
  const d = dir(t), target = path.join(d, "cfg.json");
  fs.writeFileSync(target, "before");
  fixRandom(t, "feedf00d");
  fs.writeFileSync(CTL, "enospc " + path.basename(target).replace(/\./g, "\\.") + "\\.\\d+\\.feedf00d\\.tmp$\n");
  t.after(() => fs.writeFileSync(CTL, ""));
  await assert.rejects(S.atomicWrite(target, "x".repeat(4096)), (e) => e.code === "ENOSPC");
  assert.equal(fs.readFileSync(target, "utf8"), "before");
  assert.deepEqual(fs.readdirSync(d), ["cfg.json"], "自己建的半截临时文件已删掉");
});

test("rename 失败：同样只删自己的临时文件；正常写入成功不留临时文件", async (t) => {
  const d = dir(t), target = path.join(d, "w.json");
  fs.writeFileSync(target, "before");
  fs.writeFileSync(CTL, "rename /w\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
  await assert.rejects(S.atomicWrite(target, "after"), (e) => e.code === "ENOSPC");
  assert.deepEqual(fs.readdirSync(d), ["w.json"]);
  assert.equal(fs.readFileSync(target, "utf8"), "before");
  fs.writeFileSync(CTL, "");
  await S.atomicWrite(target, "after");
  assert.equal(fs.readFileSync(target, "utf8"), "after");
  assert.deepEqual(fs.readdirSync(d), ["w.json"]);
});
