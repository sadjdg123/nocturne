"use strict";
/* 回滚测试用：把 V1.1 基线（远程 main@3e6da3c，即 ghcr.io/sadjdg123/nocturne:sha-3e6da3c 的代码）的服务端和前端原样取出到临时目录。
 * 按 blob SHA 取（git cat-file），与提交 SHA 无关：本地 main（9ab11b7）与远程 3e6da3c 的这些文件逐个 blob 相同。
 * 需要完整的 git 历史（CI 的 test 步骤用 fetch-depth: 0）。取不到时：CI 里失败，本地跳过。 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");

const V11_COMMIT = "3e6da3cf80c59fda12fa0a719afb8745829679b4";
const V11_BLOBS = {
  "package.json": "0bf8f0833ad6a916c30ead64c9090f4184511243",
  "server.js": "4e6921ec084473c9a6441c9d6009061afba9801b",
  "public/index.html": "cbc42170a30b33c6a4f20c3afb0dc2ab0160ddbe",
  "public/nocturne.js": "7944742de2ee6a1c856b334c6231abd5bd22c691",
  "public/urlcheck.js": "3881cfd472158cbf41d63389188cb4c224470533",
  "public/netmode.js": "8796f9d9b7eca5fd7d47ca08f6bbf48ed2f453d7",
  "public/cmdrank.js": "c68134e9be337e3679c97fb9a9ccd26e0736a3d7",
  "public/Sortable.min.js": "95423a64911d06109c228d8cc8f9c69d23beebee",
};

let cached;
/** 返回 V1.1 代码目录（只读用），或 {skip: 原因} */
function v11Root() {
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-v11-"));
  try {
    for (const [f, sha] of Object.entries(V11_BLOBS)) {
      const buf = execFileSync("git", ["-C", ROOT, "cat-file", "blob", sha], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), buf);
    }
    for (const f of ["favicon.svg"]) fs.copyFileSync(path.join(ROOT, "public", f), path.join(dir, "public", f));
    cached = { root: dir };
    process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (process.env.CI) throw new Error("取不到 V1.1 基线文件（需要 fetch-depth: 0）：" + e.message);
    cached = { skip: "取不到 V1.1 基线 blob（" + e.message.split("\n")[0] + "）" };
  }
  return cached;
}
module.exports = { v11Root, V11_COMMIT, V11_BLOBS };
