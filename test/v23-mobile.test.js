"use strict";
/* V2.3 · 手机首屏 / 常用 / 一句话状态 / 网址直达 / 编辑防误触 / 导入浏览器书签
 *  1. bookmarks.js：Netscape 书签 HTML 解析（文件夹层级、实体、只收 http(s)）、去重（首页已有 + 文件内重复）、上限、项目形状（私有地址进 lan）
 *  2. 网址直达：App.util.typedUrl 只把「像网址」的输入当网址；顶部搜索框回车直接打开网址，其余照常搜索；命令面板第一行是「打开 …」
 *  3. 常用：本机点按次数 + 最近使用排序，只在载入 / 回到前台时重排；「最近使用」显示开关同样控制它；不写进同步配置
 *  4. 一句话状态：网络胶囊带「N 个连不上」（只统计服务器确认的离线），全部连不上时 #x-groups 带 x-alldown
 *  5. 导入书签：一次提交（一个撤销步骤、一次同步），追加到同名分组或新建分组，撤销后配置复原
 *  6. 编辑防误触：Sortable 触屏需按住 280ms，编辑模式图标允许上下滑动（touch-action: pan-y）；撤销提示停 8 秒 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const B = require("../public/bookmarks.js");
const { seedAccount, startServer, client, sleep } = require("./helpers");
const { openPage, SKIP } = require("./browser");

const SAMPLE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
<DL><p>
  <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>
  <DL><p>
    <DT><A HREF="https://www.douban.com/" ICON="data:image/png;base64,AAA">豆瓣</A>
    <DT><A HREF="https://github.com/">GitHub</A>
    <DT><H3>书店 &amp; 经营</H3>
    <DL><p>
      <DT><A HREF="https://www.kongfz.com/">孔夫子旧书网</A>
      <DT><A HREF="javascript:alert(1)">小书签</A>
      <DT><A HREF="file:///etc/passwd">本地文件</A>
    </DL><p>
    <DT><A HREF="http://192.168.1.10:5000">群晖</A>
  </DL><p>
  <DT><H3>其他书签</H3>
  <DL><p>
    <DT><A HREF="https://github.com">GitHub 重复</A>
    <DT><A HREF='https://chat.openai.com/?a=1&amp;b=2'>ChatGPT &lt;AI&gt;</A>
  </DL><p>
  <DT><A HREF="https://example.org/">顶层</A>
</DL><p>`;

test("bookmarks.parse: folders (innermost), entities, only http(s)", () => {
  const list = B.parse(SAMPLE);
  assert.deepEqual(list.map((b) => [b.folder, b.title, b.url]), [
    ["书签栏", "豆瓣", "https://www.douban.com/"],
    ["书签栏", "GitHub", "https://github.com/"],
    ["书店 & 经营", "孔夫子旧书网", "https://www.kongfz.com/"],
    ["书签栏", "群晖", "http://192.168.1.10:5000"],
    ["其他书签", "GitHub 重复", "https://github.com"],
    ["其他书签", "ChatGPT <AI>", "https://chat.openai.com/?a=1&b=2"],
    ["", "顶层", "https://example.org/"],
  ]);
  assert.deepEqual(B.parse(""), []);
  assert.deepEqual(B.parse("<html><body>not bookmarks</body></html>"), []);
});

test("bookmarks.plan: skips addresses already on the homepage and duplicates in the file; caps the count", () => {
  const state = { groups: [{ items: [{ lan: "http://192.168.1.10:5000/", wan: "https://douban.com" }] }] };
  const p = B.plan(B.parse(SAMPLE), state);
  assert.equal(p.total, 7);
  assert.equal(p.dup, 3, "douban (www / trailing slash), 群晖 (lan), GitHub twice");
  assert.deepEqual(p.folders.map((f) => [f.name, f.items.map((i) => i.title)]), [
    ["书签栏", ["GitHub"]], ["书店 & 经营", ["孔夫子旧书网"]], ["其他书签", ["ChatGPT <AI>"]], ["导入的书签", ["顶层"]],
  ]);
  const capped = B.plan(B.parse(SAMPLE), { groups: [] }, { max: 2 });
  assert.equal(capped.count, 2); assert.equal(capped.cut, 4, "6 unique bookmarks, 2 taken");
});

test("bookmarks.item: private hosts go to lan, public to wan; library icon guessed from the domain", () => {
  let n = 0; const uid = () => "id" + (++n);
  assert.deepEqual(B.item({ title: "群晖", url: "http://192.168.1.10:5000" }, uid), { id: "id1", title: "群晖", desc: "", lan: "http://192.168.1.10:5000", wan: "", icon: { type: "", value: "", bg: "" } });
  assert.deepEqual(B.item({ title: "", url: "https://www.github.com/x" }, uid), { id: "id2", title: "Github", desc: "", lan: "", wan: "https://www.github.com/x", icon: { type: "iconify", value: "selfhst:github", bg: "" } });
  assert.equal(B.item({ title: "", url: "http://nas.local:8097" }, uid).lan, "http://nas.local:8097");
});

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "v1.1-config.json"), "utf8"));
function serverData() { const d = structuredClone(FIX); delete d.settings.net; delete d.recent; d.settings.wallpaper = { id: "star", url: "", dim: 35, blur: 0 }; return d; }
const opt = { skip: SKIP, timeout: 60000 };
async function seeded(t, data) {
  const srv = await startServer({ seed: (dir) => {
    seedAccount(dir);
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "admin.json"), JSON.stringify({ version: 3, updatedAt: "Thu 2026-11-05 8:00 AM CST (UTC+08:00)", data }));
  } });
  t.after(() => srv.stop());
  const c = client(srv.base);
  assert.equal((await c.post("/api/login", { name: "admin", password: "admin-pass-1" })).status, 200);
  return { srv, c };
}
const phone = (q) => /max-width:\s*767px/.test(q);

test("typed URLs open directly; words still search; palette offers 打开 … first", opt, async (t) => {
  const { srv, c } = await seeded(t, serverData());
  const p = await openPage(srv.base, c, { media: phone });
  t.after(() => p.close());
  const { win, A } = p, doc = win.document, u = A.util.typedUrl;
  assert.equal(u("douban.com"), "https://douban.com");
  assert.equal(u("www.douban.com/subject/1"), "https://www.douban.com/subject/1");
  assert.equal(u("192.168.1.10:5000"), "http://192.168.1.10:5000");
  assert.equal(u("nas.local:5000"), "http://nas.local:5000");
  assert.equal(u("https://example.com/a?b=1"), "https://example.com/a?b=1");
  for (const q of ["三体", "node.js", "index.html", "hello world", "javascript:alert(1)", "mailto:a@b.com", "v2.3", "user@evil.com", ""]) assert.equal(u(q), "", q);
  const opened = []; win.open = (url) => { opened.push(url); return null; };
  const submit = (q) => { doc.getElementById("x-q").value = q; doc.getElementById("x-search").dispatchEvent(new win.Event("submit", { cancelable: true })); };
  submit("douban.com"); submit("三体");
  assert.equal(opened[0], "https://douban.com");
  assert.match(opened[1], /%E4%B8%89%E4%BD%93/, "a word goes to the search engine");
  A.palette.open("github.com"); await sleep(30);
  assert.match(doc.querySelector(".x-cmdk-row").textContent, /打开 github\.com/);
  const inp = doc.querySelector(".x-cmdk input");
  inp.value = ">撤销"; inp.dispatchEvent(new win.Event("input", { bubbles: true })); await sleep(30);
  assert.match(doc.querySelector(".x-cmdk-row").textContent, /撤销上一步/);
});

test("常用 row: frequency + recency, device-local, follows the 最近使用 switch; pill says N 个连不上", opt, async (t) => {
  const d = serverData();
  const ids = d.groups.flatMap((g) => (g.items || []).map((i) => i.id));
  const { srv, c } = await seeded(t, d);
  const p = await openPage(srv.base, c, { media: phone, storage: { "nocturne.freq": JSON.stringify({ [ids[3]]: 9, [ids[0]]: 4, nope: 50 }) } });
  t.after(() => p.close());
  const { A } = p, doc = p.win.document;
  await p.idle(800);
  const fav = doc.querySelector(".x-fav");
  assert.ok(fav && !fav.hidden, "row shown");
  assert.deepEqual([...fav.querySelectorAll("[data-rid]")].map((a) => a.getAttribute("data-rid")), [ids[3], ids[0]], "most used first; unknown ids ignored");
  assert.ok(fav.previousElementSibling.id === "x-search", "sits right under the search bar");
  /* 点一个新项目：记次数，接到末尾，不打乱已有位置 */
  doc.querySelector('#x-groups a[data-id="' + ids[1] + '"]').dispatchEvent(new p.win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(30);
  assert.deepEqual([...fav.querySelectorAll("[data-rid]")].map((a) => a.getAttribute("data-rid")), [ids[3], ids[0], ids[1]]);
  assert.equal(JSON.parse(p.storage()["nocturne.freq"])[ids[1]], 1);
  assert.equal(p.puts().length, 0, "常用 never syncs");
  A.commit((s) => { s.settings.show = Object.assign({}, s.settings.show, { recent: false }); }, "settings"); await sleep(20);
  assert.ok(fav.hidden, "hidden with 最近使用 off");
  const nst = doc.querySelector(".x-net .x-nst");
  assert.ok(nst, "pill has the status slot");
  assert.match(nst.textContent, /^(\d+ 个连不上)?$/);
});

test("bookmark import: one commit, one undo, appended groups; edit drag needs a touch hold; undo toast lasts 8s", opt, async (t) => {
  const { srv, c } = await seeded(t, serverData());
  const p = await openPage(srv.base, c, { media: phone });
  t.after(() => p.close());
  const { A, win } = p, doc = win.document;
  await p.idle(600);
  const before = JSON.stringify(A.state.groups), n0 = A.state.groups.length, puts0 = p.puts().length;
  const input = doc.querySelector("[data-bmfile]");
  assert.ok(input, "设置 → 数据 has the bookmark file input");
  Object.defineProperty(input, "files", { value: [{ size: SAMPLE.length, text: () => Promise.resolve(SAMPLE) }], configurable: true });
  input.dispatchEvent(new win.Event("change"));
  await sleep(30);
  const box = doc.querySelector("[data-bm]");
  assert.ok(!box.hidden);
  assert.match(box.textContent, /找到 7 个书签/);
  doc.querySelector('[data-d="bm-go"]').click();
  await p.idle();
  const added = A.state.groups.slice(n0);
  assert.ok(added.length >= 1, "new groups appended at the end");
  assert.ok(added.every((g) => g.style === "icon" && g.items.every((i) => /^https?:\/\//.test(i.lan || i.wan))));
  assert.ok(p.puts().length > puts0, "synced");
  A.undo(); await p.idle();
  assert.equal(JSON.stringify(A.state.groups), before, "one undo restores everything");
  /* 编辑防误触与撤销提示（只看配置，不模拟真实手势；真实触摸在 Playwright 里验收） */
  const js = fs.readFileSync(path.join(__dirname, "../public/app-ui.js"), "utf8"), css = fs.readFileSync(path.join(__dirname, "../public/app.css"), "utf8");
  assert.match(js, /delay: 280, delayOnTouchOnly: true, touchStartThreshold: 8/);
  assert.match(css, /body\.editing #x-groups \[data-id\][^{]*\{\s*touch-action: pan-y;/);
  assert.match(fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8"), /opts\.duration \|\| \(opts\.action \? 8000 : 4000\)/);
});
