"use strict";
// 未接入发布工作流。HTTP 读取和发布动作只来自显式注入的模拟适配器，无默认网络/推送实现。
const crypto = require("node:crypto");
const digest = b => "sha256:" + crypto.createHash("sha256").update(b).digest("hex");
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INDEX = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
const MANIFEST = ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"];
const fail = reason => { throw new Error("publication blocked: " + reason); };
const queues = new Map();
function validatePlan(plan) {
  if (plan.approved !== true) fail("explicit publication approval required");
  if (plan.repository !== "sadjdg123/nocturne" || plan.event !== "push" || plan.ref !== "refs/heads/v2") fail("unapproved repository/event/ref");
  if (!/^[0-9a-f]{40}$/.test(plan.revision)) fail("full revision required");
  if (!Array.isArray(plan.tags) || plan.tags.length !== 1 || plan.tags[0] !== "sha-" + plan.revision.slice(0, 7)) fail("only exact immutable SHA tag allowed");
  return { ...plan, tags: [...plan.tags] };
}
function createRegistryReader({ fetch: request, authorization, timeoutMs = 10000 }) {
  if (typeof request !== "function" || typeof authorization !== "string" || !/^Bearer \S+$/.test(authorization)) fail("explicit scoped authentication and HTTP adapter required");
  async function get(route, method = "GET") {
    let r, url = "https://ghcr.io" + route;
    const signal = AbortSignal.timeout(timeoutMs), accept = [...INDEX, ...MANIFEST].join(", ");
    try {
      r = await request(url, { method, redirect: "manual", signal, headers: { Authorization: authorization, Accept: accept } });
      for (let n = 0; [301, 302, 303, 307, 308].includes(r.status); n++) {
        // GHCR config blob 使用签名存储重定向；不允许标签/清单重定向，也不转发 Bearer。
        if (!/^\/v2\/sadjdg123\/nocturne\/blobs\/sha256:[0-9a-f]{64}$/.test(route) || n >= 2 || !r.headers.get("Location")) fail("unsafe registry redirect");
        const target = new URL(r.headers.get("Location"), url);
        if (target.protocol !== "https:" || target.username || target.password || target.port || target.hash ||
            !["pkg-containers.githubusercontent.com", "github-registry-files.githubusercontent.com"].includes(target.hostname)) fail("unsafe registry redirect");
        url = target.href;
        r = await request(url, { method, redirect: "manual", signal, headers: { Accept: accept }, credentials: "omit" });
      }
    } catch (_) { fail("registry transport or redirect failure"); }
    if (![200, 404].includes(r.status)) fail("registry HTTP " + r.status);
    return r;
  }
  async function content(r, expected, size) {
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > (4 << 20) || (size !== undefined && b.length !== size)) fail("invalid object size");
    if (!DIGEST.test(expected) || digest(b) !== expected) fail("object digest mismatch");
    const header = r.headers.get("Docker-Content-Digest");
    if (header && header !== expected) fail("response digest mismatch");
    try { return JSON.parse(b.toString("utf8")); } catch (_) { fail("invalid object JSON"); }
  }
  return async function inspect(repository, tag) {
    if (repository !== "sadjdg123/nocturne" || !/^sha-[a-f0-9]{7}$/.test(tag)) fail("unsafe lookup");
    const api = await get("/v2/");
    if (api.status !== 200 || api.headers.get("Docker-Distribution-API-Version") !== "registry/2.0") fail("authenticated V2 API unconfirmed");
    const base = "/v2/" + repository;
    const head = await get(base + "/manifests/" + tag, "HEAD");
    const body = await get(base + "/manifests/" + tag);
    if (head.status === 404 && body.status === 404) {
      let error; try { error = await body.json(); } catch (_) { fail("ambiguous 404"); }
      if (!Array.isArray(error.errors) || error.errors.length !== 1 || error.errors[0].code !== "MANIFEST_UNKNOWN") fail("absence unconfirmed");
      return { absent: true };
    }
    if (head.status !== 200 || body.status !== 200) fail("registry changed during lookup");
    const d = head.headers.get("Docker-Content-Digest");
    const index = await content(body, d);
    if (index.schemaVersion !== 2 || !INDEX.includes(index.mediaType) || !Array.isArray(index.manifests)) fail("multi-platform index required");
    const platforms = new Map();
    for (const child of index.manifests) {
      // Buildx 的显式 attestation 条目不作为可运行架构。
      if (child.annotations?.["vnd.docker.reference.type"] === "attestation-manifest" && child.platform?.os === "unknown" && child.platform?.architecture === "unknown") continue;
      const arch = child.platform?.architecture;
      if (child.platform?.os !== "linux" || !["amd64", "arm64"].includes(arch) || platforms.has(arch) || !MANIFEST.includes(child.mediaType)) fail("unexpected/duplicate platform");
      if (!DIGEST.test(child.digest) || !Number.isSafeInteger(child.size) || child.size < 1) fail("invalid manifest descriptor");
      const response = await get(base + "/manifests/" + child.digest);
      if (response.status !== 200) fail("missing child manifest");
      const manifest = await content(response, child.digest, child.size);
      if (manifest.schemaVersion !== 2 || !MANIFEST.includes(manifest.mediaType)) fail("invalid child manifest");
      const cfg = manifest.config;
      if (!cfg || !DIGEST.test(cfg.digest) || !Number.isSafeInteger(cfg.size) || cfg.size < 1) fail("invalid config descriptor");
      const configResponse = await get(base + "/blobs/" + cfg.digest);
      if (configResponse.status !== 200) fail("missing config");
      const config = await content(configResponse, cfg.digest, cfg.size);
      const revision = config.config?.Labels?.["org.opencontainers.image.revision"];
      if (config.os !== "linux" || config.architecture !== arch || !/^[a-f0-9]{40}$/.test(revision)) fail("platform/revision config mismatch");
      platforms.set(arch, revision);
    }
    if (platforms.size !== 2 || new Set(platforms.values()).size !== 1) fail("both platforms must have the same full revision");
    return { absent: false, digest: d, revision: platforms.get("amd64"), architectures: [...platforms.keys()].sort() };
  };
}
// 仅验证未来接入协议；publisher 必须是模拟器，不提供真实 GHCR 写入适配器。
async function simulatePublication({ plan, inspect, publisher }) {
  plan = validatePlan(plan);
  if (typeof inspect !== "function" || publisher?.simulation !== true || typeof publisher.push !== "function") fail("simulation adapters required");
  const key = plan.repository + ":" + plan.tags[0];
  const previous = queues.get(key) || Promise.resolve();
  let release; const hold = new Promise(resolve => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => hold); queues.set(key, queued);
  await previous.catch(() => {});
  try {
    const check = async () => {
      const existing = await inspect(plan.repository, plan.tags[0]);
      if (existing?.absent === true) return null;
      if (existing?.absent !== false || !DIGEST.test(existing.digest) || existing.revision !== plan.revision ||
          JSON.stringify(existing.architectures) !== '["amd64","arm64"]') fail("existing tag collision or unknown state");
      return { action: "skip", digest: existing.digest };
    };
    const existing = await check(); if (existing) return existing;
    // 紧邻模拟写入再检查，失败/冲突不得降级为“标签不存在”。
    const raced = await check(); if (raced) return raced;
    const written = await publisher.push(plan);
    if (!DIGEST.test(written?.digest)) fail("publisher did not return index digest");
    const confirmed = await check();
    if (!confirmed || confirmed.digest !== written.digest) fail("post-publication verification failed");
    return { action: "published", digest: confirmed.digest };
  } finally {
    release(); if (queues.get(key) === queued) queues.delete(key);
  }
}
module.exports = { validatePlan, createRegistryReader, simulatePublication };
