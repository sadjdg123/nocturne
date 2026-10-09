"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process"), { ROOT } = require("./helpers");
const TOOLS = path.join(process.env.NOCTURNE_TOOL_TEST_ROOT || ROOT, "tools");
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function tree(d) { const out = {}; function walk(p, rel) { for (const n of fs.readdirSync(p, { withFileTypes: true })) { const r = path.join(rel, n.name), f = path.join(p, n.name); if (n.isDirectory()) walk(f, r); else if (!n.isSymbolicLink()) out[r] = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } } walk(d, ""); return out; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nc-restore-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "input"), out = path.join(root, "out"), target = path.join(root, "target"), bin = path.join(root, "bin");
  fs.mkdirSync(path.join(data, "config"), { recursive: true }); fs.mkdirSync(target); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(data, "users.json"), '{"users":[]}'); fs.writeFileSync(path.join(data, "config/a.json"), '{"version":2,"data":{"settings":{},"groups":[],"spaces":[]}}'); fs.writeFileSync(path.join(target, "keep"), "old original");
  const b = spawnSync("sh", [path.join(TOOLS, "backup.sh"), "-o", out, data], { encoding: "utf8" }); assert.equal(b.status, 0, b.stderr);
  const archive = path.join(out, fs.readdirSync(out).find(x => x.endsWith(".tar.gz"))), mark = path.join(root, "once");
  for (const cmd of ["mv", "tar", "chmod", "sha256sum", "sync"]) {
    const real = spawnSync("sh", ["-c", "command -v " + cmd], { encoding: "utf8" }).stdout.trim(); assert.ok(real);
    fs.writeFileSync(path.join(bin, cmd), `#!/bin/sh
set -eu
case "$*" in *'.nocturne-restore.'*) nc_stage=1 ;; *) nc_stage=0 ;; esac
if [ "${cmd}" = tar ] && [ "$nc_stage" = 1 ] && [ "$1" = -xzf ] && [ "$NC_FAULT" = tar ]; then exit 31; fi
if [ "${cmd}" = chmod ] && [ "$nc_stage" = 1 ] && [ "$NC_FAULT" = chmod ]; then exit 32; fi
if [ "${cmd}" = sha256sum ] && [ "$nc_stage" = 1 ] && [ "$NC_FAULT" = hash ]; then exit 33; fi
if [ "${cmd}" = sync ] && [ "$NC_FAULT" = sync ] && [ ! -e "$NC_MARK" ]; then touch "$NC_MARK"; exit 34; fi
if [ "${cmd}" = mv ]; then
  if [ "$1" = "$NC_TARGET" ]; then
    if [ "$NC_FAULT" = old-move ]; then exit 35; fi
    if [ "$NC_FAULT" = kill-old ] || [ "$NC_FAULT" = term-old ]; then ${quote(real)} "$@"; case "$NC_FAULT" in kill-old) kill -KILL "$PPID" ;; *) kill -TERM "$PPID" ;; esac; exit 0; fi
  fi
  case "$1" in */.nocturne-restore.*/data)
    case "$NC_FAULT" in new-move|rollback) exit 36 ;; kill-new) ${quote(real)} "$@"; kill -KILL "$PPID"; exit 0 ;; esac ;;
  esac
  case "$1" in *.before-restore-*) [ "$NC_FAULT" != rollback ] || exit 37 ;; esac
fi
exec ${quote(real)} "$@"
`, { mode: 0o755 });
  }
  const physicalTarget = fs.realpathSync(target);
  const env = mode => ({ ...process.env, PATH: bin + ":" + process.env.PATH, NC_FAULT: mode, NC_TARGET: physicalTarget, NC_MARK: mark });
  const run = (mode = "", shell = "sh", args = ["--force", archive, target]) => spawnSync(shell, [path.join(TOOLS, "restore.sh"), ...args], { env: env(mode), encoding: "utf8", timeout: 20000 });
  return { root, target, data, archive, run };
}
for (const mode of ["tar", "hash", "chmod", "old-move", "new-move", "sync", "term-old"]) test("恢复故障保护旧目标 " + mode, t => {
  const f = fixture(t), before = tree(f.target), r = f.run(mode); assert.notEqual(r.status, 0, "必须真实失败");
  assert.ok(fs.existsSync(f.target), "旧目标仍在原位置"); assert.deepEqual(tree(f.target), before); assert.ok(fs.existsSync(f.archive), "原备份保留");
});
test("回退二次失败保留旧目录、新材料与恢复记录", t => {
  const f = fixture(t), before = tree(f.target), r = f.run("rollback"); assert.notEqual(r.status, 0);
  const old = fs.readdirSync(f.root).find(x => x.startsWith("target.before-restore-")); assert.ok(old); assert.deepEqual(tree(path.join(f.root, old)), before);
  const state = f.target + ".restore-state"; assert.ok(fs.existsSync(state)); const stage = fs.readFileSync(path.join(state, "STAGE"), "utf8").trim(); assert.deepEqual(tree(path.join(stage, "data")), tree(f.data));
  const retry = f.run(); assert.equal(retry.status, 4, retry.stderr); assert.deepEqual(tree(f.target), before); assert.equal(f.run().status, 0);
});
for (const mode of ["kill-old", "kill-new"]) test("SIGKILL 后重跑恢复 " + mode, t => {
  const f = fixture(t), before = tree(f.target), r = f.run(mode); assert.equal(r.signal, "SIGKILL"); assert.ok(fs.existsSync(f.target + ".restore-state"));
  const next = f.run(); assert.equal(next.status, mode === "kill-old" ? 4 : 0, next.stderr); assert.deepEqual(tree(f.target), mode === "kill-old" ? before : tree(f.data));
  if (mode === "kill-old") assert.equal(f.run().status, 0); assert.deepEqual(tree(f.target), tree(f.data));
});
test("未完成记录与目标冲突保留全部材料", t => {
  const f = fixture(t); assert.equal(f.run("kill-old").signal, "SIGKILL"); fs.mkdirSync(f.target); fs.writeFileSync(path.join(f.target, "conflict"), "do not touch");
  const before = tree(f.root), r = f.run(); assert.notEqual(r.status, 0); assert.deepEqual(tree(f.root), before);
});
test("目标链接与危险根目录拒绝", t => {
  const f = fixture(t), alias = path.join(f.root, "alias"); fs.symlinkSync(f.target, alias); const before = tree(f.target);
  assert.notEqual(f.run("", "sh", ["--force", f.archive, alias]).status, 0); assert.ok(fs.lstatSync(alias).isSymbolicLink()); assert.deepEqual(tree(f.target), before);
  // 只验证用法拒绝，绝不能让旧版本 --force 触碰宿主根目录。
  if (!process.env.NOCTURNE_TOOL_TEST_ROOT) assert.notEqual(f.run("", "sh", [f.archive, "/"]).status, 0);
});
test("空/缺失目标、重复恢复及 dash 执行", t => {
  const f = fixture(t); fs.rmSync(f.target, { recursive: true }); assert.equal(f.run("", "dash").status, 0); assert.deepEqual(tree(f.target), tree(f.data));
  assert.equal(f.run().status, 0); assert.deepEqual(tree(f.target), tree(f.data));
  const empty = path.join(f.root, "empty"); fs.mkdirSync(empty); assert.equal(f.run("", "dash", [f.archive, empty]).status, 0); assert.deepEqual(tree(empty), tree(f.data));
});
test("归档链接在解压前拒绝", t => {
  const f = fixture(t), x = path.join(f.root, "links"); fs.mkdirSync(path.join(x, "data"), { recursive: true }); fs.symlinkSync(f.target, path.join(x, "data/link"));
  fs.writeFileSync(path.join(x, "SHA256SUMS"), ""); fs.writeFileSync(path.join(x, "BACKUP-INFO.txt"), "app=nocturne\nformat=1\nfiles=0\n"); const a = path.join(f.root, "links.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", a, "-C", x, "SHA256SUMS", "BACKUP-INFO.txt", "data"]).status, 0);
  const r = spawnSync("sh", [path.join(TOOLS, "verify-backup.sh"), "--no-sidecar", a], { encoding: "utf8" }); assert.notEqual(r.status, 0);
});

for (const prefix of [" ", "\t   "]) test("BusyBox inode 前导空白兼容 " + JSON.stringify(prefix), t => {
  const f = fixture(t), real = spawnSync("sh", ["-c", "command -v ls"], { encoding: "utf8" }).stdout.trim(); assert.ok(real);
  fs.writeFileSync(path.join(f.root, "bin/ls"), "#!/bin/sh\nprintf '%s' " + quote(prefix) + "\nexec " + quote(real) + " \"$@\"\n", { mode: 0o755 });
  const r = f.run(); assert.equal(r.status, 0, r.stderr); assert.deepEqual(tree(f.target), tree(f.data));
});
test("inode 命令失败或非数字仍保护旧目标", t => {
  const f = fixture(t), before = tree(f.target), ls = path.join(f.root, "bin/ls");
  for (const command of ["exit 41", "printf '  not-an-inode /test\\n'"]) {
    fs.writeFileSync(ls, "#!/bin/sh\n" + command + "\n", { mode: 0o755 });
    assert.notEqual(f.run().status, 0); assert.deepEqual(tree(f.target), before); assert.ok(fs.existsSync(f.archive));
  }
});
