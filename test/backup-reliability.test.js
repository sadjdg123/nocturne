"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process"), { once } = require("node:events"), { ROOT, startServer, client, cfg } = require("./helpers");
const TOOLS = path.join(process.env.NOCTURNE_BACKUP_TEST_ROOT || ROOT, "tools");
const q = s => "'" + s.replaceAll("'", "'\\''") + "'";
function fixture(t, mode = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nc-backup-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), out = path.join(root, "out"), bin = path.join(root, "bin"), onceFile = path.join(root, "once"), dockerState = path.join(root, "docker-state"), calls = path.join(root, "calls");
  fs.mkdirSync(path.join(data, "config"), { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(out); fs.writeFileSync(path.join(data, "users.json"), '{"users":[]}'); fs.writeFileSync(path.join(data, "config/a.json"), '{"version":1,"data":{"settings":{},"groups":[]}}'); fs.writeFileSync(dockerState, mode === "stopped" ? "false" : "true"); fs.writeFileSync(calls, "");
  for (const cmd of ["cp", "find", "sha256sum", "tar", "gzip", "ln", "date", "sleep"]) {
    const real = spawnSync("sh", ["-c", "command -v " + cmd], { encoding: "utf8" }).stdout.trim(); assert.ok(real);
    fs.writeFileSync(path.join(bin, cmd), `#!/bin/sh
set -eu
if [ "${cmd}" = sleep ]; then exit 0; fi
if [ "${cmd}" = date ] && [ "$1" = +%Y%m%d-%H%M%S ]; then echo 20990101-000000; exit 0; fi
case "$NC_MODE:${cmd}" in find:find|hash:sha256sum|tar:tar|gzip:gzip|publish:ln|copy:cp) exit 41 ;; esac
if [ "${cmd}" = cp ] && [ "$NC_MODE" = continuous ]; then
  n=0; [ ! -f "$NC_ONCE" ] || n=$(cat "$NC_ONCE"); n=$((n+1)); echo "$n" > "$NC_ONCE"; printf '%s' "$n" > "$NC_DATA/config/new-$n.json"
fi
${q(real)} "$@"
if [ ! -e "$NC_ONCE" ]; then
  if [ "${cmd}" = cp ] && [ "$NC_MODE" = add ]; then touch "$NC_ONCE"; echo new > "$NC_DATA/config/new.json"; fi
  if [ "${cmd}" = cp ] && [ "$NC_MODE" = rename ]; then touch "$NC_ONCE"; mv "$NC_DATA/config/a.json" "$NC_DATA/config/renamed.json"; fi
  if [ "${cmd}" = cp ] && [ "$NC_MODE" = replace ]; then touch "$NC_ONCE"; echo replacement > "$NC_DATA/config/a.json"; fi
  if [ "${cmd}" = cp ] && [ "$NC_MODE" = delete ]; then touch "$NC_ONCE"; rm "$NC_DATA/config/a.json"; fi
  if [ "${cmd}" = sha256sum ] && [ "$NC_MODE" = late-add ]; then
    case "$1" in "$NC_DATA"/*) touch "$NC_ONCE"; mkdir -p "$NC_DATA/icons"; echo late > "$NC_DATA/icons/new.png" ;; esac
  fi
fi
`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh
set -eu
echo "$1" >> "$NC_CALLS"
case "$1" in
 inspect) [ "$NC_MODE" != inspect ] || exit 42; cat "$NC_DOCKER" ;;
 stop) case "$NC_MODE" in stop) exit 43 ;; stop-changed) echo false > "$NC_DOCKER"; exit 44 ;; esac; echo false > "$NC_DOCKER" ;;
 start) [ "$NC_MODE" != start ] || exit 45; echo true > "$NC_DOCKER" ;;
 *) exit 46 ;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ":" + process.env.PATH, NC_MODE: mode, NC_DATA: fs.realpathSync(data), NC_ONCE: onceFile, NC_DOCKER: dockerState, NC_CALLS: calls };
  const run = (args = [], shell = "sh") => spawnSync(shell, [path.join(TOOLS, "backup.sh"), "-o", out, ...args, data], { env, encoding: "utf8", timeout: 15000 });
  const archive = () => path.join(out, fs.readdirSync(out).find(x => x.endsWith(".tar.gz")) || "absent");
  const unpack = () => { const d = path.join(root, "extracted"); fs.mkdirSync(d); assert.equal(spawnSync("tar", ["-xzf", archive(), "-C", d]).status, 0); return path.join(d, "data"); };
  return { root, data, out, run, archive, unpack, dockerState, calls };
}
for (const mode of ["add", "late-add", "rename", "replace", "delete"]) test("热备份清单及源文件变化 " + mode, t => {
  const f = fixture(t, mode), r = f.run(); assert.equal(r.status, 0, r.stderr); const restored = f.unpack();
  function all(d) { const result = {}; function walk(p, rel) { for (const n of fs.readdirSync(p, { withFileTypes: true })) { const r = path.join(rel,n.name), a = path.join(p,n.name); if(n.isDirectory())walk(a,r);else result[r] = crypto.createHash("sha256").update(fs.readFileSync(a)).digest("hex"); } } walk(d,""); return result; }
  assert.deepEqual(all(restored), all(f.data), "新增/删除/改名/替换没有遗漏");
});
for (const mode of ["continuous", "find", "hash", "tar", "gzip", "copy", "publish"]) test("命令失败或持续变化不发布备份 " + mode, t => {
  const f = fixture(t, mode), r = f.run(); assert.notEqual(r.status, 0); assert.deepEqual(fs.readdirSync(f.out), [], "不留下成功归档/侧车/part");
});
test("源目录链接拒绝，不能被清单静默遗漏", t => {
  const f = fixture(t); fs.symlinkSync(path.join(f.data, "users.json"), path.join(f.data, "alias")); assert.notEqual(f.run().status, 0); assert.deepEqual(fs.readdirSync(f.out), []);
});
for (const mode of ["stopped", "running", "inspect", "stop", "stop-changed", "start"]) test("--stop 容器原状态保护 " + mode, t => {
  const f = fixture(t, mode), r = f.run(["--stop", "synthetic-nocturne"]), calls = fs.readFileSync(f.calls, "utf8").trim().split("\n");
  if (["stopped", "running"].includes(mode)) assert.equal(r.status, 0, r.stderr); else assert.notEqual(r.status, 0);
  if (mode === "stopped") { assert.ok(!calls.includes("start") && !calls.includes("stop")); assert.equal(fs.readFileSync(f.dockerState, "utf8").trim(), "false"); }
  if (["running", "stop-changed"].includes(mode)) assert.equal(fs.readFileSync(f.dockerState, "utf8").trim(), "true");
  if (mode === "inspect") assert.ok(!calls.includes("stop") && !calls.includes("start"));
  if (["inspect", "stop", "stop-changed"].includes(mode)) assert.deepEqual(fs.readdirSync(f.out), []);
  if (mode === "start") { assert.ok(fs.existsSync(f.archive()), "已校验备份保留，但服务未恢复必须非零"); assert.match(r.stderr, /启动失败|未恢复/); }
});
test("同名成功备份和孤立侧车均不覆盖；dash 可执行", t => {
  const f = fixture(t), sidecar = path.join(f.out,"nocturne-backup-20990101-000000.tar.gz.sha256"); fs.writeFileSync(sidecar,"old-sidecar");
  assert.notEqual(f.run().status,0); assert.equal(fs.readFileSync(sidecar,"utf8"),"old-sidecar"); fs.unlinkSync(sidecar);
  assert.equal(f.run([],"dash").status,0); const before=fs.readFileSync(f.archive()); assert.notEqual(f.run().status,0); assert.ok(fs.readFileSync(f.archive()).equals(before));
});
test("停写完整备份包含中断认证事务，恢复后由服务器完成撤销", async t => {
  const f = fixture(t); fs.rmSync(f.data,{recursive:true}); fs.mkdirSync(f.data); const ctl=path.join(f.root,"auth-fault"); fs.writeFileSync(ctl,"");
  const srv=await startServer({dataDir:f.data,env:{NODE_OPTIONS:"--require="+path.join(ROOT,"test/fsfail.js"),FSFAIL_CTL:ctl}});t.after(()=>srv.stop());const c=client(srv.base);
  assert.equal((await c.post("/api/setup",{name:"admin",password:"admin-pass-1"})).status,200);assert.equal((await c.put("/api/config",{baseVersion:0,data:cfg("完整",[],{spaces:[]})})).status,200);
  const ended=once(srv.child,"exit");fs.writeFileSync(ctl,"kill_after_rename users\\.json\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");await c.post("/api/password",{old:"admin-pass-1",password:"new-pass-12"}).catch(()=>{});await ended;
  assert.ok(fs.existsSync(path.join(f.data,".auth-transaction")));assert.equal(f.run().status,0);
  const target=path.join(f.root,"recovered");const r=spawnSync("sh",[path.join(TOOLS,"restore.sh"),f.archive(),target],{encoding:"utf8"});assert.equal(r.status,0,r.stderr);
  const s=await startServer({dataDir:target});t.after(()=>s.stop());const rc=client(s.base);assert.equal((await rc.post("/api/login",{name:"admin",password:"admin-pass-1"})).status,200);assert.deepEqual((await rc.get("/api/config")).json.data.spaces,[]);assert.ok(!fs.existsSync(path.join(target,".auth-transaction")));
});
