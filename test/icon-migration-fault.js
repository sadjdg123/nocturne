"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const control = process.env.MEDIAFAIL_CTL;
const read = fs.readFileSync, open = fsp.open, rename = fsp.rename;
let iconWrites = 0, iconRenames = 0;

function rule() {
  try { return JSON.parse(read.call(fs, control, "utf8")); } catch { return {}; }
}
function failure(syscall, file) {
  return Object.assign(new Error("EIO: injected media migration failure, " + syscall + " '" + file + "'"), { code: "EIO", path: String(file), syscall });
}
const iconTmp = /[/\\]icons[/\\][^/\\]+[/\\][A-Za-z0-9_-]{16,64}\.(png|jpg|webp)\.\d+\.[0-9a-f]{8}\.tmp$/;
const configTmp = /[/\\]config[/\\][^/\\]+\.json\.\d+\.[0-9a-f]{8}\.tmp$/;
const configFile = /[/\\]config[/\\][^/\\]+\.json$/;

fsp.open = async function(file, ...args) {
  const handle = await open.call(this, file, ...args), r = rule();
  if (r.mode !== "icon_partial" || !iconTmp.test(String(file)) || ++iconWrites !== r.at) return handle;
  return new Proxy(handle, {
    get(target, key) {
      if (key === "writeFile") return async data => {
        const bytes = Buffer.from(data);
        await target.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
        throw failure("write", file);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
fsp.rename = async function(from, to) {
  const result = await rename.call(this, from, to), r = rule();
  if (r.mode === "after_icon_rename" && iconTmp.test(String(from)) && ++iconRenames === r.at) throw failure("rename-result", from);
  if (configTmp.test(String(from)) && ["after_config_rename", "after_config_rename_unreadable"].includes(r.mode)) {
    if (r.mode.endsWith("unreadable")) fs.writeFileSync(control, JSON.stringify({ mode: "config_unreadable" }));
    throw failure("rename-result", from);
  }
  return result;
};
fs.readFileSync = function(file, ...args) {
  if (rule().mode === "config_unreadable" && configFile.test(String(file))) throw failure("read", file);
  return read.call(this, file, ...args);
};
