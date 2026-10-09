"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { checkWorkflow, checkDockerConfig } = require("../tools/engineering/check-ci"), { check } = require("../tools/engineering/assert-tap");
const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, "../.github/workflows/engineering-verify.yml")));
test("验证工作流只有隔离分支和读取权限", () => assert.equal(checkWorkflow(workflow), true));
for (const [name, change] of [
  ["job 不可用的 runner context", x => { x.jobs.linux.env.DOCKER_CONFIG = "${{ runner.temp }}/nocturne-docker-${{ matrix.arch }}"; }],
  ["根镜像写权限", x => { x.permissions.packages = "write"; }],
  ["job 写权限", x => { x.jobs.linux.permissions.packages = "write"; }],
  ["main 触发", x => { x.on.push.branches.push("main"); }],
  ["v2 触发", x => { x.on.push.branches.push("v2"); }],
  ["tag 触发", x => { x.on.push.tags = ["v*"]; }],
  ["PR 触发", x => { x.on.pull_request = {}; }],
  ["凭据保留", x => { x.jobs.linux.steps[0].with["persist-credentials"] = true; }],
  ["登录动作", x => { x.jobs.linux.steps.push({ uses: "docker/login-action@v3" }); }],
  ["镜像推送", x => { x.jobs.linux.steps.push({ run: "docker push local:test" }); }],
  ["构建推送", x => { x.jobs.linux.steps.push({ run: "docker buildx build --push ." }); }],
  ["注册表导出", x => { x.jobs.linux.steps.push({ run: "docker buildx build --output type=registry ." }); }],
  ["注入 token", x => { x.jobs.linux.steps.push({ run: "echo $GH_TOKEN" }); }],
  ["job 环境凭据", x => { x.jobs.linux.env.GH_TOKEN = "${{ secrets.PUBLISH_TOKEN }}"; }],
  ["根环境凭据", x => { x.env = { TOKEN: "${{ secrets.PUBLISH_TOKEN }}" }; }],
]) test("CI 门禁拒绝 " + name, () => { const x = structuredClone(workflow); change(x); assert.throws(() => checkWorkflow(x)); });
test("独立 Docker 配置允许空凭据和本地 CLI 插件", () => assert.equal(checkDockerConfig({ cliPluginsExtraDirs: ["/local/plugins"] }), true));
for (const config of [{ credsStore: "desktop" }, { credHelpers: { "ghcr.io": "helper" } }, { auths: { "ghcr.io": { auth: "fake" } } }]) test("独立 Docker 配置拒绝凭据 " + JSON.stringify(config), () => assert.throws(() => checkDockerConfig(config)));
const tap = "# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
test("TAP 门禁接受全部通过", () => assert.equal(check(tap).tests, 1));
for (const k of ["fail", "cancelled", "skipped", "todo"]) test("TAP 门禁拒绝 " + k, () => assert.throws(() => check(tap.replace("# " + k + " 0", "# " + k + " 1"))));
test("TAP 门禁拒绝缺失汇总及只有部分成功", () => { assert.throws(() => check("ok 1")); assert.throws(() => check(tap.replace("# tests 1", "# tests 2"))); });
