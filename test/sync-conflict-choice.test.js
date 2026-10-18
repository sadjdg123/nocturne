"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jsdom, SKIP } = require("./browser");

const PUBLIC = path.join(__dirname, "..", "public");
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

async function conflictPage(t, options = {}) {
  const { JSDOM, ResourceLoader, VirtualConsole } = jsdom;
  const requests = [], downloads = [], errors = [];
  const timers = new Map();
  let now = 0, timerId = 0;
  class Loader extends ResourceLoader {
    fetch(url, opts) {
      if (opts.element.localName !== "script") return Promise.resolve(Buffer.from(""));
      return Promise.resolve(fs.readFileSync(path.join(PUBLIC, new URL(url).pathname)));
    }
  }
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(String(e.message)));
  vc.on("error", e => errors.push(String(e)));
  const dom = new JSDOM(fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8"), {
    url: "http://nocturne.test/", runScripts: "dangerously", resources: new Loader(), pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.NOCTURNE = { backend: true, user: { name: "reader", admin: false }, auth: false, version: 7 };
      win.localStorage.setItem("yeqv.v1", JSON.stringify({ version: 1, settings: { title: "local before choice", net: "wan" }, groups: [], recent: ["local-only"] }));
      win.localStorage.setItem("nocturne.owner", "reader");
      win.localStorage.setItem("nocturne.ver", "1");
      win.localStorage.setItem("nocturne.dirty", "1");
      win.structuredClone = structuredClone;
      win.TextEncoder = TextEncoder;
      win.matchMedia = q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.setTimeout = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, due: now + delay }); return id; };
      win.clearTimeout = id => timers.delete(id);
      win.setInterval = () => ++timerId;
      win.clearInterval = () => {};
      win.URL.createObjectURL = blob => { if (options.failDownload) throw new Error("download unavailable"); downloads.push(blob); return "blob:test/" + downloads.length; };
      win.URL.revokeObjectURL = () => {};
      win.HTMLAnchorElement.prototype.click = function () {};
      win.fetch = (url, opts = {}) => {
        const u = new URL(url, "http://nocturne.test/");
        if (!/^\/api\/config(?:\/stash)?$/.test(u.pathname)) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        const req = { path: u.pathname, method: opts.method || "GET", body: opts.body && JSON.parse(opts.body), pending: true };
        requests.push(req);
        return new Promise((resolve, reject) => {
          req.resolve = (data, status = 200) => { req.pending = false; resolve({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) }); };
          req.reject = () => { req.pending = false; reject(new TypeError("offline")); };
        });
      };
    },
  });
  const win = dom.window;
  t.after(() => win.close());
  await new Promise(resolve => win.addEventListener("load", resolve));
  await settle();
  assert.deepEqual(errors, [], "the complete page boots without script errors");
  const puts = () => requests.filter(r => r.path === "/api/config" && r.method === "PUT");
  puts()[0].resolve({ conflict: true, version: 7, groups: 0, items: 0 }, 409);
  await settle();
  assert.ok(win.document.querySelector(".nc-cfs.is-on"), "a real rejected save opens the conflict choice");
  return {
    win, requests, downloads, puts,
    get A() { return win.App; },
    gets: () => requests.filter(r => r.path === "/api/config" && r.method === "GET"),
    stashes: () => requests.filter(r => r.path === "/api/config/stash"),
    pane: () => win.document.querySelector(".nc-cfs.is-on"),
    choose() { this.pane().querySelector('[data-cf="server"]').click(); },
    dismiss() { win.document.querySelector(".nc-cfb.is-on").click(); },
    reopen() { win.document.getElementById("x-toast-act").click(); },
    edit(title) { win.App.commit(state => { state.settings.title = title; }, "settings"); },
    stored: key => win.localStorage.getItem(key),
    cached: () => JSON.parse(win.localStorage.getItem("yeqv.v1")),
    toast: () => win.document.getElementById("x-toast-msg").textContent,
    async advance(ms) {
      const target = now + ms;
      let count = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, value]) => value.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        assert.ok(++count < 2000, "the page clock makes progress");
        const [id, timer] = next; now = timer.due; timers.delete(id); timer.fn(); await settle();
      }
      now = target; await settle();
    },
  };
}

async function serverResponse(req, title = "server version") {
  assert.ok(req, "the active choice requested the server configuration");
  req.resolve({ version: 7, data: { version: 1, settings: { title, net: "lan" }, groups: [], recent: ["remote-only"] } });
  await settle();
}

function retained(h, title, op) {
  assert.equal(h.A.state.settings.title, title);
  assert.equal(h.cached().settings.title, title);
  assert.equal(h.stored("nocturne.dirty"), "1");
  assert.equal(h.stored("nocturne.ver"), "1");
  assert.equal(h.stored("nocturne.op"), op);
}

test("an edit while the conflict backup waits cannot authorize discarding that edit", { skip: SKIP }, async t => {
  const h = await conflictPage(t), op = h.stored("nocturne.op");
  h.choose();
  assert.equal(h.stashes()[0].body.data.settings.title, "local before choice");
  h.edit("edited during backup");
  h.stashes()[0].resolve({ ok: true }); await settle();
  retained(h, "edited during backup", op);
  assert.equal(h.gets().length, 0, "a superseded choice cannot start a replacement read");
  assert.ok(h.pane());
  assert.equal(h.pane().querySelector('[data-cf="server"]').disabled, false);
  await h.advance(900);
  assert.equal(h.puts().length, 1, "the conflict remains unresolved");
});

test("an edit while the chosen server read waits keeps local state, dirty and operation identity", { skip: SKIP }, async t => {
  const h = await conflictPage(t), op = h.stored("nocturne.op");
  h.choose(); h.stashes()[0].resolve({ ok: true }); await settle();
  h.edit("edited during server read");
  await serverResponse(h.gets()[0]);
  retained(h, "edited during server read", op);
  assert.ok(h.pane());
  assert.equal(h.pane().querySelector('[data-cf="server"]').disabled, false);
  await h.advance(900);
  assert.equal(h.puts().length, 1);
});

test("dismissing a pending backup cancels its replacement permission without requiring an edit", { skip: SKIP }, async t => {
  const h = await conflictPage(t), op = h.stored("nocturne.op");
  h.choose(); h.dismiss(); h.stashes()[0].resolve({ ok: true }); await settle();
  retained(h, "local before choice", op);
  assert.equal(h.gets().length, 0);
  assert.equal(h.pane(), null);
});

test("dismissing a pending server read cancels adoption even when content has not changed", { skip: SKIP }, async t => {
  const h = await conflictPage(t), op = h.stored("nocturne.op");
  h.choose(); h.stashes()[0].resolve({ ok: true }); await settle();
  h.dismiss(); await serverResponse(h.gets()[0]);
  retained(h, "local before choice", op);
  assert.equal(h.pane(), null);
  h.reopen(); assert.ok(h.pane(), "the unresolved conflict can be opened again");
});

test("an old response cannot close or unlock a reopened choice with identical content and conflict", { skip: SKIP }, async t => {
  const h = await conflictPage(t), op = h.stored("nocturne.op");
  h.choose(); h.stashes()[0].resolve({ ok: true }); await settle();
  const oldRead = h.gets()[0];
  h.dismiss(); h.reopen();
  const newPane = h.pane();
  h.choose();
  await serverResponse(oldRead, "old request result");
  retained(h, "local before choice", op);
  assert.equal(h.pane(), newPane);
  assert.equal(newPane.querySelector('[data-cf="server"]').disabled, true);
  h.stashes()[1].resolve({ ok: true }); await settle();
  await serverResponse(h.gets()[1], "new request result");
  assert.equal(h.A.state.settings.title, "new request result");
  assert.equal(h.pane(), null);
});

test("an old failure cannot unlock the pending buttons of a reopened choice", { skip: SKIP }, async t => {
  const h = await conflictPage(t);
  h.choose(); h.stashes()[0].resolve({ ok: true }); await settle();
  const oldRead = h.gets()[0];
  h.dismiss(); h.reopen(); const newPane = h.pane(); h.choose();
  oldRead.reject(); await settle();
  assert.equal(h.pane(), newPane);
  assert.equal(newPane.querySelector('[data-cf="server"]').disabled, true);
  assert.equal(h.A.state.settings.title, "local before choice");
});

test("an unchanged server choice backs up its exact synchronized snapshot and preserves device-local edits", { skip: SKIP }, async t => {
  const h = await conflictPage(t);
  const expected = h.puts()[0].body.data;
  h.choose();
  assert.deepEqual(h.stashes()[0].body, { baseVersion: 1, data: expected });
  h.A.state.settings.net = "lan"; h.A.state.recent = ["opened while waiting"]; h.A.save();
  h.stashes()[0].resolve({ ok: true }); await settle();
  await serverResponse(h.gets()[0]);
  assert.equal(h.A.state.settings.title, "server version");
  assert.equal(h.cached().settings.title, "server version");
  assert.equal(h.A.state.settings.net, "lan");
  assert.deepEqual([...h.A.state.recent], ["opened while waiting"]);
  assert.equal(h.stored("nocturne.dirty"), null);
  assert.equal(h.stored("nocturne.ver"), "7");
  assert.equal(h.stored("nocturne.op"), null);
  assert.match(h.toast(), /较早的版本/);
  await h.advance(900);
  assert.equal(h.puts().length, 1);
});

test("a rejected NAS backup exports only the captured choice and reports the actual local destination", { skip: SKIP }, async t => {
  const h = await conflictPage(t), captured = [];
  h.A.exportState = state => { captured.push(structuredClone(state)); return Promise.resolve(state); };
  h.choose();
  h.stashes()[0].resolve({ error: "too large" }, 413); await settle();
  assert.ok(captured[0], "the backup exporter receives the captured choice as its input");
  assert.equal(captured[0].settings.title, "local before choice");
  assert.equal(h.downloads.length, 1);
  await serverResponse(h.gets()[0]);
  assert.equal(h.A.state.settings.title, "server version");
  assert.match(h.toast(), /文件|下载/);
  assert.doesNotMatch(h.toast(), /已存入.*较早的版本/);
});

test("an exporter failure cannot fall back to current live state and authorize replacement", { skip: SKIP }, async t => {
  const h = await conflictPage(t), op = h.stored("nocturne.op");
  h.A.exportState = () => Promise.reject(new Error("cannot prepare captured backup"));
  h.choose(); h.stashes()[0].resolve({ error: "too large" }, 413); await settle();
  retained(h, "local before choice", op);
  assert.equal(h.downloads.length, 0);
  assert.equal(h.gets().length, 0);
  assert.ok(h.pane());
  assert.equal(h.pane().querySelector('[data-cf="server"]').disabled, false);
});

test("a failed local download after a rejected NAS backup leaves the choice and edit untouched", { skip: SKIP }, async t => {
  const h = await conflictPage(t, { failDownload: true }), op = h.stored("nocturne.op");
  h.choose(); h.stashes()[0].resolve({ error: "too large" }, 413); await settle();
  retained(h, "local before choice", op);
  assert.equal(h.gets().length, 0);
  assert.ok(h.pane());
  assert.equal(h.pane().querySelector('[data-cf="server"]').disabled, false);
});

test("editing during a rejected stash never exports later live edits as the saved choice", { skip: SKIP }, async t => {
  const h = await conflictPage(t), op = h.stored("nocturne.op"), captured = [];
  h.A.exportState = state => { captured.push(structuredClone(state)); return Promise.resolve(state); };
  h.choose(); h.edit("new edit before rejection");
  h.stashes()[0].resolve({ error: "too large" }, 413); await settle();
  retained(h, "new edit before rejection", op);
  assert.ok(captured.every(state => state && state.settings.title === "local before choice"));
  assert.equal(h.gets().length, 0);
});

test("the backup exporter can prepare a captured state after live state changes", { skip: SKIP }, async t => {
  const h = await conflictPage(t), captured = structuredClone(h.A.state);
  h.edit("edited after capture");
  const exported = await h.A.exportState(captured);
  assert.equal(exported.settings.title, "local before choice");
  assert.equal(h.A.state.settings.title, "edited after capture");
  assert.notEqual(exported, captured, "export preparation does not mutate its captured input");
});
