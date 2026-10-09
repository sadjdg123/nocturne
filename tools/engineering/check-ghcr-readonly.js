"use strict";
// 仅匿名 pull scope；不读取环境 token，不提供任何写入适配器。签名 URL 和 Bearer 均不输出。
const assert = require("node:assert/strict"), { createRegistryReader } = require("../image-publish-policy");
(async () => {
  const tag = process.argv[2] || "sha-f516629"; assert.match(tag, /^sha-[a-f0-9]{7}$/);
  const tokenResponse = await fetch("https://ghcr.io/token?service=ghcr.io&scope=repository:sadjdg123/nocturne:pull", { redirect: "error", signal: AbortSignal.timeout(10000) });
  assert.equal(tokenResponse.status, 200); const { token } = await tokenResponse.json(); assert.ok(token);
  const calls = [], reader = createRegistryReader({ authorization: "Bearer " + token, fetch: async (url, options) => {
    assert.ok(["GET", "HEAD"].includes(options.method));
    const r = await fetch(url, options), u = new URL(url);
    calls.push({ method: options.method, host: u.host, path: u.host === "ghcr.io" ? u.pathname : "[signed blob path omitted]", status: r.status, bearerSent: !!options.headers.Authorization });
    return r;
  } });
  console.log(JSON.stringify({ tag, scope: "repository:sadjdg123/nocturne:pull", result: await reader("sadjdg123/nocturne", tag), calls }, null, 2));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
