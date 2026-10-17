"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

// 受控 API 响应与时钟驱动真实同步代码；保留外部审查提供的迁移竞态用例。
const Spaces = require("../public/spaces");
const source = fs.readFileSync(path.join(__dirname, "..", "public", "nocturne.js"), "utf8");
const begin = source.indexOf("  var serverVer =");
const end = source.indexOf("  /* ------------------------------------------------------- 冲突面板 */", begin);
const wiringBegin = source.indexOf('      A.on("change", schedule);');
const wiringEnd = source.indexOf("      pullStatus();", wiringBegin);
assert.ok(begin >= 0 && end > begin && wiringBegin >= 0 && wiringEnd > wiringBegin);
const syncSource = source.slice(begin, end);
const wiringSource = source.slice(wiringBegin, wiringEnd);
const settle = () => new Promise(setImmediate);
const INLINE_ICON = "data:image/png;base64,aW5saW5lLWljb24=";

function fixture() {
  return {
    version: 1,
    settings: { title: "initial", net: "auto" },
    groups: [{ id: "group", title: "Services", items: [
      { id: "one", title: "One", lan: "http://nas.test", icon: { type: "image", value: INLINE_ICON } },
      { id: "two", title: "Two", wan: "https://two.test" },
    ] }],
    recent: ["one"],
  };
}

function harness(options = {}) {
  const storage = new Map(), requests = [], timers = new Map(), handlers = new Map();
  let now = 0, timerId = 0;
  const emit = (event) => (handlers.get(event) || []).slice().forEach((fn) => fn());
  const save = () => storage.set("yeqv.v1", JSON.stringify(app.state));
  const app = {
    state: fixture(), defaults: { settings: {} }, save,
    render() { emit("render"); },
    on(event, fn) { handlers.set(event, [...(handlers.get(event) || []), fn]); },
    toast() {},
    commit(change) { change(app.state); save(); app.render(); emit("change"); },
  };
  const context = {
    A: app, N: { version: 1, user: { name: "admin" } },
    DIRTY: "nocturne.dirty", VER: "nocturne.ver", OWNER: "nocturne.owner", KEEPALIVE_MAX: 60000,
    TextEncoder, Uint8Array, Int32Array, structuredClone, crypto: crypto.webcrypto,
    window: { NocturneSpaces: Spaces }, AbortController: options.abort ? AbortController : undefined,
    wpMigrating: null, pullStatus() {}, expired() {}, conflict() {},
    migrateLocalWallpaper: () => Promise.resolve(false),
    bytes: (value) => Buffer.byteLength(value, "utf8"),
    ls: (op, key, value) => op === "get" ? storage.get(key) : op === "del" ? storage.delete(key) : storage.set(key, value),
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    api(method, endpoint, body, opts) {
      assert.equal(endpoint, "config");
      const request = { method, body: body === undefined ? undefined : structuredClone(body), pending: true, signal: opts && opts.signal };
      requests.push(request);
      return new Promise((resolve, reject) => {
        request.resolve = (value) => { request.pending = false; resolve(structuredClone(value)); };
        request.reject = (error) => { request.pending = false; reject(error); };
      });
    },
  };
  vm.createContext(context);
  vm.runInContext(syncSource + "\nlastSent = snapshot(); markSynced(N.version, lastSent);\n" + wiringSource,
    context, { filename: "public/nocturne.js (config sync)" });
  save();
  return {
    app, storage, requests,
    edit: (change) => app.commit(change),
    persisted: () => JSON.parse(storage.get("yeqv.v1")),
    puts: () => requests.filter((request) => request.method === "PUT"),
    gets: () => requests.filter((request) => request.method === "GET"),
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due; timers.delete(next[0]); next[1].fn();
        await settle();
      }
      now = target;
      await settle();
    },
    async nextPut(index) {
      for (let i = 0; i < 4 && !this.puts()[index]; i++) await this.advance(800);
      const request = this.puts()[index];
      assert.ok(request, "a newer local edit is eventually sent");
      return request;
    },
  };
}

function canonical(request, version, title) {
  const data = structuredClone(request.body.data);
  data.groups[0].items[0].icon.value = "api/icons/server-" + version;
  if (title !== undefined) data.settings.title = title;
  return { version, data };
}

async function submit(h) {
  h.edit((state) => { state.settings.title = "submitted"; });
  const request = await h.nextPut(0);
  assert.equal(request.body.baseVersion, 1);
  assert.equal(request.body.data.settings.title, "submitted");
  return request;
}

async function acknowledgeMigration(h, request, version) {
  request.resolve({ version, migrated: true });
  await settle();
  return h.gets().find((get) => get.pending);
}

test("a local edit made while the migration PUT is pending survives and remains dirty", async () => {
  const h = harness(), first = await submit(h);
  h.edit((state) => { state.settings.title = "edited during PUT"; });
  const get = await acknowledgeMigration(h, first, 2);
  if (get) { get.resolve(canonical(first, 2)); await settle(); }
  assert.equal(h.app.state.settings.title, "edited during PUT");
  assert.equal(h.persisted().settings.title, "edited during PUT");
  assert.equal(h.storage.get("nocturne.dirty"), "1");
});

test("edits and item removal made while canonical GET is pending are eventually pushed", async () => {
  const h = harness(), first = await submit(h);
  const get = await acknowledgeMigration(h, first, 2);
  assert.ok(get, "a clean migrated snapshot needs canonical file references");
  h.edit((state) => {
    state.settings.title = "edited during GET";
    state.groups[0].items[0].icon.value = "data:image/png;base64,bmV3LWljb24=";
    state.groups[0].items.splice(1, 1);
  });
  get.resolve(canonical(first, 2)); await settle();
  assert.equal(h.app.state.settings.title, "edited during GET");
  assert.equal(h.app.state.groups[0].items[0].icon.value, "data:image/png;base64,bmV3LWljb24=");
  assert.equal(h.app.state.groups[0].items.length, 1);
  assert.equal(h.persisted().groups[0].items.length, 1);
  assert.equal(h.storage.get("nocturne.dirty"), "1");
  const second = await h.nextPut(1);
  assert.equal(second.body.data.settings.title, "edited during GET");
  assert.equal(second.body.data.groups[0].items.length, 1);
});

test("same-version canonical refs are adopted and current device-local net/recent survive", async () => {
  const h = harness(), first = await submit(h);
  const get = await acknowledgeMigration(h, first, 2);
  assert.ok(get);
  h.edit((state) => { state.settings.net = "wan"; state.recent = ["two", "one"]; });
  get.resolve(canonical(first, 2)); await settle();
  assert.equal(h.app.state.groups[0].items[0].icon.value, "api/icons/server-2");
  assert.equal(h.persisted().groups[0].items[0].icon.value, "api/icons/server-2");
  assert.equal(h.app.state.settings.net, "wan");
  assert.deepEqual([...h.app.state.recent], ["two", "one"]);
  assert.equal(h.storage.get("nocturne.dirty"), undefined);
  await h.advance(2400);
  assert.equal(h.puts().length, 1, "canonicalization and device-only edits do not create another config version");
});

test("a newer pending edit uses the acknowledged version and its own opId", async () => {
  const h = harness(), first = await submit(h);
  h.edit((state) => { state.settings.title = "new snapshot"; });
  const get = await acknowledgeMigration(h, first, 2);
  if (get) { get.resolve(canonical(first, 2)); await settle(); }
  const second = await h.nextPut(1);
  assert.equal(second.body.baseVersion, 2);
  assert.notEqual(second.body.opId, first.body.opId);
  assert.equal(second.body.data.settings.title, "new snapshot");
  assert.equal(h.storage.get("nocturne.dirty"), "1");
  const secondGet = await acknowledgeMigration(h, second, 3);
  assert.ok(secondGet);
  secondGet.resolve(canonical(second, 3)); await settle();
  assert.equal(h.app.state.settings.title, "new snapshot");
  assert.equal(h.app.state.groups[0].items[0].icon.value, "api/icons/server-3");
  assert.equal(h.storage.get("nocturne.ver"), "3");
  assert.equal(h.storage.get("nocturne.dirty"), undefined);
});

test("late canonical data cannot lower a confirmed version or discard a queued newer save", async () => {
  const h = harness(), first = await submit(h);
  const oldGet = await acknowledgeMigration(h, first, 2);
  assert.ok(oldGet);
  h.edit((state) => { state.settings.title = "confirmed newer edit"; });
  await h.advance(800);
  let second = h.puts()[1];
  if (second) {
    second.resolve({ version: 3 }); await settle();
    assert.equal(h.storage.get("nocturne.ver"), "3");
    oldGet.resolve(canonical(first, 2)); await settle();
  } else {
    oldGet.resolve(canonical(first, 2)); await settle();
    second = await h.nextPut(1);
    assert.equal(second.body.data.settings.title, "confirmed newer edit");
    second.resolve({ version: 3 }); await settle();
  }
  assert.equal(h.app.state.settings.title, "confirmed newer edit");
  assert.equal(h.persisted().settings.title, "confirmed newer edit");
  assert.equal(h.storage.get("nocturne.ver"), "3");
  h.edit((state) => { state.settings.title = "after confirmed newer edit"; });
  assert.equal((await h.nextPut(2)).body.baseVersion, 3);
});

test("a newer remote canonical GET does not silently rebase a dirty local edit", async () => {
  const h = harness(), first = await submit(h);
  const get = await acknowledgeMigration(h, first, 2);
  assert.ok(get);
  h.edit((state) => { state.settings.title = "local edit"; });
  get.resolve(canonical(first, 7, "another device's edit")); await settle();
  assert.equal(h.app.state.settings.title, "local edit");
  assert.equal(h.storage.get("nocturne.dirty"), "1");
  const second = await h.nextPut(1);
  assert.equal(second.body.baseVersion, 2, "the server must still detect another device's intervening write as a conflict");
  assert.equal(second.body.data.settings.title, "local edit");
});

test("a failed canonical GET retains newer edits and allows them to be retried", async () => {
  const h = harness(), first = await submit(h);
  const get = await acknowledgeMigration(h, first, 2);
  assert.ok(get);
  h.edit((state) => { state.settings.title = "edit survives GET failure"; });
  get.reject(Object.assign(new Error("offline"), { status: 503 })); await settle();
  assert.equal(h.app.state.settings.title, "edit survives GET failure");
  assert.equal(h.persisted().settings.title, "edit survives GET failure");
  assert.equal(h.storage.get("nocturne.dirty"), "1");
  const second = await h.nextPut(1);
  assert.equal(second.body.baseVersion, 2);
  assert.notEqual(second.body.opId, first.body.opId);
  assert.equal(second.body.data.settings.title, "edit survives GET failure");
});

test("a stalled canonical GET cannot indefinitely block newer automatic saves", async () => {
  const h = harness(), first = await submit(h);
  const get = await acknowledgeMigration(h, first, 2);
  assert.ok(get);
  h.edit((state) => { state.settings.title = "edit survives stalled GET"; });
  await h.advance(20000);
  const second = h.puts()[1];
  assert.ok(second, "a newer edit must be sent without waiting indefinitely for optional canonical data");
  assert.equal(second.body.baseVersion, 2);
  assert.notEqual(second.body.opId, first.body.opId);
  assert.equal(second.body.data.settings.title, "edit survives stalled GET");
  assert.equal(h.storage.get("nocturne.dirty"), "1");
  second.resolve({ version: 3 }); await settle();
  get.resolve(canonical(first, 2)); await settle();
  assert.equal(h.app.state.settings.title, "edit survives stalled GET");
  assert.equal(h.persisted().settings.title, "edit survives stalled GET");
  assert.equal(h.storage.get("nocturne.ver"), "3");
  assert.equal(h.storage.get("nocturne.dirty"), undefined);
});

test("space edits during canonical GET retain references and V2 capabilities on retry", async () => {
  const h = harness();
  h.edit(state => { state.spaces = [{ id: "nas", name: "NAS", groupIds: ["group"], excludeItemIds: ["two"] }]; });
  const first = await submit(h), get = await acknowledgeMigration(h, first, 2);
  assert.ok(get);
  h.edit(state => { state.spaces[0].name = "Private NAS"; state.spaces[0].itemIds = ["two"]; delete state.spaces[0].excludeItemIds; });
  get.resolve(canonical(first, 2)); await settle();
  const second = await h.nextPut(1);
  assert.equal(second.body.baseVersion, 2);
  assert.deepEqual([...second.body.caps], ["spaces", "spaces:" + Spaces.SCHEMA]);
  assert.equal(second.body.data.spaces[0].name, "Private NAS");
  assert.deepEqual(second.body.data.spaces[0].itemIds, ["two"]);
  assert.equal(second.body.data.spaces[0].excludeItemIds, undefined);
  assert.equal(h.persisted().spaces[0].name, "Private NAS");
});

test("canonical GET older than its accepted PUT cannot lower the saved version", async () => {
  const h = harness(), first = await submit(h), get = await acknowledgeMigration(h, first, 2);
  assert.ok(get);
  get.resolve(canonical(first, 1, "obsolete")); await settle();
  assert.equal(h.app.state.settings.title, "submitted");
  assert.equal(h.storage.get("nocturne.ver"), "2");
  h.edit(state => { state.settings.title = "next"; });
  assert.equal((await h.nextPut(1)).body.baseVersion, 2);
});

test("canonical GET deadline aborts the request and keeps newer edits retryable", async () => {
  const h = harness({ abort: true }), first = await submit(h), get = await acknowledgeMigration(h, first, 2);
  assert.ok(get);
  h.edit(state => { state.settings.title = "after deadline"; });
  await h.advance(11000);
  assert.equal(get.signal && get.signal.aborted, true);
  const second = await h.nextPut(1);
  assert.equal(second.body.data.settings.title, "after deadline");
  second.resolve({ version: 3 }); await settle();
  get.resolve(canonical(first, 2, "late response")); await settle();
  assert.equal(h.app.state.settings.title, "after deadline");
  assert.equal(h.storage.get("nocturne.ver"), "3");
});
