"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jsdom, SKIP } = require("./browser");

const PUBLIC = path.join(__dirname, "..", "public");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const SECOND = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const INLINE = "data:image/png;base64," + PNG.toString("base64");
const MEDIA = { "/api/icons/abcdefghijklmnop0001": PNG, "/api/icons/abcdefghijklmnop0002": SECOND };
const SUCCESS = /已导出|已发起.*下载|已导入|已恢复默认|已改用服务器版本/;
const FAILURE = /失败|无法|未导入|未恢复|变化|变更|取消|过期|重新|暂时/;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const json = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function initial(icons = 1) {
  const items = [
    { id: "item-a", title: "NAS image A", lan: "http://a.test/", icon: { type: "image", value: "api/icons/abcdefghijklmnop0001", bg: "#112233" } },
    { id: "item-inline", title: "Inline", lan: "http://inline.test/", icon: { type: "image", value: INLINE } },
    { id: "item-remote", title: "Remote", wan: "https://remote.test/", icon: { type: "image", value: "https://remote.test/icon.png" } },
  ];
  return { settings: { title: "captured configuration", net: "wan", wallpaper: { id: "custom", file: true, v: 23, url: "", tint: 0.4 } }, groups: icons ? [{ id: "group-a", name: "Owned icons", items }, ...(icons > 1 ? [{ id: "group-b", name: "Second", items: [{ id: "item-b", title: "NAS image B", wan: "https://b.test/", icon: { type: "image", value: "api/icons/abcdefghijklmnop0002" } }] }] : [])] : [], recent: ["item-a"], future: { preserved: ["extension", 7] } };
}

async function page(t, options = {}) {
  const { JSDOM, ResourceLoader, VirtualConsole } = jsdom;
  const requests = [], downloads = [], errors = [], readers = [], timers = new Map(), blobs = new Map();
  let now = 0, timerId = 0, NativeReader;
  class Loader extends ResourceLoader {
    fetch(url, opts) { return Promise.resolve(opts.element.localName === "script" ? fs.readFileSync(path.join(PUBLIC, new URL(url).pathname)) : Buffer.from("")); }
  }
  const vc = new VirtualConsole();
  vc.on("jsdomError", error => errors.push(String(error.message)));
  vc.on("error", error => errors.push(String(error)));
  const dom = new JSDOM(fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8"), {
    url: "http://nocturne.test/", runScripts: "dangerously", resources: new Loader(), pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      if (!options.static) win.NOCTURNE = { backend: true, user: { name: "reader", admin: false }, auth: false, version: 1 };
      win.localStorage.setItem("yeqv.v1", JSON.stringify(initial(options.icons ?? 1)));
      win.localStorage.setItem("nocturne.owner", "reader");
      win.localStorage.setItem("nocturne.ver", "1");
      win.structuredClone = structuredClone;
      win.TextEncoder = TextEncoder;
      win.matchMedia = media => ({ matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.setTimeout = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, due: now + delay }); return id; };
      win.clearTimeout = id => timers.delete(id);
      win.setInterval = () => ++timerId;
      win.clearInterval = () => {};
      win.URL.createObjectURL = blob => { if (options.failDownload) throw new Error("download unavailable"); const url = "blob:http://nocturne.test/" + (blobs.size + 1); blobs.set(url, blob); return url; };
      win.URL.revokeObjectURL = () => {};
      win.HTMLAnchorElement.prototype.click = function () { if (options.failClick && this.download) throw new Error("download anchor unavailable"); if (this.download) downloads.push({ name: this.download, blob: blobs.get(this.href) }); };
      NativeReader = win.FileReader;
      win.FileReader = class extends NativeReader {
        readAsDataURL(blob) {
          const done = deferred(), record = { reader: this, blob, done };
          readers.push(record);
          for (const event of ["load", "error", "abort"]) this.addEventListener(event, () => { record.event = event; done.resolve(); }, { once: true });
          record.finish = event => event === "load" ? super.readAsDataURL(blob) : this.dispatchEvent(new win.Event(event));
          if (options.reader !== "hold") record.finish(options.reader || "load");
        }
      };
      win.fetch = (url, opts = {}) => {
        const parsed = new URL(url, "http://nocturne.test/"), request = { path: parsed.pathname, method: opts.method || "GET", credentials: opts.credentials, body: typeof opts.body === "string" ? JSON.parse(opts.body) : undefined, pending: true };
        requests.push(request);
        if (!/^\/api\/(?:icons\/|config(?:\/stash)?$)/.test(parsed.pathname)) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        const pending = deferred();
        request.respond = (data = {}, status = 200) => { request.pending = false; pending.resolve({ ok: status >= 200 && status < 300, status, json: async () => json(data), blob: async () => new win.Blob([MEDIA[request.path] || PNG], { type: "image/png" }) }); };
        request.reject = () => { request.pending = false; pending.reject(new TypeError("synthetic offline")); };
        return pending.promise;
      };
    },
  });
  const win = dom.window;
  const readBlob = blob => new Promise((resolve, reject) => { const reader = new NativeReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsText(blob); });
  t.after(async () => {
    win.close();
    assert.deepEqual(errors, [], "the complete page has no runtime script errors");
  });
  await new Promise(resolve => win.addEventListener("load", resolve));
  await flush();
  assert.deepEqual(errors, [], "the complete page boots without script errors");
  const h = {
    win, requests, downloads, readers, errors,
    get A() { return win.App; },
    state: () => json(win.App.state),
    raw: () => win.localStorage.getItem("yeqv.v1"),
    stored: key => win.localStorage.getItem(key),
    media: () => requests.filter(request => request.path.startsWith("/api/icons/")),
    puts: () => requests.filter(request => request.path === "/api/config" && request.method === "PUT"),
    gets: () => requests.filter(request => request.path === "/api/config" && request.method === "GET"),
    stashes: () => requests.filter(request => request.path === "/api/config/stash"),
    toast: () => win.document.getElementById("x-toast-msg").textContent,
    message() { const error = win.document.querySelector("[data-err]"); return this.toast() + (error.hidden ? "" : " " + error.textContent); },
    click(action) { const button = win.document.querySelector('[data-d="' + action + '"]'); assert.ok(button); button.click(); },
    reset() { this.click("reset"); this.click("confirm"); },
    import(data, textPromise) {
      const input = win.document.querySelector("[data-file]"), text = JSON.stringify(data), file = new win.File([text], "import.json", { type: "application/json" });
      file.text = () => textPromise || Promise.resolve(text);
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new win.Event("change", { bubbles: true }));
    },
    async download(index = 0) {
      assert.ok(downloads[index] && downloads[index].blob, "a real Blob was passed to a clicked download anchor");
      const text = await readBlob(downloads[index].blob);
      return { name: downloads[index].name, text, data: JSON.parse(text) };
    },
    async mediaDone(fault) {
      await flush();
      const queued = this.media().filter(request => request.pending);
      assert.ok(queued.length, "the real exporter requests a promised NAS icon");
      for (const request of queued) {
        if (fault === "network") request.reject();
        else request.respond({}, typeof fault === "number" ? fault : 200);
      }
      await flush();
      if (options.reader !== "hold" && (!fault || fault === "reader")) await Promise.all(readers.map(record => record.done.promise));
      await flush();
    },
    async advance(ms) {
      const target = now + ms;
      let count = 0;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        assert.ok(++count < 2000, "the deterministic clock makes progress");
        const [id, timer] = next; now = timer.due; timers.delete(id); timer.fn(); await flush();
      }
      now = target; await flush();
    },
  };
  return h;
}

function expectedPortable(captured) {
  const expected = json(captured);
  for (const group of expected.groups) for (const item of group.items || []) {
    if (item.id === "item-a") item.icon.value = "data:image/png;base64," + PNG.toString("base64");
    if (item.id === "item-b") item.icon.value = "data:image/png;base64," + SECOND.toString("base64");
  }
  return expected;
}

function watch(promise) {
  const result = { status: "pending" };
  Promise.resolve(promise).then(value => { result.status = "fulfilled"; result.value = value; }, error => { result.status = "rejected"; result.error = error; });
  return result;
}

function replace(h, action, data = { settings: { title: "import replacement" }, groups: [] }) { if (action === "reset") h.reset(); else h.import(data); }

async function conflict(t, options = {}) {
  const h = await page(t, options);
  h.A.commit(state => { state.settings.title = "local conflict snapshot"; }, "settings");
  await h.advance(900);
  assert.equal(h.puts().length, 1);
  h.puts()[0].respond({ conflict: true, version: 7, groups: 1, items: 1 }, 409);
  await flush();
  assert.ok(h.win.document.querySelector(".nc-cfs.is-on"));
  h.chooseServer = () => h.win.document.querySelector('.nc-cfs.is-on [data-cf="server"]').click();
  return h;
}

test("C01 a plain export downloads the exact full configuration without media requests", { skip: SKIP }, async t => {
  const h = await page(t, { icons: 0 }), captured = h.state(), raw = h.raw();
  h.click("export"); await flush();
  assert.equal(h.downloads.length, 1);
  const exported = await h.download();
  assert.deepEqual(exported.data, captured);
  assert.match(exported.name, /^yeqv-backup-.*\.json$/);
  assert.equal(h.media().length, 0);
  assert.match(h.toast(), /已导出/);
  assert.match(h.toast(), /壁纸.*不包含/);
  assert.equal(h.raw(), raw);
  assert.equal(h.A.undo(), false);
  await h.advance(900); assert.equal(h.puts().length, 0);
});

test("C02 complete NAS export uses captured state and excludes wallpaper bytes", { skip: SKIP }, async t => {
  const h = await page(t, { icons: 2 }), captured = h.state(), source = json(captured);
  const result = watch(h.A.exportState(captured));
  h.A.state.settings.title = "later live edit"; h.A.state.recent = ["later"];
  await h.mediaDone();
  assert.equal(result.status, "fulfilled");
  assert.deepEqual(json(result.value), expectedPortable(source));
  assert.deepEqual(captured, source, "export preparation leaves its captured input unchanged");
  assert.equal(h.A.state.settings.title, "later live edit");
  assert.equal(h.media().length, 2);
  assert.ok(h.media().every(request => request.credentials === "same-origin"));
  assert.equal(h.requests.filter(request => request.path === "/api/wallpaper").length, 0);
  assert.equal(h.downloads.length, 0);
});

test("C03 explicit successful export downloads every NAS icon byte and preserves state, cache and undo", { skip: SKIP }, async t => {
  const h = await page(t, { icons: 2 }), captured = h.state(), raw = h.raw();
  h.click("export"); await h.mediaDone();
  assert.equal(h.downloads.length, 1);
  assert.deepEqual((await h.download()).data, expectedPortable(captured));
  assert.match(h.toast(), /已导出/);
  assert.match(h.toast(), /壁纸.*不包含/);
  assert.deepEqual(h.state(), captured); assert.equal(h.raw(), raw);
  assert.equal(h.A.undo(), false);
  await h.advance(900); assert.equal(h.puts().length, 0);
});

test("C07 an explicit export keeps its captured full snapshot after a later live edit", { skip: SKIP }, async t => {
  const h = await page(t, { icons: 2 }), captured = h.state();
  h.click("export"); await flush();
  h.A.commit(state => { state.settings.title = "later live configuration"; state.settings.wallpaper = { id: "none" }; state.future.preserved.push("later extension"); }, "settings");
  const current = h.state(), raw = h.raw();
  await h.mediaDone();
  assert.equal(h.downloads.length, 1); assert.deepEqual((await h.download()).data, expectedPortable(captured));
  assert.match(h.toast(), /壁纸.*不包含/, "the notice describes the wallpaper in the captured export");
  assert.deepEqual(h.state(), current); assert.equal(h.raw(), raw);
  assert.equal(h.A.undo(), true); assert.deepEqual(h.state(), captured); assert.equal(h.A.undo(), false);
});

const faults = [["HTTP404", 404, undefined], ["HTTP503", 503, undefined], ["network", "network", undefined], ["FileReader error", "reader", "error"], ["FileReader abort", "reader", "abort"]];
for (const [name, fault, reader] of faults) {
  test("G01 " + name + " rejects portable export preparation", { skip: SKIP }, async t => {
    const h = await page(t, { reader }), captured = h.state(), result = watch(h.A.exportState(captured));
    await h.mediaDone(fault);
    assert.equal(result.status, "rejected", "an incomplete portable backup rejects rather than resolving or hanging");
    assert.deepEqual(captured, h.state());
    assert.equal(h.downloads.length, 0);
  });

  test("G02 " + name + " explicit export has no false success or download", { skip: SKIP }, async t => {
    const h = await page(t, { reader }), before = h.state(), raw = h.raw();
    h.click("export"); await h.mediaDone(fault);
    assert.equal(h.downloads.length, 0, "failed explicit exports never download a partial JSON");
    assert.doesNotMatch(h.message(), SUCCESS);
    assert.match(h.message(), FAILURE);
    assert.deepEqual(h.state(), before); assert.equal(h.raw(), raw);
    assert.equal(h.A.undo(), false);
    await h.advance(900); assert.equal(h.puts().length, 0);
  });
}

test("G03 an explicit export reports success only after the complete download is ready", { skip: SKIP }, async t => {
  const h = await page(t, { reader: "hold" });
  h.click("export"); await flush();
  assert.equal(h.downloads.length, 0);
  assert.doesNotMatch(h.message(), SUCCESS, "requesting icons is not export success");
  await h.mediaDone();
  assert.equal(h.downloads.length, 0);
  assert.doesNotMatch(h.message(), SUCCESS, "reading image bytes is not export success");
  for (const record of h.readers) record.finish("load");
  await Promise.all(h.readers.map(record => record.done.promise)); await flush();
  assert.equal(h.downloads.length, 1); assert.match(h.toast(), /已导出/);
});

for (const action of ["reset", "import"]) {
  test("C04 plain " + action + " backs up, replaces, writes, and can be undone", { skip: SKIP }, async t => {
    const h = await page(t, { icons: 0 }), captured = h.state();
    replace(h, action); await flush();
    assert.equal(h.downloads.length, 1); assert.deepEqual((await h.download()).data, captured);
    assert.equal(h.A.state.settings.title, action === "reset" ? h.A.defaults.settings.title : "import replacement");
    assert.equal(h.A.state.settings.net, captured.settings.net); assert.deepEqual([...h.A.state.recent], captured.recent);
    assert.match(h.toast(), action === "reset" ? /已恢复默认/ : /已导入/);
    await h.advance(900); assert.equal(h.puts().length, 1);
    assert.equal(h.A.undo(), true); assert.deepEqual(h.state(), captured);
  });

  test("G04 " + action + " awaits the complete captured backup before replacement or a PUT", { skip: SKIP }, async t => {
    const h = await page(t, { reader: "hold" }), captured = h.state(), raw = h.raw();
    replace(h, action); await flush();
    assert.deepEqual(h.state(), captured, "replacement waits while the icon request is pending");
    assert.equal(h.raw(), raw); assert.equal(h.downloads.length, 0);
    assert.doesNotMatch(h.message(), SUCCESS);
    await h.advance(900); assert.equal(h.puts().length, 0);
    await h.mediaDone();
    assert.deepEqual(h.state(), captured, "replacement also waits while FileReader is pending");
    assert.equal(h.raw(), raw); assert.equal(h.downloads.length, 0);
    for (const record of h.readers) record.finish("load");
    await Promise.all(h.readers.map(record => record.done.promise)); await flush();
    assert.equal(h.downloads.length, 1); assert.deepEqual((await h.download()).data, expectedPortable(captured));
    assert.equal(h.A.state.settings.title, action === "reset" ? h.A.defaults.settings.title : "import replacement");
    await h.advance(900); assert.equal(h.puts().length, 1);
    assert.equal(h.A.undo(), true); assert.deepEqual(h.state(), captured);
  });

  for (const [name, fault, reader] of faults) {
    test("G05 " + action + " retains state, exact cache, undo and API state on " + name + " backup failure", { skip: SKIP }, async t => {
      const h = await page(t, { reader });
      h.A.commit(state => { state.settings.title = "existing undo entry"; }, "settings");
      const captured = h.state(), raw = h.raw();
      replace(h, action); await h.mediaDone(fault);
      assert.deepEqual(h.state(), captured, "failed backups grant no replacement permission");
      assert.equal(h.raw(), raw); assert.equal(h.downloads.length, 0);
      assert.doesNotMatch(h.message(), SUCCESS); assert.match(h.message(), FAILURE);
      await h.advance(900);
      assert.equal(h.puts().length, 1, "only the pre-existing user's edit is submitted");
      assert.equal(h.puts()[0].body.data.settings.title, "existing undo entry");
      assert.equal(h.A.undo(), true); assert.equal(h.A.state.settings.title, "captured configuration");
      assert.equal(h.A.undo(), false, "failed backup added no undo entry");
    });
  }

  for (const edit of ["full-state", "device-local"]) {
    test("G06 " + action + " cannot discard intervening " + edit + " edits", { skip: SKIP }, async t => {
      const h = await page(t), captured = h.state();
      replace(h, action); await flush();
      if (edit === "full-state") h.A.commit(state => { state.settings.title = "edited during backup"; state.future.preserved.push("new"); }, "settings");
      else { h.A.state.settings.net = "lan"; h.A.state.recent = ["opened while backup waits"]; h.A.save(); }
      const retained = h.state(), raw = h.raw();
      await h.mediaDone();
      assert.deepEqual(h.state(), retained); assert.equal(h.raw(), raw);
      assert.doesNotMatch(h.message(), /已导入|已恢复默认/); assert.match(h.message(), FAILURE);
      for (let i = 0; i < h.downloads.length; i++) assert.deepEqual((await h.download(i)).data, expectedPortable(captured), "any completed backup remains bound to its capture");
      await h.advance(900);
      assert.equal(h.puts().length, edit === "full-state" ? 1 : 0);
      if (edit === "full-state") { assert.equal(h.puts()[0].body.data.settings.title, "edited during backup"); assert.equal(h.A.undo(), true); assert.deepEqual(h.state(), captured); }
      assert.equal(h.A.undo(), false, "a cancelled replacement adds no undo entry");
    });
  }
}

for (const later of ["reset", "import"]) {
  test("G07 a later same-content " + later + " supersedes an older pending import file read", { skip: SKIP }, async t => {
    const h = await page(t, { icons: 0 });
    h.reset(); await flush();
    const identical = h.state(), raw = h.raw(), oldFile = deferred();
    const oldImport = { settings: { title: "obsolete selected file" }, groups: [] };
    h.import(oldImport, oldFile.promise); await flush();
    replace(h, later, identical); await flush();
    assert.equal(h.raw(), raw, "the later explicit replacement leaves the full raw snapshot identical");
    const downloads = h.downloads.length;
    oldFile.resolve(JSON.stringify(oldImport)); await flush();
    assert.equal(h.raw(), raw, "an earlier file selection cannot become newer when its read resolves late");
    assert.deepEqual(h.state(), identical);
    assert.equal(h.downloads.length, downloads, "the obsolete file selection does not start another backup");
    await h.advance(900);
    assert.ok(h.puts().every(request => request.body.data.settings.title !== "obsolete selected file"));
  });
}

test("C05 explicit export does not supersede a pending import selection", { skip: SKIP }, async t => {
  const h = await page(t, { icons: 0 }), file = deferred(), imported = { settings: { title: "still selected" }, groups: [] };
  h.import(imported, file.promise); h.click("export"); await flush();
  file.resolve(JSON.stringify(imported)); await flush();
  assert.equal(h.A.state.settings.title, "still selected");
  assert.equal(h.downloads.length, 2);
});

test("C06 rejected stash fallback downloads the captured complete snapshot and preserves newer device-local values", { skip: SKIP }, async t => {
  const h = await conflict(t), captured = h.state();
  h.chooseServer();
  h.A.state.settings.net = "lan"; h.A.state.recent = ["later local visit"]; h.A.save();
  h.stashes()[0].respond({ error: "too large" }, 413); await flush();
  assert.equal(h.gets().length, 0); assert.equal(h.downloads.length, 0);
  await h.mediaDone();
  assert.equal(h.downloads.length, 1); assert.deepEqual((await h.download()).data, expectedPortable(captured));
  assert.equal(h.gets().length, 1);
  h.gets()[0].respond({ version: 7, data: { settings: { title: "chosen server version" }, groups: [] } }); await flush();
  assert.equal(h.A.state.settings.title, "chosen server version");
  assert.equal(h.A.state.settings.net, "lan"); assert.deepEqual([...h.A.state.recent], ["later local visit"]);
  assert.match(h.toast(), /文件|下载/); assert.equal(h.win.document.querySelector(".nc-cfs.is-on"), null);
});

for (const [name, fault, reader] of faults) {
  test("G08 rejected stash plus " + name + " export cannot authorize discarding the local conflict", { skip: SKIP }, async t => {
    const h = await conflict(t, { reader }), captured = h.state(), raw = h.raw(), op = h.stored("nocturne.op");
    h.chooseServer(); h.stashes()[0].respond({ error: "too large" }, 413); await flush();
    await h.mediaDone(fault);
    assert.equal(h.gets().length, 0, "a failed portable fallback never authorizes the server replacement read");
    assert.equal(h.downloads.length, 0); assert.deepEqual(h.state(), captured); assert.equal(h.raw(), raw);
    assert.equal(h.stored("nocturne.op"), op); assert.equal(h.stored("nocturne.dirty"), "1"); assert.equal(h.stored("nocturne.ver"), "1");
    const sheet = h.win.document.querySelector(".nc-cfs.is-on");
    assert.ok(sheet); assert.equal(sheet.querySelector('[data-cf="server"]').disabled, false);
    assert.doesNotMatch(h.message(), SUCCESS); assert.match(h.message(), FAILURE);
    await h.advance(900); assert.equal(h.puts().length, 1);
    assert.equal(h.A.undo(), true); assert.equal(h.A.state.settings.title, "captured configuration");
    assert.equal(h.A.undo(), false);
  });
}

for (const failure of ["failDownload", "failClick"]) {
  for (const action of ["export", "reset", "import"]) {
    test(action + " retains state when " + failure + " prevents download initiation", { skip: SKIP }, async t => {
      const h = await page(t, { icons: 0, [failure]: true });
      h.A.commit(state => { state.settings.title = "existing user edit"; }, "settings");
      const captured = h.state(), raw = h.raw();
      if (action === "export") h.click(action); else replace(h, action);
      await flush();
      assert.equal(h.downloads.length, 0);
      assert.deepEqual(h.state(), captured); assert.equal(h.raw(), raw);
      assert.doesNotMatch(h.message(), SUCCESS); assert.match(h.message(), FAILURE);
      await h.advance(900);
      assert.equal(h.puts().length, 1);
      assert.equal(h.puts()[0].body.data.settings.title, "existing user edit");
      assert.equal(h.A.undo(), true); assert.equal(h.A.state.settings.title, "captured configuration");
      assert.equal(h.A.undo(), false);
    });
  }

  test("a rejected stash cannot adopt the server when " + failure + " prevents fallback download initiation", { skip: SKIP }, async t => {
    const h = await conflict(t, { icons: 0, [failure]: true }), captured = h.state(), raw = h.raw(), op = h.stored("nocturne.op");
    h.chooseServer(); h.stashes()[0].respond({ error: "too large" }, 413); await flush();
    assert.equal(h.gets().length, 0); assert.equal(h.downloads.length, 0);
    assert.deepEqual(h.state(), captured); assert.equal(h.raw(), raw);
    assert.equal(h.stored("nocturne.op"), op); assert.equal(h.stored("nocturne.dirty"), "1");
    assert.doesNotMatch(h.message(), SUCCESS); assert.match(h.message(), FAILURE);
    assert.equal(h.win.document.querySelector('.nc-cfs.is-on [data-cf="server"]').disabled, false);
  });
}

for (const action of ["export", "reset", "import"]) {
  test("static " + action + " refuses an incomplete backup with relative NAS icons", { skip: SKIP }, async t => {
    const h = await page(t, { static: true }), captured = h.state(), raw = h.raw();
    assert.equal(h.A.exportState, undefined);
    if (action === "export") h.click(action); else replace(h, action);
    await flush();
    assert.equal(h.downloads.length, 0);
    assert.deepEqual(h.state(), captured); assert.equal(h.raw(), raw);
    assert.equal(h.A.undo(), false);
    assert.doesNotMatch(h.message(), SUCCESS); assert.match(h.message(), FAILURE);
  });

  test("static " + action + " supports a complete JSON backup without NAS icons", { skip: SKIP }, async t => {
    const h = await page(t, { static: true, icons: 0 }), captured = h.state();
    assert.equal(h.A.exportState, undefined);
    if (action === "export") h.click(action); else replace(h, action);
    await flush();
    assert.equal(h.downloads.length, 1);
    assert.deepEqual((await h.download()).data, captured);
    assert.match(h.toast(), action === "export" ? /已导出/ : action === "reset" ? /已恢复默认/ : /已导入/);
    if (action === "export") assert.equal(h.A.undo(), false);
    else { assert.equal(h.A.undo(), true); assert.deepEqual(h.state(), captured); }
  });
}

for (const close of ["cancel", "reset"]) {
  test("cancelling a pending reset with " + close + " retains state, cache and undo", { skip: SKIP }, async t => {
    const h = await page(t, { reader: "hold" });
    h.A.commit(state => { state.settings.title = "existing user edit"; }, "settings");
    const captured = h.state(), raw = h.raw();
    h.reset(); await h.mediaDone();
    assert.equal(h.downloads.length, 0);
    assert.deepEqual(h.state(), captured);
    h.click(close);
    assert.equal(h.win.document.querySelector(".x-cf[data-cf]").hidden, true);
    for (const record of h.readers) record.finish("load");
    await Promise.all(h.readers.map(record => record.done.promise)); await flush();
    assert.deepEqual(h.state(), captured); assert.equal(h.raw(), raw);
    assert.doesNotMatch(h.message(), /已恢复默认/);
    for (let i = 0; i < h.downloads.length; i++) assert.deepEqual((await h.download(i)).data, expectedPortable(captured));
    await h.advance(900);
    assert.equal(h.puts().length, 1);
    assert.equal(h.puts()[0].body.data.settings.title, "existing user edit");
    assert.equal(h.A.undo(), true); assert.equal(h.A.state.settings.title, "captured configuration");
    assert.equal(h.A.undo(), false);
  });

  test("closing a reset confirmation with " + close + " retains a newer import selection", { skip: SKIP }, async t => {
    const h = await page(t, { icons: 0 }), file = deferred(), imported = { settings: { title: "newer selected import" }, groups: [] };
    h.click("reset");
    h.import(imported, file.promise); await flush();
    h.click(close);
    file.resolve(JSON.stringify(imported)); await flush();
    assert.equal(h.A.state.settings.title, "newer selected import");
    assert.equal(h.downloads.length, 1);
    assert.match(h.toast(), /已导入/);
  });
}
