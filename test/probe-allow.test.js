"use strict";
/* PROBE_ALLOW（普通账户的探测白名单）：DNS 返回混合地址、端口限制、通配符边界。
 * 本文件在 require server.js 之前设好 PROBE_ALLOW，并替换 dns.promises.lookup 模拟解析结果（node --test 每个文件一个进程，互不影响）。 */
process.env.PROBE_ALLOW = "192.168.1.0/24, 10.0.0.0/8:8096, *.lan, nas.home.arpa:5000, [fd00::/8]";
const test = require("node:test");
const assert = require("node:assert/strict");
const dns = require("node:dns");
const S = require("../server.js");

const fakeDns = new Map();
dns.promises.lookup = async (host) => {
  if (!fakeDns.has(host)) { const e = new Error("ENOTFOUND"); e.code = "ENOTFOUND"; throw e; }
  return fakeDns.get(host).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};
const vet = (u) => S.vetTarget(new URL(u));

test("mixed DNS results: every resolved address must be inside an IP/CIDR rule", async () => {
  fakeDns.set("all-lan.example.net", ["192.168.1.5", "192.168.1.6"]);
  fakeDns.set("mixed.example.net", ["192.168.1.5", "8.8.8.8"]);
  fakeDns.set("mixed6.example.net", ["192.168.1.5", "2001:db8::1"]);
  fakeDns.set("meta.example.net", ["192.168.1.5", "169.254.169.254"]);
  fakeDns.set("mapped-meta.example.net", ["192.168.1.5", "::ffff:169.254.169.254"]);
  assert.equal((await vet("http://all-lan.example.net/")).userAllowed, true);
  const m = await vet("http://mixed.example.net/");
  assert.ok(m.addrs, "admins may still probe it"); assert.equal(m.userAllowed, false, "one address outside the CIDR → not allowed for normal users");
  assert.equal((await vet("http://mixed6.example.net/")).userAllowed, false);
  assert.ok((await vet("http://meta.example.net/")).blocked, "any always-blocked address blocks the whole target");
  assert.ok((await vet("http://mapped-meta.example.net/")).blocked);
});

test("port restrictions", async () => {
  fakeDns.set("box.example.net", ["10.1.2.3"]);
  assert.equal((await vet("http://box.example.net:8096/")).userAllowed, true);
  assert.equal((await vet("http://box.example.net:8097/")).userAllowed, false, "10.0.0.0/8 only on :8096");
  assert.equal((await vet("http://box.example.net/")).userAllowed, false, "default port 80 ≠ 8096");
  assert.equal((await vet("https://box.example.net/")).userAllowed, false, "default port 443 ≠ 8096");
  fakeDns.set("nas.home.arpa", ["192.168.9.9"]);
  assert.equal((await vet("http://nas.home.arpa:5000/")).userAllowed, true);
  assert.equal((await vet("http://nas.home.arpa:5001/")).userAllowed, false);
  assert.equal((await vet("https://nas.home.arpa/")).userAllowed, false);
  // 规则自身的端口语法
  const r = S.parseProbeAllow("*:443 192.168.1.1:0 192.168.1.1:70000 host:65535");
  assert.deepEqual(r.map((x) => x.raw), ["*:443", "host:65535"], "out-of-range ports rejected");
  const A = (u) => S.probeAllowed(new URL(u), [{ address: "1.1.1.1" }], r);
  assert.equal(A("https://anything.example/"), true, "*:443 matches default https port");
  assert.equal(A("http://anything.example/"), false);
  assert.equal(A("http://host:65535/"), true);
});

test("wildcard boundaries: *.lan", async () => {
  const rules = S.parseProbeAllow("*.lan");
  const A = (h) => S.probeAllowed(new URL("http://" + h + "/"), [{ address: "8.8.8.8" }], rules);
  assert.equal(A("nas.lan"), true);
  assert.equal(A("a.b.lan"), true);
  assert.equal(A("NAS.LAN."), true, "case / trailing dot");
  assert.equal(A("lan"), false, "bare apex is not a subdomain");
  assert.equal(A("evil-lan"), false);
  assert.equal(A("xlan"), false);
  assert.equal(A("evil.xlan"), false);
  assert.equal(A("lan.evil.com"), false);
  assert.equal(A("nas.lan.evil.com"), false);
  // vetTarget path with the env rules: host rule matches by hostname, but always-block still wins
  fakeDns.set("tv.lan", ["192.168.50.2"]);
  fakeDns.set("bad.lan", ["169.254.169.254"]);
  fakeDns.set("evil-lan", ["192.168.50.2"]);
  assert.equal((await vet("http://tv.lan:8080/")).userAllowed, true);
  assert.ok((await vet("http://bad.lan/")).blocked);
  assert.equal((await vet("http://evil-lan/")).userAllowed, false, "evil-lan does not match *.lan, and 192.168.50.2 is outside 192.168.1.0/24");
});
