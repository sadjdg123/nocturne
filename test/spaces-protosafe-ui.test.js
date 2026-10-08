"use strict";
/* 阶段 2 · public/index.html / cmdrank.js / nocturne.js 里按 id 建表的地方改成 Map / Set / 无原型对象之后：
 * 分组 / 项目 id 用 constructor、__proto__、toString、hasOwnProperty、valueOf、prototype（手工导入的 JSON 可能出现）时，
 * 首页渲染、状态统计、命令面板（最近使用 / 分层排序 / 分组跳转）、最近使用记录、拖动排序（spaces.reorder）、删除 / 撤销、空间视图都正常。
 * 纯静态模式（file://）下用 jsdom 真实运行页面。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const S = require("../public/spaces.js");
const R = require("../public/cmdrank.js");
const { openStatic, SKIP, sleep, ROOT } = require("./browser");

const NAMES = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "prototype"];
const URL_FILE = "file://" + path.join(ROOT, "public", "index.html");
const J = (o) => JSON.parse(JSON.stringify(o)); // __proto__ 作为真正的自有键（JSON.parse 会这样建）
function data() {
  return JSON.parse(JSON.stringify({
    settings: { title: "夜曲", subtitle: "Nocturne", user: "T", cols: 4, engine: "google", engines: [{ id: "google", name: "Google", url: "https://www.google.com/search?q=%s", on: true }] },
    groups: [
      { id: "g-a", name: "甲组", style: "icon", items: NAMES.slice(0, 3).map((n, i) => ({ id: n, title: "服务" + n, desc: "", lan: "", wan: "https://s" + i + ".invalid", icon: { type: "text", value: "S" + i } })) },
      { id: "constructor", name: "构造组", style: "icon", items: NAMES.slice(3).map((n, i) => ({ id: n, title: "服务" + n, desc: "", lan: "", wan: "https://t" + i + ".invalid", icon: { type: "text", value: "T" + i } })) },
    ],
    recent: ["constructor", "__proto__", "valueOf"],
    spaces: [{ id: "toString", name: "原型空间", groupIds: ["constructor"], itemIds: ["__proto__"] }],
  }));
}

test("cmdrank: recent ids named like prototype members rank correctly (Map), no function leaks into the ordering", () => {
  const entries = NAMES.map((n) => ({ item: { id: n, title: "svc " + n }, urls: [] }));
  const out = R.rank(entries, "svc", ["valueOf", "constructor"]);
  assert.deepEqual(out.slice(0, 2).map((o) => o.entry.item.id), ["valueOf", "constructor"], "recent first, in recency order");
  assert.ok(out.every((o) => typeof o.rp === "number"), "rp is always a number");
  assert.equal(new Set(out.map((o) => o.entry.item.id)).size, NAMES.length);
});

test("spaces.reorder with prototype-ish ids: subset drag keeps hidden items/groups in place, nothing lost", () => {
  const d = J(data());
  const before = d.groups.map((g) => g.items.map((i) => i.id));
  // space "toString" shows group "constructor" (whole) + pinned "__proto__" from g-a (partial)
  const v = S.view(d, "toString");
  assert.deepEqual(v.map((e) => [e.group.id, e.whole, e.items.map((i) => i.id)]), [["g-a", false, ["__proto__"]], ["constructor", true, ["hasOwnProperty", "valueOf", "prototype"]]]);
  // drag: group "constructor" above g-a, and move "__proto__" into it after valueOf
  assert.equal(S.reorder(d, [{ gid: "constructor", ids: ["hasOwnProperty", "valueOf", "__proto__", "prototype"] }, { gid: "g-a", ids: [] }]), true);
  assert.deepEqual(d.groups.map((g) => g.id), ["constructor", "g-a"]);
  assert.deepEqual(d.groups[0].items.map((i) => i.id), ["hasOwnProperty", "valueOf", "__proto__", "prototype"]);
  assert.deepEqual(d.groups[1].items.map((i) => i.id), ["constructor", "toString"], "hidden items of the partial group stay, in order");
  assert.equal(d.groups.flatMap((g) => g.items).length, before.flat().length);
  assert.ok(Object.getPrototypeOf(d.groups[0]) === Object.prototype, "no prototype was rewritten");
});

test("index.html (static, file://): render, status count, palette (recent / search / group jump), recent tracking, delete + undo with prototype-ish ids", { skip: SKIP, timeout: 60000 }, async (t) => {
  const st = { "yeqv.v1": JSON.stringify(data()) };
  const p = await openStatic({ url: URL_FILE, storage: st });
  t.after(() => p.close());
  const { win, A } = p, doc = win.document;
  assert.deepEqual(p.errors, []);
  const ids = [...doc.querySelectorAll("#x-groups [data-id]")].map((e) => e.getAttribute("data-id"));
  assert.deepEqual(ids, NAMES.slice(0, 3).concat(NAMES.slice(3)), "every item rendered once (全部)");
  await sleep(300);
  assert.match(doc.querySelector(".x-side .x-cnt").textContent, /\/ 6/, "status total counts all 6 items (dict lookups)");
  // palette: empty query → recent rows are exactly the recent ids
  A.palette.open("");
  const rows = () => [...doc.querySelectorAll(".x-cmdk-row")].map((r) => r.textContent);
  const titles = [...doc.querySelectorAll(".x-cmdk-row .x-cmdk-t b")].map((b) => b.textContent).filter((x) => /^服务/.test(x)).slice(0, 3);
  assert.deepEqual(titles, ["服务constructor", "服务__proto__", "服务valueOf"]);
  // search by title
  const inp = doc.querySelector(".x-cmdk input");
  inp.value = "服务hasOwnProperty"; inp.dispatchEvent(new win.Event("input"));
  assert.match(rows()[0], /服务hasOwnProperty/); assert.match(rows()[0], /构造组/, "group name shown");
  // group jump to the group whose id is "constructor"
  inp.value = "构造组"; inp.dispatchEvent(new win.Event("input"));
  const gi = [...doc.querySelectorAll(".x-cmdk-row")].findIndex((r) => /分组/.test(r.textContent));
  assert.ok(gi > -1, "group row present");
  doc.querySelectorAll(".x-cmdk-row")[gi].click();
  await sleep(50);
  assert.equal(doc.activeElement && doc.activeElement.getAttribute("data-id"), "hasOwnProperty", "focus moved to the first tile of group 'constructor'");
  // recent tracking: click a tile with id "toString"
  doc.querySelector('#x-groups a[data-id="toString"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(20);
  assert.equal(A.state.recent[0], "toString");
  // delete __proto__ item (edit mode badge), then undo
  A.emit("edit", {});
  doc.querySelector('#x-groups [data-id="__proto__"] .x-ebadge').click();
  assert.ok(!doc.querySelector('#x-groups [data-id="__proto__"]'));
  assert.deepEqual(J(A.state.spaces[0].itemIds), [], "pinned ref pruned in the same commit");
  A.undo();
  assert.ok(doc.querySelector('#x-groups [data-id="__proto__"]'));
  assert.deepEqual(J(A.state.spaces[0].itemIds), ["__proto__"]);
  assert.ok(Object.getPrototypeOf(A.state.groups[0].items[1]) !== null && !("polluted" in {}), "no prototype pollution");
  assert.deepEqual(p.errors, []);
});
