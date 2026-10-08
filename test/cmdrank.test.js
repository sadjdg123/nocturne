"use strict";
/* V1.1 命令面板排序：标题精确 > 标题前缀 > 别名 > 标题模糊 > 描述/地址；同层最近使用靠前；去重；输入归一 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const R = require("../public/cmdrank.js");

const items = [
  { id: "emby", title: "Emby", desc: "媒体服务器", lan: "http://192.168.1.20:8096", wan: "https://emby.example.com" },
  { id: "mp", title: "MoviePilot", desc: "影视订阅", lan: "http://192.168.1.21:3000", wan: "https://mp.example.com", aliases: ["mp", "影视订阅", "moviepilot"] },
  { id: "mpx", title: "MP3 Player", desc: "", wan: "https://music.example.com" },
  { id: "plex", title: "Plex", desc: "媒体库", lan: "http://192.168.1.20:32400" },
  { id: "px", title: "Proxy", desc: "", wan: "https://proxy.example.com", aliases: ["plex"] },
  { id: "amp", title: "Amplify", desc: "", wan: "https://amp.example.com" },
  { id: "qb", title: "qBittorrent", desc: "下载器 mp 配套", wan: "https://qb.example.com" },
];
const entries = (list) => list.map((i) => ({ item: i, urls: [i.wan || i.lan, i.lan, i.wan] }));
const ids = (q, recent, list = items) => R.rank(entries(list), q, recent).map((o) => o.entry.item.id);

test("C1: alias 'mp' hits MoviePilot at the top (title prefix of another item still beats alias)", () => {
  const r = R.rank(entries(items), "mp", []);
  // 「MP3 Player」标题前缀命中（第 4 层）> MoviePilot 别名精确（第 3 层）> Amplify 标题包含 > qBittorrent 描述
  assert.deepEqual(r.map((o) => o.entry.item.id).slice(0, 4), ["mpx", "mp", "amp", "qb"]);
  assert.equal(r[1].r.tier, 3); assert.equal(r[1].r.alias, "mp");
  // 没有标题以 mp 开头的项目时，MoviePilot 第一
  assert.equal(ids("mp", [], items.filter((i) => i.id !== "mpx"))[0], "mp");
  assert.equal(ids("影视", [])[0], "mp", "Chinese alias prefix");
  assert.equal(ids("MP", [])[1], "mp", "case-insensitive");
  assert.equal(ids("  mp  ", [])[1], "mp", "surrounding spaces ignored");
});

test("tiers: exact title > title prefix > alias > fuzzy title > desc/url", () => {
  assert.equal(R.score(items[0], "emby").tier, 5);
  assert.equal(R.score(items[1], "movie").tier, 4);
  assert.equal(R.score(items[1], "movie pilot").tier, 5, "spaces normalised: 'movie pilot' == 'MoviePilot'");
  assert.equal(R.score(items[1], "moviepilot").tier, 5);
  assert.equal(R.score(items[1], "影视订阅").tier, 3);
  assert.equal(R.score(items[1], "pilot").tier, 2);
  assert.equal(R.score(items[1], "mvplt").tier, 2, "subsequence fuzzy");
  assert.equal(R.score(items[0], "媒体").tier, 1, "desc");
  assert.equal(R.score(items[0], "8096", [items[0].lan]).tier, 1, "url");
  assert.equal(R.score(items[0], "zzz"), null);
  assert.equal(R.score(items[0], ""), null);
});

test("C2: an alias equal to another item's title ranks below that title; both shown once, no overwrite", () => {
  const r = R.rank(entries(items), "plex", []);
  assert.deepEqual(r.map((o) => o.entry.item.id).slice(0, 2), ["plex", "px"]);
  assert.equal(r[0].r.tier, 5); assert.equal(r[1].r.tier, 3); assert.equal(r[1].r.alias, "plex");
  // 同一个项目只出现一次（即使条目重复传入）
  const dup = R.rank(entries([items[3], items[3], items[4]]), "plex", []);
  assert.deepEqual(dup.map((o) => o.entry.item.id), ["plex", "px"]);
});

test("recent use breaks ties inside a tier only", () => {
  const two = [{ id: "a", title: "Nas One" }, { id: "b", title: "Nas Two" }];
  assert.deepEqual(ids("nas", [], two), ["a", "b"]);
  assert.deepEqual(ids("nas", ["b"], two), ["b", "a"], "same tier → recent first");
  // 但不会把低层的结果抬到高层前面
  assert.deepEqual(ids("plex", ["px"]).slice(0, 2), ["plex", "px"]);
});

test("aliases are inert text: odd input never throws and is not interpreted", () => {
  const evil = [{ id: "e", title: "Evil", aliases: ["<img src=x onerror=alert(1)>", "javascript:alert(1)", "", null, 5, "a".repeat(500)] }, { id: "n", title: null, desc: undefined, aliases: "not-an-array" }, null];
  assert.doesNotThrow(() => R.rank(entries(evil.filter(Boolean)).concat([{ item: null }, null]), "<img", []));
  assert.equal(ids("<img", [], evil.filter(Boolean))[0], "e");
  assert.equal(ids("not-an", [], evil.filter(Boolean)).length, 0, "a non-array aliases field is ignored");
});

test("palette wiring: '>' action mode, quick-open menu entry, visualViewport, ranking module", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /<script src="cmdrank\.js\?v=\d+"><\/script>/);
  assert.match(html, /R\.rank\(items\.map/);
  for (const k of ["net:auto", "net:lan", "net:wan", "recheck", "edit", "settings", "add"]) assert.ok(html.includes('k: "' + k + '"'), k);
  assert.match(html, /data-m="palette">快速打开</);
  assert.match(html, /visualViewport/);
  assert.match(html, /A\.recheck = function \(reset, cb\)/);
});
