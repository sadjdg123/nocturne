"use strict";
// 仅在隔离网络内写合成的空层 OCI 材料；硬性拒绝 GHCR/外部 URL。
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createRegistryReader, simulatePublication } = require("./image-publish-policy");
const base = process.argv[2]; assert.match(base || "", /^http:\/\/nc-registry-[a-f0-9-]+:5000$/);
const repo = "sadjdg123/nocturne", calls = [], hash = b => "sha256:" + crypto.createHash("sha256").update(b).digest("hex");
const media = { index: "application/vnd.oci.image.index.v1+json", manifest: "application/vnd.oci.image.manifest.v1+json", config: "application/vnd.oci.image.config.v1+json" };
async function local(route, options = {}) {
  const u = new URL(route, base); assert.equal(u.origin, base);
  const r = await fetch(u, { redirect: "error", ...options }); calls.push({ method: options.method || "GET", path: u.pathname, status: r.status }); return r;
}
async function upload(revision, tag, arches = ["amd64", "arm64"]) {
  const manifests = [];
  for (const architecture of arches) {
    const b = Buffer.from(JSON.stringify({ architecture, os: "linux", rootfs: { type: "layers", diff_ids: [] }, config: { Labels: { "org.opencontainers.image.revision": revision } } })), d = hash(b);
    const start = await local("/v2/" + repo + "/blobs/uploads/", { method: "POST" }); assert.equal(start.status, 202);
    const uploadURL = new URL(start.headers.get("Location"), base); uploadURL.searchParams.set("digest", d);
    const written = await local(uploadURL, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: b }); assert.equal(written.status, 201);
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: media.manifest, config: { mediaType: media.config, digest: d, size: b.length }, layers: [] }));
    const md = hash(manifest), r = await local("/v2/" + repo + "/manifests/" + md, { method: "PUT", headers: { "Content-Type": media.manifest }, body: manifest }); assert.equal(r.status, 201);
    manifests.push({ mediaType: media.manifest, digest: md, size: manifest.length, platform: { os: "linux", architecture } });
  }
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: media.index, manifests }));
  const r = await local("/v2/" + repo + "/manifests/" + tag, { method: "PUT", headers: { "Content-Type": media.index }, body: index }); assert.equal(r.status, 201); return hash(index);
}
const inspect = createRegistryReader({ authorization: "Bearer local-simulation-only", fetch: (url, options) => {
  assert.ok(["GET", "HEAD"].includes(options.method)); assert.ok(url.startsWith("https://ghcr.io/v2/")); return local(url.slice("https://ghcr.io".length), options);
} });
const plan = revision => ({ approved: true, repository: repo, ref: "refs/heads/v2", event: "push", revision, tags: ["sha-" + revision.slice(0, 7)] });
const results = [];
(async () => {
  for (let i = 0; i < 100; i++) { try { if ((await local("/v2/")).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const revision = "a".repeat(40), p = plan(revision); let writes = 0;
  const publisher = { simulation: true, push: async q => { writes++; return { digest: await upload(q.revision, q.tags[0]) }; } };
  const run = q => simulatePublication({ plan: q, inspect, publisher });
  assert.equal((await inspect(repo, p.tags[0])).absent, true); results.push("real MANIFEST_UNKNOWN absence");
  const r = await run(p); assert.equal(r.action, "published"); assert.equal(writes, 1); results.push("real config blob, child manifest and multi-platform index validation");
  assert.equal((await run(p)).action, "skip"); assert.equal(writes, 1); results.push("rerun skips existing tag without PUT");
  const collision = plan("a".repeat(7) + "b".repeat(33)); await assert.rejects(run(collision), /blocked/); assert.equal((await inspect(repo,p.tags[0])).digest, r.digest); assert.equal(writes, 1); results.push("short SHA collision blocked, digest unchanged");
  const concurrent = plan("c".repeat(40)); const actions = await Promise.all([run(concurrent),run(concurrent),run(concurrent)]); assert.deepEqual(actions.map(x=>x.action).sort(),["published","skip","skip"]); assert.equal(writes,2); results.push("three concurrent simulator requests write tag once");
  const lost = plan("d".repeat(40)); const unreliable = { simulation:true,push:async q=>{writes++;await upload(q.revision,q.tags[0]);throw Error("response lost");} };
  await assert.rejects(simulatePublication({plan:lost,inspect,publisher:unreliable}),/response lost/); const count=writes; assert.equal((await run(lost)).action,"skip");assert.equal(writes,count);results.push("successful tag write with lost response is not repeated");
  const missing=plan("e".repeat(40));await upload(missing.revision,missing.tags[0],["amd64"]);await assert.rejects(run(missing),/blocked/);assert.equal(writes,count);results.push("existing tag with missing architecture cannot be overwritten");
  const race=plan("f".repeat(40));let reads=0;const raced=async(...a)=>{const r=await inspect(...a);if(++reads===1)await upload("f".repeat(7)+"0".repeat(33),race.tags[0]);return r;};
  await assert.rejects(simulatePublication({plan:race,inspect:raced,publisher}),/blocked/);assert.equal(writes,count);results.push("competing external write between two checks blocks simulator");
  // 明确验证协议的剩余边界：绕过协调器的 V2 PUT 可覆盖，不能声称注册表提供 CAS。
  const changed=await upload(collision.revision,p.tags[0]);assert.notEqual(changed,r.digest);assert.equal((await inspect(repo,p.tags[0])).digest,changed);results.push("V2 accepts uncoordinated PUT overwrite: shared lock and writer restriction remain required");
  console.log(JSON.stringify({passed:results.length,failed:0,results,calls,externalRegistryWrites:0},null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
