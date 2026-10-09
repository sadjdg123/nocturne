"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { validatePlan, createRegistryReader, simulatePublication } = require(path.join(process.env.NOCTURNE_POLICY_ROOT || path.join(__dirname, ".."), "tools/image-publish-policy"));
const SHA = "af5104c285abd041e4118faae5d277c23917b113";
const OTHER = SHA.slice(0, 7) + "0".repeat(33); // 七位短 SHA 碰撞。
const plan = { approved: true, repository: "sadjdg123/nocturne", event: "push", ref: "refs/heads/v2", revision: SHA, tags: ["sha-af5104c"] };
const hash = b => "sha256:" + crypto.createHash("sha256").update(b).digest("hex");
function artifact({ revision = SHA, architectures = ["amd64", "arm64"], splitRevision = false, attest = false } = {}) {
  const objects = new Map(), descriptors = [];
  function store(obj) { const b = Buffer.from(JSON.stringify(obj)), d = hash(b); objects.set(d, b); return { digest: d, size: b.length }; }
  for (const arch of architectures) {
    const config = store({ os: "linux", architecture: arch, config: { Labels: { "org.opencontainers.image.revision": splitRevision && arch === "arm64" ? OTHER : revision } } });
    const manifest = store({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config, layers: [] });
    descriptors.push({ ...manifest, mediaType: "application/vnd.oci.image.manifest.v1+json", platform: { os: "linux", architecture: arch } });
  }
  if (attest) descriptors.push({ digest: "sha256:" + "e".repeat(64), size: 1, mediaType: "application/vnd.oci.image.manifest.v1+json", platform: { os: "unknown", architecture: "unknown" }, annotations: { "vnd.docker.reference.type": "attestation-manifest" } });
  const index = store({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: descriptors });
  return { ...index, objects };
}
function mock(initial = null, fault = "") {
  const state = { artifact: initial, pushes: 0, requests: [] };
  const response = (b, status = 200, headers = {}) => new Response(b, { status, headers });
  const http = async (url, options) => {
    state.requests.push([url, options.method]);
    assert.match(url, /^https:\/\/ghcr\.io\/v2\//);
    assert.ok(["GET", "HEAD"].includes(options.method), "所有 HTTP 适配器调用只读");
    assert.ok(["error", "manual"].includes(options.redirect));
    assert.equal(options.headers.Authorization, "Bearer simulated-only");
    if (fault === "transport") throw new Error("simulated timeout");
    if (url.endsWith("/v2/")) return response(null, 200, fault === "api" ? {} : { "Docker-Distribution-API-Version": "registry/2.0" });
    if (/^\d+$/.test(fault)) return response(null, +fault);
    if (fault === "html404") return response(options.method === "HEAD" ? null : "<html>gateway</html>", 404);
    if (fault === "name404") return response(options.method === "HEAD" ? null : JSON.stringify({ errors: [{ code: "NAME_UNKNOWN" }] }), 404);
    if (!state.artifact) return response(options.method === "HEAD" ? null : JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN" }] }), 404);
    const a = state.artifact, ref = url.split("/").pop(), b = a.objects.get(ref.startsWith("sha256:") ? ref : a.digest);
    if (!b) return response(null, 404);
    const d = hash(b), headers = { "Docker-Content-Digest": fault === "digest" ? "sha256:" + "0".repeat(64) : d };
    if (fault === "missingDigest" && options.method === "HEAD") delete headers["Docker-Content-Digest"];
    return response(options.method === "HEAD" ? null : fault === "corrupt" ? Buffer.from("broken") : b, 200, headers);
  };
  const inspect = createRegistryReader({ fetch: http, authorization: "Bearer simulated-only" });
  const publisher = { simulation: true, async push() { state.pushes++; state.artifact = artifact(); return { digest: state.artifact.digest }; } };
  return { state, inspect, publisher, http };
}
function run(m, p = plan) {
  if (process.env.CI_POLICY_LEGACY === "1") {
    // 反证仅重放旧工作流的 push 条件；不运行 Actions / Docker，不声称真实发布。
    const source = fs.readFileSync(path.join(__dirname, "../.github/workflows/docker.yml"), "utf8");
    assert.ok(source.includes("push: ${{ github.event_name != 'pull_request' }}"));
    return p.event !== "pull_request" ? m.publisher.push(p) : Promise.resolve({ action: "skip" });
  }
  return simulatePublication({ plan: p, inspect: m.inspect, publisher: m.publisher });
}
test("已有标签同 revision 重跑只读核验后跳过，绝不重推", async () => {
  const m = mock(artifact()); assert.equal((await run(m)).action, "skip"); assert.equal(m.state.pushes, 0);
});
test("已有标签短 SHA 碰撞时禁止覆盖", async () => {
  const m = mock(artifact({ revision: OTHER })); await assert.rejects(run(m), /blocked/); assert.equal(m.state.pushes, 0);
});
test("已认证明确 MANIFEST_UNKNOWN 才允许一次模拟写入并核验 digest", async () => {
  const m = mock(); const result = await run(m); assert.equal(result.action, "published"); assert.equal(result.digest, m.state.artifact.digest); assert.equal(m.state.pushes, 1);
});
for (const fault of ["401", "403", "429", "500", "503", "html404", "name404", "transport", "api", "digest", "missingDigest", "corrupt"]) {
  test("注册表 " + fault + " 结果不确定时禁止写入", async () => {
    const m = mock(artifact(), fault); await assert.rejects(run(m), /blocked/); assert.equal(m.state.pushes, 0);
  });
}
for (const [name, options] of [["缺少 arm64", { architectures: ["amd64"] }], ["重复 amd64", { architectures: ["amd64", "amd64", "arm64"] }], ["非目标架构", { architectures: ["amd64", "arm64", "s390x"] }], ["两架构 revision 不同", { splitRevision: true }], ["仅短 revision", { revision: SHA.slice(0, 7) }]]) {
  test(name + " 的既有索引阻断写入", async () => {
    const m = mock(artifact(options)); await assert.rejects(run(m), /blocked/); assert.equal(m.state.pushes, 0);
  });
}
test("Buildx 显式证明材料不冒充运行架构", async () => {
  const m = mock(artifact({ attest: true })); assert.equal((await run(m)).action, "skip"); assert.equal(m.state.pushes, 0);
});
for (const tags of [["latest"], ["v2"], ["2.0"], ["2.0.0"], ["sha-af5104c", "latest"], ["sha-af5104c", "sha-af5104c"], ["sha-0000000"]]) {
  test("模拟计划拒绝非精确 SHA 标签 " + tags.join(","), () => assert.throws(() => validatePlan({ ...plan, tags }), /blocked/));
}
test("独立分支、PR、main、错仓库及短提交不进入模拟发布", () => {
  for (const override of [{ approved: false }, { ref: "refs/heads/fix/p1-storage-protection" }, { ref: "refs/heads/main" }, { event: "pull_request" }, { repository: "other/nocturne" }, { revision: "af5104c" }]) assert.throws(() => validatePlan({ ...plan, ...override }), /blocked/);
});
test("并发重跑同一仓库标签只模拟写入一次", async () => {
  const m = mock(); const results = await Promise.all([run(m), run(m), run(m)]); assert.equal(m.state.pushes, 1); assert.deepEqual(results.map(r => r.action).sort(), ["published", "skip", "skip"]);
});
test("第二次检查发现标签竞争冲突时阻断写入", async () => {
  const m = mock(), inspect = m.inspect; let n = 0;
  m.inspect = async (...args) => { const result = await inspect(...args); if (++n === 1) m.state.artifact = artifact({ revision: OTHER }); return result; };
  await assert.rejects(run(m), /blocked/); assert.equal(m.state.pushes, 0);
});
test("模拟推送已完成后抛异常，重跑识别既有标签不重复推送", async () => {
  const m = mock(), push = m.publisher.push;
  m.publisher.push = async () => { await push(); throw new Error("simulated lost response"); };
  await assert.rejects(run(m), /lost response/); assert.equal((await run(m)).action, "skip"); assert.equal(m.state.pushes, 1);
});
test("模拟推送后的错误 digest 必须报失败", async () => {
  const m = mock(), push = m.publisher.push;
  m.publisher.push = async () => { await push(); return { digest: "sha256:" + "0".repeat(64) }; };
  await assert.rejects(run(m), /blocked/); assert.equal(m.state.pushes, 1);
});
test("模拟推送后缺失平台不得报告成功", async () => {
  const m = mock(); m.publisher.push = async () => { m.state.pushes++; m.state.artifact = artifact({ architectures: ["amd64"] }); return { digest: m.state.artifact.digest }; };
  await assert.rejects(run(m), /blocked/); assert.equal(m.state.pushes, 1);
});
test("未提供显式认证或模拟器不得运行", async () => {
  assert.throws(() => createRegistryReader({ fetch: () => {} }), /blocked/);
  await assert.rejects(simulatePublication({ plan, inspect: () => {}, publisher: { push: () => {} } }), /blocked/);
});
test("生产工作流与开发基点逐字节一致", () => {
  const { execFileSync } = require("node:child_process");
  const original = execFileSync("git", ["show", "af5104c:.github/workflows/docker.yml"], { cwd: path.join(__dirname, "..") });
  assert.deepEqual(fs.readFileSync(path.join(__dirname, "../.github/workflows/docker.yml")), original);
});

function redirected(location = "https://pkg-containers.githubusercontent.com/blob", mode = "normal") {
  const a = artifact(), m = mock(a); let redirects = 0;
  const response = (b, status = 200, headers = {}) => new Response(b, { status, headers });
  const http = async (url, options) => {
    if (url.includes("/blobs/") || (mode === "manifest" && url.includes("/manifests/"))) {
      if (options.redirect === "error") throw new Error("fetch rejects redirect, as old GHCR reader did");
      return response(null, 307, location === null ? {} : { Location: location + "/" + url.split("/").pop() });
    }
    if (url.startsWith("https://pkg-containers.githubusercontent.com/") || url.startsWith("https://github-registry-files.githubusercontent.com/")) {
      redirects++; assert.equal(options.headers.Authorization, undefined); assert.equal(options.credentials, "omit"); assert.equal(options.method, "GET"); assert.equal(options.redirect, "manual");
      if (mode === "loop") return response(null, 307, { Location: url });
      return response(mode === "corrupt" ? Buffer.from("wrong") : a.objects.get(url.split("/").pop()), 200);
    }
    return m.http(url, options);
  };
  return { ...m, inspect: createRegistryReader({ fetch: http, authorization: "Bearer simulated-only" }), redirects: () => redirects };
}
test("GHCR blob 签名重定向剥离凭据并继续核验双架构 digest", async () => {
  const m = redirected(); assert.equal((await run(m)).action, "skip"); assert.equal(m.state.pushes, 0); assert.equal(m.redirects(), 2);
});
test("GHCR blob 第二个受限存储域兼容", async () => {
  const m = redirected("https://github-registry-files.githubusercontent.com/blob"); assert.equal((await run(m)).action, "skip"); assert.equal(m.state.pushes, 0);
});
for (const location of [null, "http://pkg-containers.githubusercontent.com/blob", "https://evil.test/blob", "https://pkg-containers.githubusercontent.com.evil.test/blob", "https://user:secret@pkg-containers.githubusercontent.com/blob", "https://pkg-containers.githubusercontent.com:8443/blob", "https://pkg-containers.githubusercontent.com/blob#fragment"]) test("GHCR blob 不安全重定向拒绝 " + String(location), async () => {
  const m = redirected(location); await assert.rejects(run(m), /blocked/); assert.equal(m.state.pushes, 0); assert.equal(m.redirects(), 0);
});
for (const mode of ["manifest", "loop", "corrupt"]) test("GHCR 重定向边界拒绝 " + mode, async () => {
  const m = redirected(undefined, mode); await assert.rejects(run(m), /blocked/); assert.equal(m.state.pushes, 0);
  assert.equal(m.redirects(), mode === "manifest" ? 0 : mode === "loop" ? 2 : 1);
});
