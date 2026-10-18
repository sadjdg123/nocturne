"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, client, cfg, waitFor } = require("./helpers");
const { openPage, SKIP, byText } = require("./browser");

const opt = { skip: SKIP, timeout: 20000 };
const BASE = { id: "service-a", title: "Service", lan: "http://169.254.1.20:8096", wan: "https://service.example.com", icon: { type: "text", value: "S" } };
const addresses = item => ({ lan: item.lan, wan: item.wan });
const itemIn = (state, id = BASE.id) => state.groups.flatMap(group => group.items || []).find(item => item.id === id);

async function page(t, item = BASE) {
  const srv = await startServer({ env: { NOCTURNE_NO_AUTH: "1" }, seed(dir) {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    const data = cfg("Address editor", item ? [item] : [], { groups: [
      { id: "g1", name: "Services", style: "icon", items: item ? [item] : [] },
      { id: "g2", name: "Other", style: "icon", items: [] },
    ] });
    fs.writeFileSync(path.join(dir, "config", "default.json"), JSON.stringify({ version: 7, updatedAt: "2026-10-18T00:00:00Z", data }));
  } });
  t.after(() => srv.stop());
  const c = client(srv.base);
  const p = await openPage(srv.base, c);
  t.after(async () => { await p.close(); assert.deepEqual(p.errors, [], "the complete page has no script errors"); });
  assert.equal(p.A.state.settings.title, "Address editor", "the page loads the server configuration");
  const doc = p.win.document;
  doc.querySelector('[data-act="edit"]').click();
  assert.ok(doc.body.classList.contains("editing"));
  return { p, c, srv, doc };
}

function openEdit(h) {
  const tile = h.doc.querySelector('#x-groups [data-id="' + BASE.id + '"]');
  tile.dispatchEvent(new h.p.win.MouseEvent("click", { bubbles: true, cancelable: true }));
  byText(h.doc.querySelector(".x-sheet"), "button", "编辑…").click();
  return form(h);
}

function form(h) {
  const sheet = h.doc.querySelector(".x-is");
  assert.ok(!sheet.hidden && sheet.classList.contains("is-on"), "the item form is open");
  sheet.querySelector(".x-more").open = true;
  return {
    sheet,
    field: name => sheet.querySelector('input[name="' + name + '"]'),
    type(name, value) {
      const input = this.field(name);
      input.focus();
      input.value = value;
      input.dispatchEvent(new h.p.win.Event("input", { bubbles: true }));
    },
    blurPrimary() { this.field("url").focus(); this.field("nm").focus(); },
    shown() { return { lan: this.field("lan").value, wan: this.field("wan").value }; },
  };
}

async function saveAndRead(t, h, f, expected, id = BASE.id) {
  assert.deepEqual(f.shown(), expected, "the advanced fields show the requested addresses before save");
  const save = f.sheet.querySelector('[data-a="save"]');
  assert.equal(save.disabled, false, "valid addresses enable Save");
  save.click();
  const saved = id ? itemIn(h.p.A.state, id) : h.p.A.state.groups.flatMap(group => group.items).at(-1);
  assert.ok(saved, "Save creates or updates the item");
  assert.deepEqual(addresses(saved), expected, "Save keeps the displayed addresses");
  const key = saved.id;
  assert.deepEqual(addresses(itemIn(JSON.parse(h.p.win.localStorage.getItem("yeqv.v1")), key)), expected, "local storage keeps the displayed addresses");
  const put = await waitFor(() => h.p.puts().find(request => request.status === 200), 6000, 25);
  assert.ok(put, "the saved form reaches the backend");
  assert.deepEqual(addresses(itemIn(put.body.data, key)), expected, "the save request contains the displayed addresses");
  const readback = await h.c.get("/api/config");
  assert.equal(readback.status, 200);
  assert.deepEqual(addresses(itemIn(readback.json.data, key)), expected, "backend readback keeps both addresses");
  const reload = await openPage(h.srv.base, h.c);
  t.after(async () => { await reload.close(); assert.deepEqual(reload.errors, [], "the reloaded page has no script errors"); });
  assert.deepEqual(addresses(itemIn(reload.A.state, key)), expected, "reload restores the saved addresses");
  return saved;
}

for (const entry of [
  { name: "LAN-only item keeps an advanced LAN edit", item: { ...BASE, wan: "" }, edits: { lan: "http://169.254.1.25:8096" }, expected: { lan: "http://169.254.1.25:8096", wan: "" } },
  { name: "WAN-only item keeps an advanced WAN edit", item: { ...BASE, lan: "" }, edits: { wan: "https://new.example.com" }, expected: { lan: "", wan: "https://new.example.com" } },
  { name: "a LAN edit keeps the original WAN", edits: { lan: "http://169.254.1.25:8096" }, expected: { lan: "http://169.254.1.25:8096", wan: BASE.wan } },
  { name: "a WAN edit keeps the original LAN", edits: { wan: "https://new.example.com" }, expected: { lan: BASE.lan, wan: "https://new.example.com" } },
  { name: "both advanced addresses keep their edits", edits: { lan: "http://169.254.0.9:5000", wan: "https://new.example.com" }, expected: { lan: "http://169.254.0.9:5000", wan: "https://new.example.com" } },
  { name: "clearing optional LAN keeps it empty", edits: { lan: "" }, expected: { lan: "", wan: BASE.wan } },
  { name: "clearing optional WAN keeps it empty", edits: { wan: "" }, expected: { lan: BASE.lan, wan: "" } },
  { name: "an untouched edit keeps both addresses", edits: {}, expected: { lan: BASE.lan, wan: BASE.wan } },
]) {
  test("item addresses: " + entry.name, opt, async t => {
    const h = await page(t, entry.item || BASE), f = openEdit(h);
    for (const [name, value] of Object.entries(entry.edits)) f.type(name, value);
    await saveAndRead(t, h, f, entry.expected);
  });
}

test("item addresses: leaving the unchanged primary input preserves an advanced edit", opt, async t => {
  const h = await page(t), f = openEdit(h);
  f.type("wan", "https://advanced.example.com");
  f.blurPrimary();
  await saveAndRead(t, h, f, { lan: BASE.lan, wan: "https://advanced.example.com" });
});

test("item addresses: advanced edits after a primary change own the final values", opt, async t => {
  const h = await page(t), f = openEdit(h);
  f.type("url", "https://primary.example.com");
  f.type("wan", "https://advanced.example.com");
  await saveAndRead(t, h, f, { lan: BASE.lan, wan: "https://advanced.example.com" });
});

test("item addresses: a later primary change updates its target and keeps a manual opposite address", opt, async t => {
  const h = await page(t), f = openEdit(h);
  f.type("lan", "http://169.254.0.9:5000");
  f.type("wan", "https://advanced.example.com");
  f.type("url", "https://primary.example.com");
  f.blurPrimary();
  await saveAndRead(t, h, f, { lan: "http://169.254.0.9:5000", wan: "https://primary.example.com" });
});

test("item addresses: Save applies a primary change without requiring focusout", opt, async t => {
  const h = await page(t), f = openEdit(h);
  f.type("url", "https://primary.example.com");
  f.sheet.querySelector('[data-a="save"]').click();
  assert.deepEqual(addresses(itemIn(h.p.A.state)), { lan: BASE.lan, wan: "https://primary.example.com" });
  const put = await waitFor(() => h.p.puts().find(request => request.status === 200), 6000, 25);
  assert.ok(put);
  assert.deepEqual(addresses(itemIn(put.body.data)), { lan: BASE.lan, wan: "https://primary.example.com" });
});

test("item addresses: equivalent normalized primary text preserves an advanced edit", opt, async t => {
  const h = await page(t), f = openEdit(h);
  f.type("wan", "https://advanced.example.com");
  f.type("url", "  service.example.com  ");
  f.blurPrimary();
  assert.equal(f.field("url").value, BASE.wan);
  await saveAndRead(t, h, f, { lan: BASE.lan, wan: "https://advanced.example.com" });
});

test("item addresses: new item and group picker keep default protocols and manual opposite address", opt, async t => {
  const h = await page(t, null);
  h.doc.querySelector('[data-add="g1"]').click();
  const f = form(h);
  f.type("url", "169.254.1.30:5000");
  f.type("nm", "New NAS");
  assert.equal(f.field("url").value, "http://169.254.1.30:5000");
  assert.deepEqual(f.shown(), { lan: "http://169.254.1.30:5000", wan: "" });
  f.type("lan", "http://169.254.1.30:5001");
  f.type("url", "service.example.org");
  f.blurPrimary();
  f.sheet.querySelector('[data-g="g2"]').click();
  f.sheet.querySelector('[data-m="text"]').click();
  f.type("text", "N");
  const saved = await saveAndRead(t, h, f, { lan: "http://169.254.1.30:5001", wan: "https://service.example.org" }, null);
  assert.equal(h.p.A.state.groups.find(group => group.id === "g2").items[0].id, saved.id, "the group picker chooses the saved group");
  assert.equal(saved.icon.type, "text");
  assert.equal(saved.icon.value, "N");
});

test("item addresses: pasted primary clears only its unchanged automatic opposite copy", opt, async t => {
  const h = await page(t, null);
  const paste = new h.p.win.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { getData: () => "169.254.1.30:5000" } });
  h.doc.body.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, true, "the page handles the paste shortcut");
  const f = form(h);
  assert.equal(f.field("url").value, "http://169.254.1.30:5000");
  assert.deepEqual(f.shown(), { lan: "http://169.254.1.30:5000", wan: "" });
  f.type("url", "paste.example.org");
  f.type("wan", "https://advanced.example.com");
  await saveAndRead(t, h, f, { lan: "", wan: "https://advanced.example.com" }, null);
});

test("item addresses: unsafe values remain invalid and cancellation keeps the original item", opt, async t => {
  const h = await page(t), f = openEdit(h);
  for (const name of ["url", "lan", "wan"]) {
    const previous = f.field(name).value;
    f.type(name, "javascript:alert(1)");
    assert.equal(f.sheet.querySelector('[data-a="save"]').disabled, true);
    assert.equal(f.field(name).getAttribute("aria-invalid"), "true");
    f.sheet.querySelector("form").dispatchEvent(new h.p.win.Event("submit", { bubbles: true, cancelable: true }));
    assert.ok(f.sheet.classList.contains("is-on"), "an invalid form remains open");
    assert.equal(h.p.puts().length, 0, "an invalid form does not send configuration writes");
    assert.deepEqual(addresses(itemIn(h.p.A.state)), { lan: BASE.lan, wan: BASE.wan }, "invalid form never changes the item");
    f.type(name, previous);
  }
  f.type("wan", "https://cancelled.example.com");
  f.sheet.querySelector('[data-a="cancel"]').click();
  assert.equal(f.sheet.querySelector(".x-confirm").hidden, false, "cancel asks before discarding the edit");
  f.sheet.querySelector('[data-a="discard"]').click();
  assert.deepEqual(addresses(itemIn(h.p.A.state)), { lan: BASE.lan, wan: BASE.wan });
  assert.equal(h.p.puts().length, 0, "invalid and discarded edits do not send configuration writes");
});
