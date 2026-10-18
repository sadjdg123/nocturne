"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jsdom, SKIP } = require("./browser");

const PUBLIC = path.join(__dirname, "..", "public");
const settle = () => new Promise(setImmediate);
const initial = () => ({ version: 1, settings: { title: "cached", net: "wan" }, groups: [], recent: ["local-only"] });

async function page(t, options = {}) {
  const { JSDOM, ResourceLoader, VirtualConsole } = jsdom;
  const requests = [], timers = new Map(), errors = [];
  let now = 0, timerId = 0;
  class Loader extends ResourceLoader {
    fetch(url, opts) {
      if (opts.element.localName !== "script") return Promise.resolve(Buffer.from(""));
      return Promise.resolve(fs.readFileSync(path.join(PUBLIC, new URL(url).pathname)));
    }
  }
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String(e.message)));
  vc.on("error", (e) => errors.push(String(e)));
  const dom = new JSDOM(fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8"), {
    url: "http://nocturne.test/", runScripts: "dangerously", resources: new Loader(), pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.NOCTURNE = { backend: true, user: { name: "reader", admin: false }, auth: false, version: options.version || 1 };
      win.localStorage.setItem("yeqv.v1", JSON.stringify(initial()));
      win.localStorage.setItem("nocturne.owner", "reader");
      win.localStorage.setItem("nocturne.ver", "1");
      if (options.dirty) win.localStorage.setItem("nocturne.dirty", "1");
      win.structuredClone = structuredClone;
      win.TextEncoder = TextEncoder;
      win.matchMedia = q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.setTimeout = (fn, delay = 0) => {
        const id = ++timerId;
        timers.set(id, { fn, due: now + delay });
        return id;
      };
      win.clearTimeout = id => timers.delete(id);
      win.setInterval = () => ++timerId;
      win.clearInterval = () => {};
      win.fetch = (url, opts = {}) => {
        const u = new URL(url, "http://nocturne.test/"), method = opts.method || "GET";
        if (u.pathname !== "/api/config") return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        const req = { method, body: opts.body && JSON.parse(opts.body), pending: true };
        requests.push(req);
        return new Promise((resolve, reject) => {
          req.resolve = (data, status = 200) => {
            req.pending = false;
            resolve({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
          };
          req.reject = () => { req.pending = false; reject(new TypeError("offline")); };
        });
      };
    },
  });
  const win = dom.window;
  t.after(() => win.close());
  await new Promise(resolve => win.addEventListener("load", resolve));
  await settle(); await settle();
  assert.deepEqual(errors, [], "the complete page boots without script errors");
  return {
    win, requests,
    get A() { return win.App; },
    gets: () => requests.filter(r => r.method === "GET"),
    puts: () => requests.filter(r => r.method === "PUT"),
    stored: key => win.localStorage.getItem(key),
    cached: () => JSON.parse(win.localStorage.getItem("yeqv.v1")),
    edit(title) { win.App.commit(state => { state.settings.title = title; }, "settings"); },
    foreground() { win.document.dispatchEvent(new win.Event("visibilitychange")); },
    restored() { const event = new win.Event("pageshow"); Object.defineProperty(event, "persisted", { value: true }); win.dispatchEvent(event); },
    async advance(ms) {
      const target = now + ms;
      let count = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, v]) => v.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        assert.ok(++count < 2000, "the page clock makes progress");
        const [id, timer] = next; now = timer.due; timers.delete(id); timer.fn();
        await settle();
      }
      now = target;
      await settle(); await settle();
    },
  };
}

async function response(request, version, title) {
  assert.ok(request, "the page requested configuration");
  request.resolve({ version, data: { version: 1, settings: { title, net: "lan" }, groups: [], recent: ["remote-only"] } });
  await settle(); await settle();
}

test("dirty restart retains its local cache when foreground and bfcache reads race the startup PUT", { skip: SKIP }, async t => {
  const h = await page(t, { version: 7, dirty: true });
  const put = h.puts()[0];
  assert.equal(put.body.baseVersion, 1);
  h.foreground(); h.restored();
  for (const get of h.gets()) await response(get, 7, "another device");
  assert.equal(h.A.state.settings.title, "cached");
  assert.equal(h.cached().settings.title, "cached");
  assert.equal(h.stored("nocturne.dirty"), "1");
  put.resolve({ conflict: true, version: 7, groups: 1, items: 0 }, 409);
  await settle(); await settle();
  assert.equal(h.A.state.settings.title, "cached");
  assert.ok(h.win.document.querySelector(".nc-cfs"), "the conflicting edit remains available for an explicit choice");
});

test("normal foreground refresh adopts a newer server version and retains device-local data", { skip: SKIP }, async t => {
  const h = await page(t);
  h.foreground();
  await response(h.gets()[0], 2, "remote");
  assert.equal(h.A.state.settings.title, "remote");
  assert.equal(h.cached().settings.title, "remote");
  assert.equal(h.A.state.settings.net, "wan");
  assert.deepEqual([...h.A.state.recent], ["local-only"]);
  assert.equal(h.stored("nocturne.ver"), "2");
  assert.equal(h.stored("nocturne.dirty"), null);
  await h.advance(900);
  assert.equal(h.puts().length, 0);
});

test("malformed remote versions cannot replace a confirmed cache", { skip: SKIP }, async t => {
  const h = await page(t);
  for (const version of [undefined, null, "2", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    h.foreground();
    await response(h.gets().at(-1), version, "invalid remote version");
    assert.equal(h.A.state.settings.title, "cached", "invalid version " + String(version));
    assert.equal(h.cached().settings.title, "cached");
    assert.equal(h.stored("nocturne.ver"), "1");
    assert.equal(h.stored("nocturne.dirty"), null);
  }
  h.foreground();
  await response(h.gets().at(-1), 2, "valid version");
  assert.equal(h.A.state.settings.title, "valid version");
});

test("undoing an edit permits a confirmed snapshot to refresh despite the old dirty marker", { skip: SKIP }, async t => {
  const h = await page(t);
  h.edit("temporary"); h.A.undo();
  assert.equal(h.stored("nocturne.dirty"), "1");
  h.foreground();
  await response(h.gets()[0], 2, "remote after undo");
  assert.equal(h.A.state.settings.title, "remote after undo");
  assert.equal(h.stored("nocturne.dirty"), null);
});

test("clean stale bootstrap replaces its unchanged cache without uploading it", { skip: SKIP }, async t => {
  const h = await page(t, { version: 7 });
  await response(h.gets()[0], 7, "fresh bootstrap");
  assert.equal(h.A.state.settings.title, "fresh bootstrap");
  assert.equal(h.stored("nocturne.ver"), "7");
  await h.advance(900);
  assert.equal(h.puts().length, 0);
});

test("an edit during stale bootstrap is retained and sent with its original cached base", { skip: SKIP }, async t => {
  const h = await page(t, { version: 7 });
  h.edit("edited during bootstrap");
  await response(h.gets()[0], 7, "remote bootstrap");
  assert.equal(h.A.state.settings.title, "edited during bootstrap");
  assert.equal(h.cached().settings.title, "edited during bootstrap");
  assert.equal(h.stored("nocturne.dirty"), "1");
  await h.advance(900);
  assert.equal(h.puts()[0].body.baseVersion, 1);
  assert.equal(h.puts()[0].body.data.settings.title, "edited during bootstrap");
});

test("a failed bootstrap never confirms an edit made while it was pending", { skip: SKIP }, async t => {
  const h = await page(t, { version: 7 });
  h.edit("edited before offline result");
  h.gets()[0].reject();
  await settle(); await settle();
  assert.equal(h.A.state.settings.title, "edited before offline result");
  assert.equal(h.stored("nocturne.dirty"), "1");
  await h.advance(900);
  assert.equal(h.puts()[0].body.baseVersion, 1);
  assert.equal(h.puts()[0].body.data.settings.title, "edited before offline result");
});

test("an unchanged cache remains refreshable after bootstrap fails", { skip: SKIP }, async t => {
  const h = await page(t, { version: 7 });
  h.gets()[0].reject(); await settle(); await settle();
  h.foreground();
  await response(h.gets()[1], 7, "connected again");
  assert.equal(h.A.state.settings.title, "connected again");
  await h.advance(900);
  assert.equal(h.puts().length, 0);
});

test("an edit while a foreground GET waits remains local and uses the original base", { skip: SKIP }, async t => {
  const h = await page(t);
  h.foreground(); h.edit("edited during GET");
  await response(h.gets()[0], 7, "remote");
  assert.equal(h.A.state.settings.title, "edited during GET");
  assert.equal(h.stored("nocturne.dirty"), "1");
  await h.advance(900);
  assert.equal(h.puts()[0].body.baseVersion, 1);
});

test("a GET dispatched before a newer confirmed PUT cannot replace that confirmed edit", { skip: SKIP }, async t => {
  const h = await page(t);
  h.foreground(); h.edit("confirmed new edit");
  await h.advance(900);
  h.puts()[0].resolve({ version: 2 }); await settle(); await settle();
  await response(h.gets()[0], 7, "late remote result");
  assert.equal(h.A.state.settings.title, "confirmed new edit");
  assert.equal(h.cached().settings.title, "confirmed new edit");
  assert.equal(h.stored("nocturne.ver"), "2");
  h.foreground();
  await response(h.gets()[1], 7, "fresh remote result");
  assert.equal(h.A.state.settings.title, "fresh remote result");
});

test("out-of-order foreground reads cannot replace an already adopted snapshot", { skip: SKIP }, async t => {
  const h = await page(t);
  h.foreground(); h.restored();
  await response(h.gets()[1], 3, "first confirmed result");
  await response(h.gets()[0], 4, "late result from old read");
  assert.equal(h.A.state.settings.title, "first confirmed result");
  assert.equal(h.stored("nocturne.ver"), "3");
  h.foreground();
  await response(h.gets()[2], 4, "new read result");
  assert.equal(h.A.state.settings.title, "new read result");
});

test("legacy stale acknowledgements cannot grant replacement rights over a newer local edit", { skip: SKIP }, async t => {
  const h = await page(t);
  h.edit("submitted"); await h.advance(900);
  h.edit("newer local edit");
  h.puts()[0].resolve({ stale: true, version: 7 }); await settle(); await settle();
  for (const get of h.gets()) await response(get, 7, "legacy remote");
  assert.equal(h.A.state.settings.title, "newer local edit");
  assert.equal(h.cached().settings.title, "newer local edit");
  assert.equal(h.stored("nocturne.dirty"), "1");
  await h.advance(900);
  assert.equal(h.puts()[1].body.data.settings.title, "newer local edit");
});

test("legacy stale refresh retains edits made after its GET starts", { skip: SKIP }, async t => {
  const h = await page(t);
  h.edit("submitted"); await h.advance(900);
  h.puts()[0].resolve({ stale: true, version: 7 }); await settle(); await settle();
  h.edit("edited during legacy GET");
  await response(h.gets()[0], 7, "legacy remote");
  assert.equal(h.A.state.settings.title, "edited during legacy GET");
  assert.equal(h.stored("nocturne.dirty"), "1");
  await h.advance(900);
  assert.equal(h.puts()[1].body.data.settings.title, "edited during legacy GET");
});
