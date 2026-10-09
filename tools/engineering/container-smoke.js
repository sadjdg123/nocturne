"use strict";
// 仅临时名称、临时卷、内部网络、容器回环 HTTP（不发布端口）；不接入 Docker socket/宿主数据。
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { execFileSync, execFile } = require("node:child_process");
const { cfg } = require("../../test/helpers");
const [image, arch, output] = process.argv.slice(2), ROOT = path.join(__dirname, "../..");
assert.match(image || "", /^nocturne-(engineering|phase2):[a-z0-9-]+$/); assert.ok(["amd64", "arm64"].includes(arch));
fs.mkdirSync(output, { recursive: true });
const id = "nc-smoke-" + crypto.randomUUID(), main = id + "-main", aux = id + "-archive", restored = id + "-restored", network = id + "-net", data = id + "-data", copy = id + "-copy";
const containers = [], volumes = [], checks = [], log = [];
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const inside = (c, js, ...args) => docker("exec", c, "node", "-e", js, ...args);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function client(container) {
  const jar = new Map();
  async function req(method, route, body) {
    const input = JSON.stringify({ method, route, body, cookie: [...jar].map(([k,v]) => k + "=" + v).join("; ") });
    const code = `const q=JSON.parse(process.argv[1]);fetch('http://127.0.0.1:8080'+q.route,{method:q.method,headers:{Cookie:q.cookie,'Content-Type':'application/json'},body:q.body===undefined?undefined:JSON.stringify(q.body)}).then(async r=>{const text=await r.text();let json=null;try{json=JSON.parse(text)}catch{}console.log(JSON.stringify({status:r.status,json,setCookie:r.headers.getSetCookie()}))}).catch(e=>{console.error(e);process.exitCode=1})`;
    const raw = await new Promise((resolve,reject) => execFile("docker", ["exec",container,"node","-e",code,input], { encoding:"utf8",timeout:15000 }, (e,out)=>e?reject(e):resolve(out)));
    const r=JSON.parse(raw); for(const c of r.setCookie){const kv=c.split(';')[0],i=kv.indexOf('=');jar.set(kv.slice(0,i),kv.slice(i+1));} return r;
  }
  return { get:p=>req("GET",p),post:(p,b)=>req("POST",p,b),put:(p,b)=>req("PUT",p,b),del:p=>req("DELETE",p) };
}
const mark = name => { checks.push(name); console.log("PASS " + name); };
function control(c, file, text) { inside(c, "require('fs').writeFileSync(process.argv[1],process.argv[2],{mode:0o644});require('fs').chownSync(process.argv[1],1026,100)", "/tmp/phase2-controls/" + file, text); }
async function healthy(c) {
  for (let i = 0; i < 100; i++) { try { if ((await client(c).get("/api/health")).status === 200) return c; } catch {} await pause(200); }
  throw new Error("container never healthy: " + docker("logs", c));
}
function create(c, volume, dir, fault = false) {
  const args = ["create", "--platform", "linux/" + arch, "--name", c, "--network", network, "--mount", "type=volume,source=" + volume + ",target=/data", "-e", "PUID=1026", "-e", "PGID=100", "-e", "DATA_DIR=" + dir, "-e", "STATUS_INTERVAL=3600"];
  if (fault) args.push("-e", "NODE_OPTIONS=--require=/tmp/pid1-kill.js --require=/tmp/fsfail.js --require=/tmp/auth-retirement-fault.js --require=/tmp/auth-commit-fault.js", "-e", "FSFAIL_CTL=/tmp/phase2-controls/fs-control", "-e", "AUTH_RETIREMENT_CTL=/tmp/phase2-controls/retire-control", "-e", "AUTH_BOUNDARY_CTL=/tmp/phase2-controls/boundary-control");
  docker(...args, image); containers.push(c);
  if (fault) for (const n of ["fsfail.js", "auth-retirement-fault.js", "auth-commit-fault.js"]) docker("cp", path.join(ROOT, "test", n), c + ":/tmp/" + n);
  if (fault) docker("cp", path.join(__dirname, "pid1-kill.js"), c + ":/tmp/pid1-kill.js");
  docker("start", c);
  if (fault) inside(c, "const fs=require('fs');fs.mkdirSync('/tmp/phase2-controls',{recursive:true});fs.chownSync('/tmp/phase2-controls',1026,100);fs.chmodSync('/tmp/phase2-controls',0o700)");
}
async function crash(c, container, body) {
  inside(container, "require('fs').rmSync('/tmp/phase2-kill-ready',{force:true})");
  const request = c.post("/api/password", body).catch(() => null);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = inside(container, "console.log(require('fs').existsSync('/tmp/phase2-kill-ready'))") === "true";
    if (ready) break; await pause(100);
  }
  assert.equal(ready, true, "指定故障边界必须真实命中");
  docker("kill", "--signal", "KILL", container); await request;
  assert.equal(docker("inspect", "--format", "{{.State.ExitCode}}", container), "137");
  // kill_* 规则不自行消费；容器停止后先清空控制文件，再验证重启。
  const clear = path.join(output, "empty-control-" + crypto.randomUUID()); fs.writeFileSync(clear, "", { mode: 0o644 });
  try { docker("cp", clear, container + ":/tmp/phase2-controls/fs-control"); } finally { fs.unlinkSync(clear); }
}
async function login(base, password) { const c = client(base); const r = await c.post("/api/login", { name: "admin", password }); assert.equal(r.status, 200); return c; }
(async () => {
  try {
    docker("network", "create", "--internal", network);
    for (const v of [data, copy]) { docker("volume", "create", v); volumes.push(v); }
    const dir = "/data/nc-boundary-smoke";
    create(main, data, dir, true); let base = await healthy(main), c = client(base), password = "phase2-admin-pass-1";
    assert.equal(inside(main, "console.log(process.platform+' '+process.arch)"), "linux " + (arch === "amd64" ? "x64" : "arm64"));
    const uid = inside(main, "console.log(require('fs').readFileSync('/proc/1/status','utf8').match(/^Uid:\\s+(\\d+)/m)[1])"); assert.equal(uid, "1026"); mark("actual Linux Node architecture and non-root PID 1");
    const setup = await c.post("/api/setup", { name: "admin", password }); assert.equal(setup.status, 200); assert.ok(setup.setCookie.some(x => x.startsWith("nocturne_sid="))); mark("setup and unchanged default Cookie");
    const initial = await c.get("/api/config"), value = cfg("Linux retained bookmark"); value.spaces = [{ id: "linux-space", name: "Linux", groupIds: [value.groups[0].id] }];
    const saved = await c.put("/api/config", { baseVersion: initial.json.version, data: value, opId: "linux-save-1", caps: { spaces: true } }); assert.equal(saved.status, 200);
    const expected = (await c.get("/api/config")).json.data; assert.deepEqual(expected.spaces, value.spaces); mark("configuration and spaces persistence");
    assert.equal((await c.post("/api/users", { name: "bob", password: "phase2-bob-pass-1" })).status, 200);
    assert.equal((await c.del("/api/users/bob")).status, 200); assert.ok(!(await c.get("/api/users")).json.some(x => x.name === "bob")); mark("account create and delete");
    // 提交前失败：SIGKILL 必须实际终止 PID 1；不能用正常停机代替。
    control(main, "fs-control", "kill_rename COMMITTED\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n");
    await crash(c, main, { old: password, password: "phase2-before-marker" });
    mark("real SIGKILL before COMMITTED");
    // 写入实例已退出；生产镜像的 BusyBox 工具在另一个无宿主挂载容器内完整备份。
    docker("create", "--platform", "linux/" + arch, "--name", aux, "--network", "none", "--entrypoint", "sh", "--mount", "type=volume,source=" + data + ",target=/input,readonly", "--mount", "type=volume,source=" + copy + ",target=/restore", image, "-c", "sleep 3600"); containers.push(aux);
    docker("cp", path.join(ROOT, "tools"), aux + ":/tmp/tools"); docker("start", aux);
    const transcript = docker("exec", aux, "sh", "-c", "set -eu; mkdir /tmp/out; sh /tmp/tools/backup.sh -o /tmp/out /input/nc-boundary-smoke; archive=$(find /tmp/out -name '*.tar.gz'); sh /tmp/tools/verify-backup.sh \"$archive\"; sh /tmp/tools/restore.sh \"$archive\" /restore/restored");
    fs.writeFileSync(path.join(output, "busybox-archive.log"), transcript + "\n"); docker("cp", aux + ":/tmp/out/.", output);
    create(restored, copy, "/data/restored"); const restoredBase = await healthy(restored), restoredClient = await login(restoredBase, password);
    assert.deepEqual((await restoredClient.get("/api/config")).json.data, expected); assert.equal((await client(restoredBase).post("/api/login", { name: "admin", password: "phase2-before-marker" })).status, 401); mark("BusyBox stopped archive, restore, pending transaction rollback and spaces");
    docker("start", main); base = await healthy(main); c = await login(base, password); assert.deepEqual((await c.get("/api/config")).json.data, expected); mark("source restart rollback and retained configuration");
    control(main, "fs-control", "kill_after_rename COMMITTED\\.\\d+\\.[0-9a-f]{8}\\.tmp$\n"); const next = "phase2-after-marker";
    await crash(c, main, { old: password, password: next }); docker("start", main); base = await healthy(main); c = await login(base, next);
    assert.equal((await client(base).post("/api/login", { name: "admin", password })).status, 401); password = next; mark("real SIGKILL after COMMITTED: new password only");
    control(main, "retire-control", JSON.stringify({ mode: "eio", target: "RECORD.json" }));
    const partial = await c.post("/api/password", { old: password, password: "phase2-partial-cleanup" }); assert.equal(partial.status, 200); assert.ok(partial.setCookie.some(x => x.startsWith("nocturne_dev=")));
    assert.ok(JSON.parse(inside(main, "console.log(JSON.stringify(require('fs').readdirSync(process.argv[1])))", dir)).some(n => n.startsWith(".auth-cleanup.")));
    docker("kill", "--signal", "KILL", main); docker("start", main); base = await healthy(main); c = await login(base, "phase2-partial-cleanup"); password = "phase2-partial-cleanup"; mark("retired RECORD removed then EIO, actual container restart");
    control(main, "boundary-control", JSON.stringify({ mode: "read_eio", file: "users.json" }));
    const boundary = await c.post("/api/password", { old: password, password: "phase2-storage-error" }); assert.equal(boundary.status, 503); assert.deepEqual(boundary.setCookie, []); assert.equal((await c.get("/api/health")).status, 503);
    control(main, "boundary-control", ""); assert.equal((await client(base).post("/api/login", { name: "admin", password: "phase2-storage-error" })).status, 503); mark("post-COMMITTED EIO: 503, no Cookie, process remains blocked");
    docker("kill", "--signal", "KILL", main); docker("start", main); base = await healthy(main); c = await login(base, "phase2-storage-error"); assert.deepEqual((await c.get("/api/config")).json.data, expected); mark("storage fault restart recovery without configuration loss");
    // Docker HEALTHCHECK 本身必须执行成功，不仅依赖 HTTP 客户端。
    docker("exec", main, "sh", "-c", "wget -qO- http://127.0.0.1:8080/api/health >/dev/null");
    for (let i = 0; i < 180; i++) { if (docker("inspect", "--format", "{{.State.Health.Status}}", main) === "healthy") break; await pause(200); }
    assert.equal(docker("inspect", "--format", "{{.State.Health.Status}}", main), "healthy"); mark("actual Docker HEALTHCHECK healthy");
    fs.writeFileSync(path.join(output, "smoke.json"), JSON.stringify({ arch, image, passed: checks.length, failed: 0, checks }, null, 2) + "\n");
  } finally {
    for (const c of containers) { try { log.push("--- " + c + " ---\n" + docker("logs", c)); } catch {} }
    fs.writeFileSync(path.join(output, "containers.log"), log.join("\n"));
    for (const c of containers.reverse()) { try { docker("rm", "-f", "-v", c); } catch {} }
    for (const v of volumes) { try { docker("volume", "rm", v); } catch {} }
    try { docker("network", "rm", network); } catch {}
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
