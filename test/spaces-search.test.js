"use strict";
/* V2.0 阶段 2 · 搜索与 ⌘K 命令面板跨空间（纯静态 file://，jsdom 真实运行页面）：
 * 在任何空间里都搜全部项目、标出所在分组；别名 / 分层排序 / '>' 操作 / 备用地址 / A.url 不退化；
 * 「切换到空间：X」「管理空间」只在操作里、排在服务之后；打开不在当前空间的项目照样记最近使用；分组不在当前空间时回到「全部」再定位；
 * 首页搜索引擎栏照旧独立。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openStatic, SKIP, sleep, ROOT } = require("./browser");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
const URL_FILE = "file://" + path.join(ROOT, "public", "index.html");
function device(sel) {
  const d = structuredClone(FIX);
  d.groups[1].items[0].aliases = ["mp", "影视订阅"]; // MoviePilot
  d.spaces = [{ id: "s-nas", name: "NAS", groupIds: ["st0rage9kq2"] }, { id: "s-fun", name: "娱乐", groupIds: ["mzq1a0lq8x2"] }, { id: "s-empty", name: "空的", groupIds: [] }];
  const st = { "yeqv.v1": JSON.stringify(d) };
  if (sel) st["nocturne.space:~local"] = sel;
  return st;
}
const opt = { skip: SKIP, timeout: 60000 };

async function pal(p, q) {
  const { win } = p, doc = win.document;
  if (!doc.querySelector(".x-cmdk.is-on")) p.A.palette.open("");
  const inp = doc.querySelector(".x-cmdk input");
  inp.value = q; inp.dispatchEvent(new win.Event("input"));
  await sleep(5);
  return [...doc.querySelectorAll(".x-cmdk-list > *")].map((el) => el.classList.contains("x-cmdk-sec") ? "§" + el.textContent : (el.querySelector(".x-cmdk-t b") || el).textContent + " | " + ((el.querySelector(".x-cmdk-tag") || {}).textContent || ""));
}

test("palette searches ALL items from inside an empty space; group names, aliases, tiers, alt addresses, A.url intact", opt, async (t) => {
  const p = await openStatic({ url: URL_FILE, storage: device("s-empty") });
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  assert.deepEqual(p.errors, []);
  assert.ok(doc.querySelector(".x-sempty"), "current space is empty");
  let r = await pal(p, "emby");
  assert.match(r[1], /^Emby \| 服务 · 影音$/, "item from another space, with its group");
  r = await pal(p, "mp");
  const items = r.filter((x) => /\| 服务 ·/.test(x)).map((x) => x.split(" | ")[0]);
  assert.equal(items[0], "MoviePilot", "alias tier still ranks MoviePilot first for 'mp'");
  assert.ok(doc.querySelector(".x-cmdk-row small").textContent.includes("别名：mp"));
  // alt addresses (lan + wan) appear under the selected item
  r = await pal(p, "emby");
  assert.ok(r.some((x) => /^用内网地址打开/.test(x)) && r.some((x) => /^用外网地址打开/.test(x)), "备用地址 rows");
  // running an item NOT in the current space opens A.url and records 最近使用
  const before = A.state.recent.slice();
  doc.querySelector(".x-cmdk-row").dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
  assert.equal(A.state.recent[0], "e7h2kq9b1m", "recent recorded although the tile is not on screen");
  assert.notDeepEqual(A.state.recent, before);
  assert.ok((win.__opened || []).some((u) => u.startsWith("http://192.168.1.20:8096")), "opened with A.url (lan preferred on this device)");
  assert.equal(A.spaces.selected(), "s-empty", "opening an item does not switch space");
});

test("'>' actions include 切换到空间：X and 管理空间; in normal search they rank after items; running them works", opt, async (t) => {
  const p = await openStatic({ url: URL_FILE, storage: device("s-fun") });
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  let r = await pal(p, ">");
  const acts = r.filter((x) => !x.startsWith("§")).map((x) => x.split(" | ")[0]);
  for (const a of ["自动网络", "优先内网", "优先外网", "进入编辑", "打开设置", "添加项目", "切换到空间：全部", "切换到空间：NAS", "切换到空间：娱乐", "切换到空间：空的", "管理空间"]) assert.ok(acts.includes(a), "action " + a);
  assert.ok(acts.some((a) => /刷新状态|重新检测状态/.test(a)));
  r = await pal(p, ">nas");
  assert.equal(r[1].split(" | ")[0], "切换到空间：NAS");
  // normal query "nas": service results first, then group, then actions (space switch never crowds out items)
  r = await pal(p, "nas");
  const kinds = r.filter((x) => !x.startsWith("§")).map((x) => x.split(" | ")[1]);
  const firstAction = kinds.findIndex((k) => k === "操作"), lastItem = kinds.map((k) => /^服务/.test(k)).lastIndexOf(true);
  assert.ok(lastItem > -1 && firstAction > lastItem, "items before actions: " + kinds.join(","));
  const empty = await pal(p, "");
  assert.ok(!empty.some((x) => /切换到空间/.test(x)), "empty query: unchanged V1.1 suggestions (no space list)");
  // run 切换到空间：NAS
  await pal(p, ">切换到空间 nas");
  doc.querySelector(".x-cmdk-row").dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(A.spaces.selected(), "s-nas");
  assert.match(doc.getElementById("x-toast-msg").textContent, /已切换到「NAS」/);
  // run 管理空间
  await pal(p, ">管理空间");
  doc.querySelector(".x-cmdk-row").dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.ok(doc.querySelector(".x-spm.is-on"));
  assert.deepEqual(p.errors, []);
});

test("jumping to a group outside the current space returns to 全部 first; the homepage engine bar is unaffected by spaces", opt, async (t) => {
  const p = await openStatic({ url: URL_FILE, storage: device("s-nas") });
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  const r = await pal(p, "下载");
  const gi = r.filter((x) => !x.startsWith("§")).findIndex((x) => / \| 分组$/.test(x));
  assert.ok(gi > -1);
  doc.querySelectorAll(".x-cmdk-row")[gi].dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(20);
  assert.equal(A.spaces.selected(), "all");
  assert.equal(doc.activeElement.getAttribute("data-id"), "mp7r2x0k1a", "focused the group's first tile");
  // engine bar: submit opens the engine URL, independent of the space
  A.spaces.select("s-nas");
  doc.getElementById("x-q").value = "hello";
  doc.getElementById("x-search").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  assert.ok((win.__opened || []).some((u) => /google\.com\/search\?q=hello/.test(u)));
  assert.equal(A.spaces.selected(), "s-nas");
});
