"use strict";
/* 兼容测试用：把 RC.1（远程 v2@2ee0983，即 ghcr.io/sadjdg123/nocturne:sha-2ee0983 的代码，2.0.0-rc.1）的服务端和前端原样取出到临时目录。
 * 和 test/v11.js 一样按 blob SHA 取（git cat-file），与提交 SHA 无关：远程 2ee0983 与本地对应提交的这些文件逐个 blob 相同（已用 GitHub API 核对）。
 * 需要完整的 git 历史（CI 的 test 步骤用 fetch-depth: 0）。取不到时：CI 里失败，本地跳过。 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");

const RC1_COMMIT = "2ee09835ea780cc2885f389a62b9cde188b13f2e";
const RC1_BLOBS = {
  "package.json": "1ad455918020a7e8643b9bdcc8576f11378d8922",
  "server.js": "0ce41c89b7fc3c2cc42c552034822501b1f1032a",
  "public/Sortable.min.js": "95423a64911d06109c228d8cc8f9c69d23beebee",
  "public/apple-touch-icon.png": "ee72dfe83aee032005e3edc08f62449fe4a71bd0",
  "public/bg-desktop.jpg": "8c1bfa08ed6fd37221ac4fc8d1c54b55ffeb82b4",
  "public/bg-mobile.jpg": "a4fe1a69268a5dd33c170fcd03c824e7c9980f69",
  "public/cmdrank.js": "84e7b753fbbeb79f0834915877746640ab560064",
  "public/favicon.svg": "197937edc8ae56179d569c41f75c064e55137a53",
  "public/fonts/fonts.css": "74c1b13c2228d56b0e47282f10961ea0ae45d64f",
  "public/icon-192.png": "001e941588875891a81de64a5894af1c7691886a",
  "public/icon-512.png": "71295a919a7b86a0a9e8906fa8dc46963a6dd55a",
  "public/index.html": "904291b5aae8e625857d5ee9cd5d161a14331ac5",
  "public/midnight.css": "f910bbefbcf72b430260b4f72b5fb32380d8c4c7",
  "public/midnight.js": "3436375292cdf4ba96520dd1ee82747e3ca6a523",
  "public/netmode.js": "8796f9d9b7eca5fd7d47ca08f6bbf48ed2f453d7",
  "public/nocturne.js": "ecafecbab096699ba5906e752e45b81508ec1cb0",
  "public/site.webmanifest": "554ca79a331ae7b4d301365de32304b41379f36b",
  "public/spaces.js": "061943e47dbd996ac14f351cf1fd3c5c2324c4e0",
  "public/status.js": "161c625181f8232a242da68e95c8b382b2ca8ec1",
  "public/urlcheck.js": "3881cfd472158cbf41d63389188cb4c224470533",
};

let cached;
/** 返回 RC.1 代码目录（只读用），或 {skip: 原因} */
function rc1Root() {
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-rc1-"));
  try {
    for (const [f, sha] of Object.entries(RC1_BLOBS)) {
      const buf = execFileSync("git", ["-C", ROOT, "cat-file", "blob", sha], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), buf);
    }
    const v = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
    if (v !== "2.0.0-rc.1") throw new Error("取出的 package.json 版本是 " + v);
    cached = { root: dir };
    process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (process.env.CI) throw new Error("取不到 RC.1 文件（需要 fetch-depth: 0）：" + e.message);
    cached = { skip: "取不到 RC.1 blob（" + e.message.split("\n")[0] + "）" };
  }
  return cached;
}
module.exports = { rc1Root, RC1_COMMIT, RC1_BLOBS };
