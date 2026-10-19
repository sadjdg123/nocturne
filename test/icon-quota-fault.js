"use strict";
// Test-only preload: arm after startup; only affect the selected account's inventory.
const fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path");
const readdir = fsp.readdir, stat = fsp.stat;
function inject(operation, file) {
  let rule;
  try { rule = JSON.parse(fs.readFileSync(process.env.ICON_QUOTA_FAULT_CTL, "utf8")); } catch { return; }
  if (rule.operation !== operation || path.resolve(String(file)) !== rule.path) return;
  if (rule.remove) { fs.unlinkSync(file); fs.writeFileSync(process.env.ICON_QUOTA_FAULT_CTL, "{}"); }
  throw Object.assign(new Error(rule.code + ": injected icon inventory " + operation), { code: rule.code, path: String(file) });
}
fsp.readdir = async function (file, ...args) { inject("readdir", file); return readdir.call(this, file, ...args); };
fsp.stat = async function (file, ...args) { inject("stat", file); return stat.call(this, file, ...args); };
