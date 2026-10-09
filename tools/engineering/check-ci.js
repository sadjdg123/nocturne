"use strict";
// 新工作流使用 JSON（YAML 的子集），可用内置解析器失败关闭，不给生产增加依赖。
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const ROOT = path.join(__dirname, "../..");
const CHECKOUT = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const UPLOAD = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
function checkWorkflow(doc) {
  assert.ok(!/secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN|credsStore|credHelpers/i.test(JSON.stringify(doc)), "整个工作流不得注入发布凭据");
  assert.deepEqual(doc.on, { push: { branches: ["verify/phase2-engineering"] } }, "只能触发隔离分支 push");
  const permissions = p => assert.deepEqual(p, { contents: "read", packages: "none" }, "只允许读取代码，不允许镜像写权限");
  permissions(doc.permissions);
  assert.deepEqual(Object.keys(doc.jobs).sort(), ["linux", "preflight"]);
  for (const job of Object.values(doc.jobs)) {
    permissions(job.permissions); assert.ok(!job.uses && !job.container && !job.services && !job.secrets && !job.environment);
    for (const s of job.steps) {
      if (s.uses) {
        assert.ok([CHECKOUT, UPLOAD].includes(s.uses), "不允许登录/推送动作或未审核 action");
        if (s.uses === CHECKOUT) assert.deepEqual(s.with, { "fetch-depth": 0, "persist-credentials": false });
      }
      assert.ok(!/secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN|docker\s+(login|push)|--push|type\s*=\s*registry|build-push-action/i.test(JSON.stringify(s)), "拒绝凭据及发布入口");
    }
  }
  assert.deepEqual(doc.jobs.linux.strategy.matrix.include, [{ arch: "amd64", runner: "ubuntu-24.04" }, { arch: "arm64", runner: "ubuntu-24.04-arm" }]);
  assert.equal(doc.jobs.linux.env.DOCKER_CONFIG, "${{ runner.temp }}/nocturne-docker-${{ matrix.arch }}");
  return true;
}
function checkDockerConfig(config) {
  assert.ok(config && typeof config === "object" && !Array.isArray(config));
  assert.ok(!config.credsStore && !config.credHelpers, "禁止继承注册表凭据提供者");
  assert.equal(Object.keys(config.auths || {}).length, 0, "禁止注册表登录凭据");
  return true;
}
if (require.main === module) {
  checkWorkflow(JSON.parse(fs.readFileSync(path.join(ROOT, ".github/workflows/engineering-verify.yml"), "utf8")));
  assert.deepEqual(fs.readFileSync(path.join(ROOT, ".github/workflows/docker.yml")), execFileSync("git", ["show", "af5104c:.github/workflows/docker.yml"], { cwd: ROOT }), "现有发布工作流必须逐字节不变");
  if (process.argv.includes("--docker")) {
    assert.ok(process.env.DOCKER_CONFIG, "验证必须使用独立 Docker 配置");
    const file = path.join(process.env.DOCKER_CONFIG, "config.json"); checkDockerConfig(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
  }
  console.log("engineering CI: isolated ref, packages:none, no publication or persisted credentials");
}
module.exports = { checkWorkflow, checkDockerConfig };
