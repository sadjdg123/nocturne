"use strict";
/* 测试用的文件系统故障注入（只在测试里通过 NODE_OPTIONS=--require 预加载到 server.js 子进程；不进镜像逻辑、server.js 不引用它）。
 * FSFAIL_CTL=<控制文件>：每次 open / rename 时现读，所以测试可以在服务器运行中途打开 / 关闭故障。每行一条规则：
 *   <模式> <正则>     正则匹配 open / rename 的路径（源路径）
 * 模式：
 *   enospc   打开成功，writeFile 只写进一半内容后抛 ENOSPC（磁盘满：临时文件里留下半截内容）
 *   partial  同上但抛 EIO（写到一半出错）
 *   open     open 直接抛 ENOSPC（连临时文件都建不出来）
 *   rename   rename 抛 ENOSPC（临时文件完整写好了，但换不上去）
 * 空文件 / 文件不存在 = 不注入。 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const CTL = process.env.FSFAIL_CTL;

function rules() {
  if (!CTL) return [];
  let txt; try { txt = fs.readFileSync(CTL, "utf8"); } catch (e) { return []; }
  return txt.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(" "); return { mode: l.slice(0, i), re: new RegExp(l.slice(i + 1)) }; });
}
const hit = (p, modes) => rules().find((r) => modes.includes(r.mode) && r.re.test(String(p)));
function err(code, syscall, p) {
  const e = new Error(code + ": injected failure, " + syscall + " '" + p + "'");
  e.code = code; e.syscall = syscall; e.path = String(p); e.errno = code === "ENOSPC" ? -28 : -5;
  return e;
}

const origOpen = fsp.open, origRename = fsp.rename;
fsp.open = async function (p, flags, mode) {
  const r = hit(p, ["enospc", "partial", "open"]);
  if (r && r.mode === "open") throw err("ENOSPC", "open", p);
  const fh = await origOpen.call(this, p, flags, mode);
  if (!r) return fh;
  return new Proxy(fh, {
    get(t, k) {
      if (k === "writeFile") {
        return async (data) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
          await t.write(buf.subarray(0, Math.floor(buf.length / 2)));
          throw err(r.mode === "enospc" ? "ENOSPC" : "EIO", "write", p);
        };
      }
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
};
fsp.rename = async function (a, b) {
  if (hit(a, ["rename"])) throw err("ENOSPC", "rename", a);
  return origRename.call(this, a, b);
};
