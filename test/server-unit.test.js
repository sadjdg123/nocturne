"use strict";
/* server.js 内部规则的单元测试（require 时不启动服务） */
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../server.js");

test("password policy: new passwords ≥ 8", () => {
  assert.equal(S.PASS_MIN, 8);
  assert.equal(S.validPass("1234567"), false);
  assert.equal(S.validPass("12345678"), true);
  assert.equal(S.validPass("x".repeat(201)), false);
});

test("normIp unwraps IPv4-mapped / compatible / NAT64", () => {
  assert.equal(S.normIp("::ffff:169.254.169.254"), "169.254.169.254");
  assert.equal(S.normIp("::ffff:a9fe:a9fe"), "169.254.169.254");
  assert.equal(S.normIp("64:ff9b::a9fe:a9fe"), "169.254.169.254");
  assert.equal(S.normIp("64:ff9b:1::a9fe:a9fe"), "169.254.169.254");
  assert.equal(S.normIp("::ffff:192.168.1.2"), "192.168.1.2");
  assert.equal(S.normIp("fd00::1"), "fd00::1");
});

test("TRUSTED_PROXY_CIDRS parsing", () => {
  const t = S.parseCidrList("172.17.0.1, 192.168.1.0/24 fd00::/8 [::1] bogus 10.0.0.0/99");
  assert.deepEqual(t.list, ["172.17.0.1/32", "192.168.1.0/24", "fd00::/8", "::1/128"]);
  assert.equal(t.has("172.17.0.1"), true);
  assert.equal(t.has("::ffff:172.17.0.1"), true);
  assert.equal(t.has("172.17.0.2"), false);
  assert.equal(t.has("192.168.1.77"), true);
  assert.equal(t.has("fd12::3"), true);
  assert.equal(t.has("not-an-ip"), false);
  assert.equal(S.parseCidrList("").list.length, 0);
});

test("vetTarget always blocks metadata / link-local / unspecified incl. IPv6 variants", async () => {
  const blocked = ["http://169.254.169.254/", "http://[::ffff:169.254.169.254]/", "http://[::ffff:a9fe:a9fe]/", "http://[64:ff9b::a9fe:a9fe]/",
    "http://[fe80::1]/", "http://0.0.0.0/", "http://[::]/", "http://100.100.100.200/", "http://metadata.google.internal/", "http://[fd00:ec2::254]/"];
  for (const u of blocked) {
    const v = await S.vetTarget(new URL(u));
    assert.ok(v.blocked, "should block " + u + " got " + JSON.stringify(v));
  }
  const ok = await S.vetTarget(new URL("http://192.168.1.20:8096/"));
  assert.ok(ok.addrs && ok.addrs[0].address === "192.168.1.20");
  const lo = await S.vetTarget(new URL("http://127.0.0.1:19999/"));
  assert.ok(lo.addrs, "loopback on another port is allowed for admins");
});

test("PROBE_ALLOW rules: CIDR / host / wildcard / port", () => {
  const rules = S.parseProbeAllow("192.168.1.0/24, nas.lan:5000 *.home.arpa [fd00::1]:80 *:8096 bad/entry/x");
  assert.equal(rules.length, 5);
  const A = (u, ips) => S.probeAllowed(new URL(u), ips.map((a) => ({ address: a })), rules);
  assert.equal(A("http://192.168.1.20:8096/", ["192.168.1.20"]), true);
  assert.equal(A("http://evil.example/", ["192.168.1.20", "10.0.0.5"]), false, "every resolved address must be inside the CIDR");
  assert.equal(A("http://192.168.2.1/", ["192.168.2.1"]), false);
  assert.equal(A("http://nas.lan:5000/", ["10.9.9.9"]), true);
  assert.equal(A("http://nas.lan:5001/", ["10.9.9.9"]), false, "port must match");
  assert.equal(A("http://jelly.home.arpa/", ["10.1.1.1"]), true);
  assert.equal(A("http://home.arpa.evil.com/", ["10.1.1.1"]), false);
  assert.equal(A("http://[fd00::1]/", ["fd00::1"]), true);
  assert.equal(A("http://10.0.0.9:8096/", ["10.0.0.9"]), true, "*:8096");
  // default: module-level PROBE_ALLOW is empty → nothing allowed for non-admins
  assert.equal(S.probeAllowed(new URL("http://192.168.1.20/"), [{ address: "192.168.1.20" }]), false);
});

test("icon search params are whitelisted and canonicalised", () => {
  assert.equal(S.canonicalSearch("?limit=48&query=emby&prefixes=selfhst,mdi"), "?query=emby&limit=48&prefixes=selfhst%2Cmdi");
  assert.equal(S.canonicalSearch("?query=emby&evil=1"), null);
  assert.equal(S.canonicalSearch("?query=" + "a".repeat(101)), null);
  assert.equal(S.canonicalSearch("?limit=48"), null);
  assert.equal(S.canonicalSearch("?query=a&query=b"), null);
  assert.equal(S.canonicalSearch("?" + "x".repeat(700)), null);
});
