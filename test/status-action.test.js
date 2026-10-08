"use strict";
/* V1.1 复查：命令面板状态动作。NAS 模式只读取服务端最近一次检测结果 →「刷新状态」，不宣称重新检测；静态模式保留浏览器检测 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const R = require("../public/cmdrank.js");

test("NAS mode label/hint say 刷新状态 and NAS 最近一次检测, never 重新检测", () => {
  const a = R.statusAction(true);
  assert.equal(a.t, "刷新状态");
  assert.match(a.d, /NAS 最近一次检测结果/);
  for (const s of [a.t, a.d, a.busy]) assert.doesNotMatch(s, /重新检测/);
});

test("static mode keeps browser re-check wording", () => {
  const a = R.statusAction(false);
  assert.equal(a.t, "重新检测状态");
  assert.match(a.d, /浏览器/);
  // 阶段 3：浏览器（no-cors）探测分不清在线与否 → 只说「可能在线 / 无法确认」，绝不说「在线 / 离线」
  const msg = R.statusReport(false, { on: 0, off: 0, maybe: 2, unknown: 1 });
  assert.equal(msg, "检测完成：2 个可能在线，1 个无法确认（浏览器检测无法确认真实状态）");
  assert.doesNotMatch(msg, /个在线|离线/);
});

test("NAS report names the time of the NAS check and does not claim a new check", () => {
  const at = new Date(2026, 9, 8, 14, 3, 7).toISOString();
  const msg = R.statusReport(true, { on: 5, off: 2 }, at);
  assert.equal(msg, "已刷新：5 个在线，2 个离线（NAS 14:03:07 的检测结果）");
  assert.doesNotMatch(msg, /重新检测|检测完成/);
  assert.equal(R.statusReport(true, { on: 0, off: 0 }, null), "已刷新：0 个在线，0 个离线（NAS 最近一次检测结果）");
});

test("latestCheck picks the newest checkedAt and ignores junk", () => {
  assert.equal(R.latestCheck({ a: { checkedAt: "2026-10-08T06:00:00.000Z" }, b: { checkedAt: "2026-10-08T06:00:30.000Z" }, c: {}, d: null, e: { checkedAt: "x" } }), "2026-10-08T06:00:30.000Z");
  assert.equal(R.latestCheck({}), null);
  assert.equal(R.latestCheck(null), null);
});

test("index.html wires the action through statusAction/statusReport (no hard-coded 重新检测 for NAS)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /NocturneRank\.statusAction\(nasMode\(\)\)/);
  assert.match(html, /statusReport\(true, d, at\)/);
  assert.doesNotMatch(html, /重新读取 NAS 的检测结果/);
});
