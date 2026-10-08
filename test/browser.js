"use strict";
/* 测试工具：用 jsdom 真实运行 public/index.html + 全部前端脚本（含 nocturne.js 同步层），对着一个真实的 server.js 子进程。
 * jsdom 不是项目依赖：CI 的 test 步骤会临时安装（npm i --no-save jsdom），本地可用 JSDOM_PATH 指向已安装的 jsdom。
 * 找不到 jsdom 时：CI（CI=true）里直接失败（不许悄悄跳过），本地跳过并说明原因。 */
const path = require("node:path");

function loadJsdom() {
  for (const p of [process.env.JSDOM_PATH, "jsdom"].filter(Boolean)) {
    try { return require(p); } catch (e) { /* next */ }
  }
  return null;
}
const jsdom = loadJsdom();
const SKIP = jsdom ? false : (process.env.CI ? false : "jsdom 未安装（本地可设 JSDOM_PATH；CI 会安装）");
if (!jsdom && process.env.CI) throw new Error("CI 里必须有 jsdom（见 .github/workflows/docker.yml）");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 打开一页（模拟一台设备上的一个标签页）。
 *  base：服务器地址；c：helpers.client（带 cookie，代表这台设备的登录）；opts.storage：这台设备的 localStorage 内容（对象，跨页面保留）
 *  opts.timeScale：>1 时页面里 ≥1 秒的 setTimeout 按此比例缩短（模拟长时间的重试周期）
 *  返回 {win, A, reqs: [{method, path, body}], storage(): 当前 localStorage 快照, close()}
 */
async function openPage(base, c, opts = {}) {
  const { JSDOM, ResourceLoader, VirtualConsole } = jsdom;
  const reqs = [], errors = [];
  let closed = false;
  const cookie = () => [...c.jar].map(([k, v]) => k + "=" + v).join("; ");
  class Loader extends ResourceLoader {
    fetch(url, o) {
      if (!o || !o.element || o.element.localName !== "script") return Promise.resolve(Buffer.from(""));
      return fetch(url, { headers: { Cookie: cookie() } }).then(async (r) => Buffer.from(await r.arrayBuffer()));
    }
  }
  const html = (await c.get(opts.path || "/")).body.toString("utf8");
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String(e && (e.stack || e.message) || e)));
  vc.on("error", (e) => errors.push("console.error " + String(e && (e.stack || e.message) || e)));
  const dom = new JSDOM(html, {
    url: base + "/", runScripts: "dangerously", resources: new Loader(), pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      for (const [k, v] of Object.entries(opts.storage || {})) win.localStorage.setItem(k, v);
      if (opts.timeScale > 1) { // 模拟时间流逝：≥1 秒的定时器按比例缩短（15 秒重试 → 150ms），防抖等短定时器不变
        const st = win.setTimeout.bind(win);
        win.setTimeout = (fn, ms, ...rest) => st(fn, ms >= 1000 ? Math.max(1, Math.round(ms / opts.timeScale)) : ms, ...rest);
      }
      win.structuredClone = (v) => structuredClone(v);
      win.TextEncoder = TextEncoder;
      win.matchMedia = win.matchMedia || ((q) => ({ matches: opts.media ? !!opts.media(q) : false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      win.ResizeObserver = win.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
      win.IntersectionObserver = win.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.URL.createObjectURL = (blob) => { (win.__downloads = win.__downloads || []).push(blob); return "blob:test/" + win.__downloads.length; };
      win.URL.revokeObjectURL = () => {};
      win.HTMLAnchorElement.prototype.click = function () { (win.__clicked = win.__clicked || []).push(this.download || this.href); };
      win.open = () => null;
      win.fetch = async (u, o = {}) => {
        if (closed) return new Promise(() => {}); // 页面已关：不再发请求，也不再回调
        const url = new URL(u, base + "/"), p = url.pathname + url.search;
        if (url.origin !== base) { // 浏览器端探测项目地址（no-cors）：测试里一律当作连不上，不真的发出去
          await sleep(5); if (closed) return new Promise(() => {});
          throw new TypeError("Failed to fetch (blocked in test)");
        }
        let body = o.body;
        const rec = { method: o.method || "GET", path: p, body: typeof body === "string" ? JSON.parse(body) : undefined };
        if (rec.method !== "GET") reqs.push(rec);
        const headers = Object.assign({}, o.headers || {}, { Cookie: cookie() });
        let r;
        try { r = await fetch(url, { method: rec.method, headers, body: typeof body === "string" ? body : undefined }); }
        catch (e) { if (closed) return new Promise(() => {}); throw new TypeError("Failed to fetch"); }
        const buf = Buffer.from(await r.arrayBuffer());
        if (closed) return new Promise(() => {});
        rec.status = r.status;
        try { rec.res = JSON.parse(buf.toString("utf8")); } catch (e) { /* not json */ }
        return { ok: r.ok, status: r.status, json: async () => JSON.parse(buf.toString("utf8")), blob: async () => new win.Blob([buf]), text: async () => buf.toString("utf8") };
      };
    },
  });
  const win = dom.window;
  await new Promise((r) => { if (win.document.readyState === "complete") r(); else win.addEventListener("load", r); });
  await sleep(opts.settle == null ? 300 : opts.settle);
  return {
    win, dom, reqs, errors,
    get A() { return win.App; },
    storage() { const o = {}; for (let i = 0; i < win.localStorage.length; i++) { const k = win.localStorage.key(i); o[k] = win.localStorage.getItem(k); } return o; },
    puts() { return reqs.filter((x) => x.method === "PUT" && /^\/api\/config/.test(x.path)); },
    /** 等同步层把本机修改推上去（防抖 800ms + 请求） */
    async idle(ms = 1600) { await sleep(ms); },
    async close() { closed = true; await sleep(150); try { win.close(); } catch (e) { /* ignore */ } },
  };
}

/** 往 <input type=file data-file> 里放一个 JSON 文件并触发 change（走真实的「导入配置」代码路径） */
function importFile(page, obj) {
  const win = page.win, input = win.document.querySelector("input[type=file][data-file]");
  const txt = typeof obj === "string" ? obj : JSON.stringify(obj);
  const f = new win.File([txt], "import.json", { type: "application/json" });
  if (typeof f.text !== "function") f.text = () => Promise.resolve(txt);
  Object.defineProperty(input, "files", { value: [f], configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
}

/**
 * 纯静态模式（没有 window.NOCTURNE）：opts.url = "file:///…/public/index.html"（直接读磁盘）或 "http://127.0.0.1:<port>/index.html"（python http.server）。
 * opts.storage：这台设备的 localStorage；opts.probe(url) → true 时浏览器探测得到 no-cors 不透明响应（模拟「请求没报错」）；返回值与 openPage 相同（reqs 里只会有浏览器端状态探测，测试里一律当作连不上）。
 */
async function openStatic(opts = {}) {
  const fs = require("node:fs");
  const { JSDOM, ResourceLoader, VirtualConsole } = jsdom;
  const errors = [], reqs = [];
  let closed = false;
  const u = new URL(opts.url);
  const read = async (href) => {
    const x = new URL(href);
    if (x.protocol === "file:") return fs.readFileSync(decodeURIComponent(x.pathname));
    const r = await fetch(href); return Buffer.from(await r.arrayBuffer());
  };
  class Loader extends ResourceLoader {
    fetch(url, o) {
      if (!o || !o.element || o.element.localName !== "script") return Promise.resolve(Buffer.from(""));
      return read(url);
    }
  }
  const html = (await read(opts.url)).toString("utf8");
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String(e && (e.stack || e.message) || e)));
  vc.on("error", (e) => errors.push("console.error " + String(e && (e.stack || e.message) || e)));
  const dom = new JSDOM(html, {
    url: opts.url, runScripts: "dangerously", resources: new Loader(), pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      if (!win.localStorage) { // jsdom 的 file:// 是不透明源、没有 localStorage；Chrome / Safari 的 file:// 有。这里给一个等价的内存实现
        const m = new Map();
        const ls = { getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null), setItem: (k, v) => { m.set(String(k), String(v)); }, removeItem: (k) => { m.delete(String(k)); },
          clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
        Object.defineProperty(win, "localStorage", { configurable: true, get: () => ls });
      }
      for (const [k, v] of Object.entries(opts.storage || {})) win.localStorage.setItem(k, v);
      win.structuredClone = (v) => structuredClone(v);
      win.TextEncoder = TextEncoder;
      win.matchMedia = win.matchMedia || ((q) => ({ matches: opts.media ? !!opts.media(q) : false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      win.ResizeObserver = win.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
      win.IntersectionObserver = win.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.URL.createObjectURL = (blob) => { (win.__downloads = win.__downloads || []).push(blob); return "blob:test/" + win.__downloads.length; };
      win.URL.revokeObjectURL = () => {};
      win.HTMLAnchorElement.prototype.click = function () { (win.__clicked = win.__clicked || []).push(this.download || this.href); };
      win.open = (x) => { (win.__opened = win.__opened || []).push(String(x)); return null; };
      win.fetch = async (x, o = {}) => { // 静态页只会探测项目地址：一律当作连不上，不真的发出去
        reqs.push({ method: (o && o.method) || "GET", path: String(x) });
        await sleep(5); if (closed) return new Promise(() => {});
        if (opts.probe && opts.probe(String(x))) return { ok: false, status: 0, type: "opaque" }; // no-cors 成功 = 不透明响应（拿不到状态码）
        throw new TypeError("Failed to fetch (blocked in test)");
      };
    },
  });
  const win = dom.window;
  await new Promise((r) => { if (win.document.readyState === "complete") r(); else win.addEventListener("load", r); });
  await sleep(opts.settle == null ? 200 : opts.settle);
  return {
    win, dom, reqs, errors, origin: u.origin,
    get A() { return win.App; },
    storage() { const o = {}; for (let i = 0; i < win.localStorage.length; i++) { const k = win.localStorage.key(i); o[k] = win.localStorage.getItem(k); } return o; },
    puts() { return []; },
    async idle(ms = 300) { await sleep(ms); },
    async close() { closed = true; await sleep(50); try { win.close(); } catch (e) { /* ignore */ } },
  };
}

/** 页面里按可见文字找按钮 / 链接 */
function byText(root, sel, text) { return [...root.querySelectorAll(sel)].find((el) => el.textContent.trim() === text || el.textContent.includes(text)); }

module.exports = { openPage, openStatic, importFile, byText, SKIP, jsdom, sleep, ROOT: path.join(__dirname, "..") };
