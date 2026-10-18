"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jsdom, SKIP, importFile } = require("./browser");
const { startServer, client } = require("./helpers");

const PUBLIC = path.join(__dirname, "..", "public");
const initial = () => ({ settings: { title: "retained", net: "wan" }, groups: [], recent: ["local"] });
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

async function page(t, options = {}) {
  const { JSDOM, ResourceLoader, VirtualConsole } = jsdom;
  const requests = [], downloads = [], errors = [], timers = new Map();
  let now = 0, timerId = 0;
  class Loader extends ResourceLoader {
    fetch(url, opts) {
      return Promise.resolve(opts.element.localName === "script" ? fs.readFileSync(path.join(PUBLIC, new URL(url).pathname)) : Buffer.from(""));
    }
  }
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(String(e.message)));
  vc.on("error", e => errors.push(String(e)));
  const dom = new JSDOM(fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8"), {
    url: "http://nocturne.test/", runScripts: "dangerously", resources: new Loader(), pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      if (options.backend) win.NOCTURNE = { backend: true, user: { name: "reader", admin: false }, auth: false, version: options.version ?? 1 };
      win.localStorage.setItem("yeqv.v1", options.raw ?? JSON.stringify(initial()));
      win.localStorage.setItem("nocturne.owner", "reader");
      win.localStorage.setItem("nocturne.ver", "1");
      if (options.dirty) win.localStorage.setItem("nocturne.dirty", "1");
      if (options.failRecovery) {
        const setItem = win.Storage.prototype.setItem;
        win.Storage.prototype.setItem = function (key, value) {
          if (key === "nocturne.cacheRecovery") throw new Error("storage quota");
          return setItem.call(this, key, value);
        };
      }
      win.structuredClone = structuredClone;
      win.TextEncoder = TextEncoder;
      win.matchMedia = media => ({ matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.URL.createObjectURL = blob => { downloads.push(blob); return "blob:test/" + downloads.length; };
      win.URL.revokeObjectURL = () => {};
      win.HTMLAnchorElement.prototype.click = function () {};
      win.setTimeout = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, due: now + delay }); return id; };
      win.clearTimeout = id => timers.delete(id);
      win.setInterval = () => ++timerId;
      win.clearInterval = () => {};
      win.fetch = (url, opts = {}) => {
        const u = new URL(url, "http://nocturne.test/");
        if (!/^\/api\/config(?:\/stash)?$/.test(u.pathname)) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        const req = { path: u.pathname, method: opts.method || "GET", body: opts.body && JSON.parse(opts.body) };
        requests.push(req);
        return new Promise((resolve, reject) => {
          req.resolve = (data, status = 200) => resolve({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
          req.reject = () => reject(new TypeError("offline"));
        });
      };
    },
  });
  const win = dom.window;
  t.after(() => win.close());
  await new Promise(resolve => win.addEventListener("load", resolve));
  await settle();
  return {
    win, requests, downloads, errors,
    get A() { return win.App; },
    raw: () => win.localStorage.getItem("yeqv.v1"),
    stored: key => win.localStorage.getItem(key),
    gets: () => requests.filter(r => r.path === "/api/config" && r.method === "GET"),
    puts: () => requests.filter(r => r.path === "/api/config" && r.method === "PUT"),
    stashes: () => requests.filter(r => r.path === "/api/config/stash"),
    foreground() { win.document.dispatchEvent(new win.Event("visibilitychange")); },
    async advance(ms) {
      const target = now + ms;
      let count = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, v]) => v.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        assert.ok(++count < 2000, "the page clock makes progress");
        const [id, timer] = next; now = timer.due; timers.delete(id); timer.fn(); await settle();
      }
      now = target; await settle();
    },
  };
}

const invalid = [
  ["settings array", { settings: [], groups: [] }],
  ["settings number", { settings: 5, groups: [] }],
  ["engines object", { settings: { engines: {} }, groups: [] }],
  ["engines null", { settings: { engines: null }, groups: [] }],
  ["engine null member", { settings: { engines: [null] }, groups: [] }],
  ["group array", { settings: {}, groups: [[]] }],
  ["item null member", { settings: {}, groups: [{ items: [null] }] }],
  ["duplicate group IDs", { settings: {}, groups: [{ id: 1 }, { id: "1" }] }],
  ["duplicate global item IDs", { settings: {}, groups: [{ items: [{ id: "same", title: "A", lan: "http://a.test" }] }, { items: [{ id: "same", title: "B", lan: "http://b.test" }] }] }],
  ["duplicate engine IDs", { settings: { engines: [{ id: 0, url: "https://a.test?q=%s" }, { id: "0", url: "https://b.test?q=%s" }] }, groups: [] }],
  ["object ID", { settings: {}, groups: [{ id: {} }] }],
  ["boolean ID", { settings: {}, groups: [{ id: false }] }],
];

for (const [name, data] of invalid) {
  test("import rejects " + name + " before changing state, cache, undo, downloads or writes", { skip: SKIP }, async t => {
    const h = await page(t, { backend: true }), before = h.raw();
    importFile(h, data); await settle();
    assert.equal(h.raw(), before, "rejected imports retain the exact cache");
    assert.equal(h.A.state.settings.title, "retained");
    assert.equal(h.A.undo(), false, "rejected imports do not add undo entries");
    assert.equal(h.downloads.length, 0, "rejected imports do not claim a backup or start a download");
    await h.advance(900);
    assert.equal(h.puts().length, 0);
    assert.equal(h.win.document.querySelector("[data-err]").hidden, false);
    assert.deepEqual(h.errors, []);
  });
}

for (const raw of ["{broken", "", JSON.stringify({ settings: [], groups: [] }), JSON.stringify({ settings: 5, groups: [] }), JSON.stringify({ settings: { engines: {} }, groups: [] })]) {
  test("invalid static cache remains byte-for-byte recoverable " + JSON.stringify(raw), { skip: SKIP }, async t => {
    const h = await page(t, { raw });
    h.A.save();
    assert.equal(h.raw(), raw);
    assert.deepEqual(h.errors, []);
  });
}

for (const version of [0, 5]) {
  test("invalid cache cannot be auto-pushed or certified by failed backend reads at version " + version, { skip: SKIP }, async t => {
    const raw = "{broken", h = await page(t, { backend: true, version, raw, dirty: true });
    for (const get of h.gets()) get.reject();
    await settle();
    h.A.save(); h.A.commit(state => { state.settings.title = "fallback edit"; }, "settings");
    h.foreground(); await h.advance(16000);
    assert.equal(h.raw(), raw);
    assert.equal(h.puts().length, 0);
    assert.equal(h.stored("nocturne.dirty"), "1");
    assert.equal(h.stored("nocturne.ver"), "1");
    assert.deepEqual(h.errors, []);
  });
}

test("validated server recovery may replace a malformed cache", { skip: SKIP }, async t => {
  const h = await page(t, { backend: true, version: 5, raw: "{broken", dirty: true });
  assert.equal(h.puts().length, 0);
  assert.ok(h.gets()[0]);
  h.gets()[0].resolve({ version: 5, data: initial() }); await settle();
  assert.equal(JSON.parse(h.raw()).settings.title, "retained");
  assert.equal(h.stored("nocturne.cacheRecovery"), "{broken");
  h.A.commit(state => { state.settings.title = "after recovery"; }, "settings");
  await h.advance(900);
  assert.equal(h.puts()[0].body.data.settings.title, "after recovery");
  assert.equal(h.puts()[0].body.baseVersion, 5);
});

test("a stalled cache recovery does not block explicit recovery or let its late response replace it", { skip: SKIP }, async t => {
  const h = await page(t, { backend: true, version: 0, raw: "{broken", dirty: true });
  const pending = h.gets()[0];
  importFile(h, { settings: { title: "explicit recovery" }, groups: [] }); await settle(); await h.advance(900);
  assert.equal(h.puts().length, 1);
  h.puts()[0].resolve({ version: 1 }); await settle();
  pending.resolve({ version: 0, data: initial() }); await settle();
  assert.equal(h.A.state.settings.title, "explicit recovery");
  assert.equal(JSON.parse(h.raw()).settings.title, "explicit recovery");
  assert.equal(h.stored("nocturne.ver"), "1");
});

for (const action of ["reset", "import"]) {
  test("late recovery GET retains explicit same-content " + action + " before PUT acknowledgement", { skip: SKIP }, async t => {
    const raw = "{broken", h = await page(t, { backend: true, version: 5, raw, dirty: true });
    const pending = h.gets()[0], displayed = JSON.stringify(h.A.state);
    if (action === "reset") h.win.document.querySelector('[data-d="confirm"]').click();
    else importFile(h, structuredClone(h.A.defaults));
    await settle();
    const chosen = JSON.stringify(h.A.state);
    assert.equal(chosen, displayed, "the explicit choice equals the displayed fallback defaults");
    assert.equal(h.raw(), chosen);
    assert.equal(h.stored("nocturne.cacheRecovery"), raw);
    assert.equal(h.puts().length, 0, "the recovery GET resolves before the save debounce");
    pending.resolve({ version: 5, data: { settings: { title: "older NAS recovery response" }, groups: [] } });
    await settle();
    assert.equal(h.A.state.settings.title, h.A.defaults.settings.title, "the old response cannot replace the explicit choice");
    assert.equal(JSON.stringify(h.A.state), chosen);
    assert.equal(h.raw(), chosen);
    assert.equal(h.stored("nocturne.cacheRecovery"), raw);
    assert.equal(h.stored("nocturne.dirty"), "1");
    assert.equal(h.stored("nocturne.ver"), "1");
    await h.advance(900);
    assert.equal(h.puts().length, 1);
    assert.equal(h.puts()[0].body.baseVersion, 5);
    assert.equal(h.puts()[0].body.data.settings.title, h.A.defaults.settings.title);
    assert.deepEqual(h.puts()[0].body.data.groups, JSON.parse(chosen).groups);
    assert.deepEqual(h.errors, []);
  });
}

for (const action of ["import", "reset"]) {
  test("validated explicit " + action + " may recover a malformed cache", { skip: SKIP }, async t => {
    const h = await page(t, { backend: true, version: 0, raw: "{broken", dirty: true });
    for (const get of h.gets()) get.reject();
    await settle();
    if (action === "import") importFile(h, { settings: { title: "imported" }, groups: [] });
    else h.win.document.querySelector('[data-d="confirm"]').click();
    await settle(); await h.advance(900);
    assert.notEqual(h.raw(), "{broken");
    assert.equal(h.stored("nocturne.cacheRecovery"), "{broken");
    assert.equal(h.puts().length, 1);
    assert.equal(h.puts()[0].body.baseVersion, 0);
    assert.deepEqual(h.errors, []);
  });
}

for (const action of ["server", "import", "reset"]) {
  test("failed recovery backup preserves rejected cache and protection during " + action, { skip: SKIP }, async t => {
    const raw = "  {broken\r\n原始内容", h = await page(t, { backend: true, version: 5, raw, dirty: true, failRecovery: true });
    const before = JSON.stringify(h.A.state);
    if (action === "server") h.gets()[0].resolve({ version: 5, data: initial() });
    else {
      h.gets()[0].reject(); await settle();
      if (action === "import") importFile(h, { settings: { title: "replacement" }, groups: [] });
      else h.win.document.querySelector('[data-d="confirm"]').click();
    }
    await settle(); await h.advance(900);
    assert.equal(h.raw(), raw);
    assert.equal(h.stored("nocturne.cacheRecovery"), null);
    assert.equal(JSON.stringify(h.A.state), before);
    assert.equal(h.A.cacheRejected, true);
    assert.equal(h.puts().length, 0);
    assert.equal(h.stored("nocturne.dirty"), "1");
    assert.equal(h.stored("nocturne.ver"), "1");
    const message = h.win.document.getElementById("x-toast-msg").textContent;
    assert.match(message, /缓存|保留/);
    assert.doesNotMatch(message, /已导入|已恢复默认/);
    assert.equal(h.A.undo(), false);
    assert.deepEqual(h.errors, []);
  });
}

test("malformed remote configuration retains confirmed state and version", { skip: SKIP }, async t => {
  const h = await page(t, { backend: true }), before = h.raw();
  for (const [name, data] of invalid) {
    h.foreground();
    h.gets().at(-1).resolve({ version: 2, data }); await settle();
    assert.equal(h.raw(), before, name);
    assert.equal(h.A.state.settings.title, "retained");
    assert.equal(h.stored("nocturne.ver"), "1");
  }
  assert.deepEqual(h.errors, []);
});

test("a malformed recovery response cannot release cache protection", { skip: SKIP }, async t => {
  const raw = "{broken", h = await page(t, { backend: true, version: 5, raw, dirty: true });
  h.gets()[0].resolve({ version: 5, data: { settings: [], groups: [] } }); await settle();
  h.A.save(); h.foreground(); await h.advance(900);
  assert.equal(h.raw(), raw);
  assert.equal(h.puts().length, 0);
  assert.equal(h.stored("nocturne.dirty"), "1");
  assert.equal(h.stored("nocturne.ver"), "1");
  assert.deepEqual(h.errors, []);
});

test("malformed chosen server configuration retains conflict, cache, dirty and opId", { skip: SKIP }, async t => {
  const h = await page(t, { backend: true, version: 7, dirty: true });
  h.puts()[0].resolve({ conflict: true, version: 7, groups: 0, items: 0 }, 409); await settle();
  const before = h.raw(), op = h.stored("nocturne.op");
  h.win.document.querySelector('[data-cf="server"]').click();
  h.stashes()[0].resolve({ ok: true }); await settle();
  h.gets()[0].resolve({ version: 7, data: { settings: [], groups: [] } }); await settle();
  assert.equal(h.raw(), before);
  assert.equal(h.A.state.settings.title, "retained");
  assert.equal(h.stored("nocturne.dirty"), "1");
  assert.equal(h.stored("nocturne.ver"), "1");
  assert.equal(h.stored("nocturne.op"), op);
  assert.ok(h.win.document.querySelector(".nc-cfs.is-on"));
  assert.equal(h.win.document.querySelector('[data-cf="server"]').disabled, false);
  assert.deepEqual(h.errors, []);
});

test("malformed canonical configuration cannot replace an accepted local snapshot", { skip: SKIP }, async t => {
  const h = await page(t, { backend: true });
  h.A.commit(state => { state.settings.title = "submitted"; }, "settings");
  await h.advance(900);
  h.puts()[0].resolve({ version: 2, migrated: true }); await settle();
  const before = h.raw();
  h.gets()[0].resolve({ version: 2, data: { settings: { engines: null }, groups: [] } }); await settle();
  assert.equal(h.raw(), before);
  assert.equal(h.A.state.settings.title, "submitted");
  assert.equal(h.stored("nocturne.ver"), "2");
  assert.deepEqual(h.errors, []);
});

for (const [label, groupId, itemId] of [["string control", "group", "item"], ["zero group", 0, "item"], ["zero item", "group", 0], ["empty item", "group", ""], ["empty group", "", "item"]]) {
  test("imported " + label + " remains editable through the actual page controls", { skip: SKIP }, async t => {
    const h = await page(t), doc = h.win.document;
    importFile(h, { settings: {}, groups: [{ id: groupId, name: "Imported group", items: [{ id: itemId, title: "Imported item", lan: "http://item.test/" }] }] });
    await settle();
    doc.querySelector('.x-menu [data-m="edit"]').click();
    await settle();
    assert.equal(doc.body.classList.contains("editing"), true);
    doc.querySelector("#x-groups a[data-id]").dispatchEvent(new h.win.MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
    const actions = doc.querySelector(".x-sheet.is-on");
    assert.ok(actions, "clicking the imported tile offers its item actions");
    assert.match(actions.textContent, /编辑/);
    actions.querySelector('[data-i="0"]').click();
    await settle();
    const editor = doc.querySelector(".x-is.is-on");
    assert.ok(editor, "the actual Edit action opens the item form");
    const beforeEdit = { mode: editor.getAttribute("aria-label"), title: editor.querySelector('[name="nm"]').value, url: editor.querySelector('[name="url"]').value };
    const importedId = h.A.state.groups[0].items[0].id;
    for (const [name, value] of [["nm", "Edited item"], ["url", "http://edited.test/"]]) {
      const input = editor.querySelector('[name="' + name + '"]');
      input.value = value;
      input.dispatchEvent(new h.win.Event("input", { bubbles: true }));
    }
    editor.querySelector('[data-a="save"]').click();
    await settle();
    assert.equal(h.A.state.groups[0].items.length, 1, "Save updates the existing imported item without appending another");
    assert.deepEqual(beforeEdit, { mode: "编辑项目", title: "Imported item", url: "http://item.test/" });
    assert.equal(h.A.state.groups[0].items[0].id, importedId);
    assert.equal(h.A.state.groups[0].items[0].title, "Edited item");
    assert.equal(h.A.state.groups[0].items[0].wan, "http://edited.test/");
    assert.equal(JSON.parse(h.raw()).groups[0].items[0].title, "Edited item");
    doc.querySelector("#x-groups a[data-id]").dispatchEvent(new h.win.MouseEvent("click", { bubbles: true, cancelable: true }));
    doc.querySelector('.x-sheet.is-on [data-i="2"]').click();
    await settle();
    assert.equal(h.A.state.groups[0].items.length, 2, "the actual duplicate action finds the imported item");
    assert.equal(h.A.state.groups[0].items[1].title, "Edited item");
    const options = doc.querySelector("#x-groups .x-gmore");
    assert.ok(options, "the imported group offers its group actions");
    options.click();
    doc.querySelector('.x-sheet.is-on [data-i="0"]').click();
    const form = doc.querySelector(".x-sheet.is-on form");
    assert.ok(form, "the group rename action opens its form");
    form.querySelector("input").value = "Renamed group";
    form.dispatchEvent(new h.win.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(h.A.state.groups[0].name, "Renamed group");
    assert.equal(JSON.parse(h.raw()).groups[0].name, "Renamed group");
    assert.equal(String(h.A.state.groups[0].id), String(groupId));
    if (itemId === "") assert.ok(typeof importedId === "string" && importedId.length > 0, "an empty legacy item identity receives a usable ID");
    else assert.equal(String(h.A.state.groups[0].items[0].id), String(itemId));
    assert.deepEqual(h.errors, []);
  });
}

test("imported empty engine identity preserves selection and search through the actual page controls", { skip: SKIP }, async t => {
  const h = await page(t), doc = h.win.document, opened = [];
  h.win.open = url => opened.push(url);
  importFile(h, {
    settings: { engine: "", engines: [{ id: "other", name: "Other", url: "https://other.test?q=%s", on: true }, { id: "", name: "Empty", url: "https://empty.test?q=%s", on: true }] },
    groups: [],
  });
  await settle();
  assert.equal(h.A.state.settings.engine, "");
  assert.equal(h.A.state.settings.engines[1].id, "");
  assert.ok(doc.querySelector('#x-engines [data-eng=""][aria-pressed="true"]'));
  doc.querySelector('#x-engines [data-eng="other"]').click();
  doc.querySelector('#x-engines [data-eng=""]').click();
  doc.getElementById("x-q").value = "empty query";
  doc.getElementById("x-search").dispatchEvent(new h.win.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(opened[0], "https://empty.test?q=empty%20query");
  assert.equal(JSON.parse(h.raw()).settings.engine, "");
  assert.deepEqual(h.errors, []);
});

test("imported numeric engine selection and zero space references retain their identities", { skip: SKIP }, async t => {
  const h = await page(t), doc = h.win.document, opened = [];
  h.win.open = (...args) => opened.push(args);
  importFile(h, {
    settings: { engine: 0, engines: [{ id: "other", name: "Other", url: "https://other.test?q=%s", on: true }, { id: 0, name: "Zero", url: "https://zero.test?q=%s", on: true }] },
    groups: [{ id: 0, name: "Referenced group", items: [{ id: 0, title: "Referenced item", lan: "http://item.test/" }] }],
    spacesVersion: 1, spaces: [{ id: "s-zero", name: "Zero references", groupIds: ["0"], itemIds: ["0"] }],
  });
  await settle();
  assert.equal(h.A.state.settings.engine, "0");
  assert.equal(h.A.state.settings.engines[1].id, "0");
  assert.ok(doc.querySelector('#x-engines [data-eng="0"][aria-pressed="true"]'));
  doc.getElementById("x-q").value = "zero query";
  doc.getElementById("x-search").dispatchEvent(new h.win.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(opened[0][0], "https://zero.test?q=zero%20query");
  doc.querySelector('[data-eid="other"] .x-en').click();
  assert.equal(h.A.state.settings.engine, "other");
  doc.querySelector('[data-eid="0"] .x-en').click();
  assert.equal(h.A.state.settings.engine, "0");
  doc.querySelector('[data-space="s-zero"]').click();
  assert.ok(doc.querySelector('[data-space="s-zero"][aria-current="true"]'));
  assert.deepEqual([...doc.querySelectorAll("#x-groups .x-group")].map(el => el.getAttribute("data-gid")), ["0"]);
  assert.deepEqual([...doc.querySelectorAll("#x-groups [data-id]")].map(el => el.getAttribute("data-id")), ["0"]);
  const saved = JSON.parse(h.raw());
  assert.deepEqual(saved.spaces[0].groupIds, ["0"]);
  assert.deepEqual(saved.spaces[0].itemIds, ["0"]);
  assert.deepEqual(h.errors, []);
});

test("legacy import canonicalizes numeric identities and retains extensions while filling missing IDs without collisions", { skip: SKIP }, async t => {
  const h = await page(t);
  h.A.util.uid = () => "taken";
  const data = {
    settings: { title: 7, user: { x: 1 }, show: "yes", wallpaper: "abc", engines: [{ id: 0, url: "https://a.test?q=%s" }, { id: "taken", url: "https://b.test?q=%s" }, { url: "https://c.test?q=%s" }] },
    groups: [{ id: 0, items: null }, { id: "taken" }, { id: "__proto__", items: [{ id: "constructor", title: 3, lan: "http://a.test" }, { title: "missing", wan: "https://b.test" }] }, { items: [{ id: "taken", title: "existing", lan: "http://c.test" }, { title: "missing two", wan: "https://d.test" }, { id: "", title: "empty legacy ID", wan: "https://empty.test" }] }],
    future: { untouched: [1, 2] }, spaces: [{ id: "s-a", name: "Imported", groupIds: ["__proto__"], accent: { hue: 1 } }], spacesVersion: 1,
  };
  importFile(h, data); await settle();
  assert.equal(h.A.state.settings.title, 7);
  assert.equal(h.A.state.groups[0].id, "0");
  assert.equal(h.A.state.settings.engines[0].id, "0");
  assert.equal(h.A.state.groups[2].id, "__proto__");
  assert.equal(h.A.state.groups[2].items[0].id, "constructor");
  for (const members of [h.A.state.groups, h.A.state.groups.flatMap(g => g.items), h.A.state.settings.engines]) {
    assert.ok(members.every(x => x.id != null));
    assert.equal(new Set(members.map(x => String(x.id))).size, members.length);
  }
  assert.ok(h.A.state.groups.flatMap(g => g.items).every(item => typeof item.id === "string" && item.id.length > 0));
  assert.deepEqual(JSON.parse(h.raw()).future, { untouched: [1, 2] });
  assert.deepEqual(JSON.parse(h.raw()).spaces[0].accent, { hue: 1 });
  assert.deepEqual(h.errors, []);
});

test("legacy import still supplies omitted settings, groups and item identities", { skip: SKIP }, async t => {
  const h = await page(t);
  importFile(h, { groups: [{ items: [{ title: "legacy", lan: "http://a.test" }] }, { items: null }, {}] }); await settle();
  assert.equal(h.A.state.groups.length, 3);
  assert.ok(h.A.state.settings.engines.length);
  assert.ok(h.A.state.groups.every(g => g.id && Array.isArray(g.items)));
  assert.ok(h.A.state.groups[0].items[0].id);
  assert.deepEqual(h.errors, []);
});

test("server rejects malformed PUT and stash before replacing a readable configuration", async t => {
  const srv = await startServer({ env: { NOCTURNE_NO_AUTH: "1" }, seed(dir) {
    fs.mkdirSync(path.join(dir, "config"));
    fs.writeFileSync(path.join(dir, "config/default.json"), JSON.stringify({ version: 1, data: initial(), writer: { app: "nocturne", gen: 2 } }));
  } });
  t.after(() => srv.stop());
  const c = client(srv.base), original = fs.readFileSync(path.join(srv.dataDir, "config/default.json"));
  for (const [name, data] of invalid) {
    assert.equal((await c.put("/api/config", { baseVersion: 1, opId: "bad-" + name, data, caps: ["spaces", "spaces:1"] })).status, 400, name + " PUT");
    assert.equal((await c.post("/api/config/stash", { baseVersion: 1, data })).status, 400, name + " stash");
    assert.deepEqual(fs.readFileSync(path.join(srv.dataDir, "config/default.json")), original);
    const get = await c.get("/api/config");
    assert.equal(get.status, 200, name + " cannot corrupt subsequent reads");
    assert.equal(get.json.version, 1);
    assert.deepEqual(await fs.promises.readdir(path.join(srv.dataDir, "backup")), []);
  }
  const compatible = {
    settings: { title: 7, user: { x: 1 }, show: "yes", wallpaper: "abc", engines: [{ id: 0, url: "https://search.test?q=%s" }] },
    groups: [{ id: 0, items: null }, { id: "__proto__", items: [{ id: "constructor", lan: "http://a.test" }] }, { name: "missing IDs and items" }],
    spacesVersion: 1, spaces: [{ id: "s-a", name: "Compatible", groupIds: ["__proto__"], accent: { hue: 1 } }], future: { kept: true },
  };
  assert.equal((await c.put("/api/config", { baseVersion: 1, data: compatible, caps: ["spaces", "spaces:1"] })).status, 200);
  const accepted = await c.get("/api/config");
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.json.data, compatible);
});

test("persisted malformed collections fail closed without replacing the original bytes", async t => {
  const raw = JSON.stringify({ version: 1, data: { settings: { engines: {} }, groups: [] }, writer: { app: "nocturne", gen: 2 } });
  const srv = await startServer({ env: { NOCTURNE_NO_AUTH: "1" }, seed(dir) {
    fs.mkdirSync(path.join(dir, "config"));
    fs.writeFileSync(path.join(dir, "config/default.json"), raw);
  } });
  t.after(() => srv.stop());
  const c = client(srv.base);
  assert.equal((await c.get("/api/config")).status, 503);
  assert.equal((await c.put("/api/config", { baseVersion: 1, data: initial() })).status, 503);
  assert.equal(fs.readFileSync(path.join(srv.dataDir, "config/default.json"), "utf8"), raw);
});
