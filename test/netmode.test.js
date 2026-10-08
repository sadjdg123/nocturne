"use strict";
/* V1.1 网络地址选择：自动判定（只看访问主机名）、存储迁移、单项目回退 / 无效地址 */
const test = require("node:test");
const assert = require("node:assert/strict");
const NM = require("../public/netmode.js");
const U = require("../public/urlcheck.js");

test("decide(): private / loopback / link-local / local names → lan", () => {
  for (const h of ["10.0.0.5", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.1.10", "127.0.0.1", "169.254.3.4",
    "localhost", "LOCALHOST", "nas.lan", "nas.local", "nas.local.", "nas.home.arpa", "box.sub.home.arpa",
    "::1", "[::1]", "fd12:3456::1", "[fd00::5]", "fc00::1", "fe80::1", "[fe80::1ff:fe23:4567:890a]", "::ffff:192.168.1.2", "[::ffff:c0a8:101]"]) {
    assert.equal(NM.decide(h), "lan", h);
  }
});

test("decide(): public, Tailscale, CGNAT, look-alikes, garbage → wan", () => {
  for (const h of ["nas.example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.1.1", "11.0.0.1", "100.64.0.1", "100.100.100.100", "100.127.255.254",
    "nas.tail1234.ts.net", "ts.net", "2001:db8::1", "[2606:4700::1111]", "::ffff:8.8.8.8", "[::ffff:808:808]", "lan.example.com", "mylan", "local", "home.arpa.evil.com",
    "localhost.example.com", "999.1.1.1", "192.168.1", "", null, undefined, "fe7f::1", "fec0::1"]) {
    assert.equal(NM.decide(h), "wan", String(h));
  }
});

test("migrate(): existing lan/wan kept; fresh/invalid → auto", () => {
  assert.equal(NM.migrate("lan"), "lan");
  assert.equal(NM.migrate("wan"), "wan");
  assert.equal(NM.migrate("auto"), "auto");
  for (const bad of [undefined, null, "", "LAN", "xyz", 1, {}, []]) assert.equal(NM.migrate(bad), "auto", JSON.stringify(bad));
  assert.equal(NM.norm("bogus"), null);
});

test("effective()/label(): auto follows the page hostname only; explicit modes ignore it", () => {
  assert.equal(NM.effective("auto", "192.168.1.10"), "lan");
  assert.equal(NM.effective("auto", "nas.example.com"), "wan");
  assert.equal(NM.effective("lan", "nas.example.com"), "lan");
  assert.equal(NM.effective("wan", "192.168.1.10"), "wan");
  assert.equal(NM.effective(undefined, "10.0.0.1"), "lan", "fresh device behaves as auto");
  assert.equal(NM.label("auto", "nas.example.com"), "自动·外网");
  assert.equal(NM.label("auto", "nas.local"), "自动·内网");
  assert.equal(NM.label("lan", "x"), "内网");
  assert.equal(NM.label("wan", "x"), "外网");
});

test("pick(): preferred address, single-address fallback, invalid / unsafe never chosen", () => {
  const both = { lan: "http://192.168.1.20:8096", wan: "https://emby.example.com" };
  assert.deepEqual(NM.pick(both, "lan", U.safeNav), { url: both.lan, kind: "lan", fallback: false });
  assert.deepEqual(NM.pick(both, "wan", U.safeNav), { url: both.wan, kind: "wan", fallback: false });
  const lanOnly = { lan: "http://192.168.1.20:8096", wan: "" };
  assert.deepEqual(NM.pick(lanOnly, "wan", U.safeNav), { url: lanOnly.lan, kind: "lan", fallback: true });
  const wanOnly = { lan: "", wan: "https://x.example.com" };
  assert.deepEqual(NM.pick(wanOnly, "lan", U.safeNav), { url: wanOnly.wan, kind: "wan", fallback: true });
  // 无效 / 不安全的那个当作没填
  assert.equal(NM.pick({ lan: "javascript:alert(1)", wan: "https://ok.example.com" }, "lan", U.safeNav).url, "https://ok.example.com");
  assert.equal(NM.pick({ lan: "http://10.0.0.1", wan: " https://bad.example.com" }, "wan", U.safeNav).url, "http://10.0.0.1");
  for (const it of [{ lan: "", wan: "" }, { lan: "javascript:alert(1)", wan: "data:text/html,x" }, {}, null]) {
    const r = NM.pick(it, "lan", U.safeNav);
    assert.equal(r.url, ""); assert.equal(r.kind, null);
  }
});

test("browser global + index.html wiring: A.url is the single selector and uses netmode", () => {
  const fs = require("node:fs"), path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /<script src="netmode\.js\?v=\d+"><\/script>/);
  assert.equal((html.match(/A\.url = function/g) || []).length, 1, "exactly one address selector");
  assert.match(html, /NM\.pick\(item, mode\(\), A\.util\.url\.safeNav\)/);
  assert.doesNotMatch(html, /settings\.net === "lan" \? "lan" : "wan"/, "no second, forked lan/wan selection left");
  const nc = fs.readFileSync(path.join(__dirname, "..", "public", "nocturne.js"), "utf8");
  assert.match(nc, /this === st\.settings && k === "net"\) return undefined/, "settings.net stays out of the synced snapshot");
  assert.match(nc, /k === "recent"\) return undefined/, "recent stays out of the synced snapshot");
});
