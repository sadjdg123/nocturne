#!/usr/bin/env node
"use strict";
/* 生成 test/fixtures/released-assets.json：每个已发布版本（远程提交 + 镜像）当时浏览器会缓存的每个本地静态 URL，
 * 以及该文件当时内容的 sha256 / git blob。test/cache-bust.test.js 用它断言：现在的 URL 若与某个已发布版本相同，内容必须相同
 * （内容变了就必须换 ?v=，否则静态文件最多缓存 86400 秒，升级后浏览器可能还在用旧文件）。
 *
 * 用法：node tools/gen-released-assets.js            # 按下方 RELEASES 从 GitHub 远程提交读取（公开仓库，无需 token；有 GITHUB_TOKEN 则带上）
 *       node tools/gen-released-assets.js --check    # 只核对现有清单与远程一致，不写文件（不一致退出码 1）
 * 新发布一个版本（镜像构建成功后）：在 RELEASES 末尾加一行 { name, commit, image }，重跑本脚本并提交清单。
 * 文件内容优先用本地 git 对象（git cat-file blob <sha>），没有再走 GitHub API。 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { collectRefs, sha256, gitBlob } = require("../test/asset-refs");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "test", "fixtures", "released-assets.json");
const REPO = "sadjdg123/nocturne";
const RELEASES = [
  { name: "V1.1", commit: "3e6da3cf80c59fda12fa0a719afb8745829679b4", image: "ghcr.io/sadjdg123/nocturne:sha-3e6da3c" },
  { name: "RC.1", commit: "2ee09835ea780cc2885f389a62b9cde188b13f2e", image: "ghcr.io/sadjdg123/nocturne:sha-2ee0983" },
  { name: "RC.2", commit: "3d5beaf4c5327d02312ab9096e9ba4dc9e095db2", image: "ghcr.io/sadjdg123/nocturne:sha-3d5beaf" },
  { name: "RC.3", commit: "e4de70bc25df4bce6b586bdff523a269bae105eb", image: "ghcr.io/sadjdg123/nocturne:sha-e4de70b" },
  { name: "RC.4", commit: "f51662961ba7a86782cb863104917d75fb587553", image: "ghcr.io/sadjdg123/nocturne:sha-f516629" },
  { name: "RC.5", commit: "c5f36addc2d85b8ed24edb605015b7ff0be9070b", image: "ghcr.io/sadjdg123/nocturne:sha-c5f36ad" },
  { name: "V2.0.0", commit: "93d9bec8e4e581107d375d57f9870b3353ade879", image: "ghcr.io/sadjdg123/nocturne:sha-93d9bec" },
  { name: "V2.1.0", commit: "1bb4b2087697f1b38cb0b0b0332377ec55f1778c", image: "ghcr.io/sadjdg123/nocturne:sha-1bb4b20" },
];

async function api(p) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "nocturne-gen-released-assets" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
  const r = await fetch("https://api.github.com/repos/" + REPO + p, { headers });
  if (!r.ok) throw new Error("GitHub API " + p + " → " + r.status);
  return r.json();
}
const blobCache = new Map();
async function blobContent(sha) {
  if (blobCache.has(sha)) return blobCache.get(sha);
  let buf;
  try { buf = execFileSync("git", ["-C", ROOT, "cat-file", "blob", sha], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }); } catch (e) {
    const b = await api("/git/blobs/" + sha);
    buf = Buffer.from(b.content, b.encoding === "base64" ? "base64" : "utf8");
  }
  if (gitBlob(buf) !== sha) throw new Error("blob " + sha + " 内容校验失败");
  blobCache.set(sha, buf);
  return buf;
}

async function release(r, getTree = api, getBlob = blobContent) {
  const checkedBlob = async (sha) => {
    const buf = await getBlob(sha);
    if (gitBlob(buf) !== sha) throw new Error("blob " + sha + " 内容校验失败");
    return buf;
  };
  const t = await getTree("/git/trees/" + r.commit + "?recursive=1");
  if (t.truncated) throw new Error("tree truncated: " + r.commit);
  const tree = new Map(t.tree.filter((e) => e.type === "blob" && e.path.startsWith("public/")).map((e) => [e.path.slice(7), e.sha]));
  const files = new Map();
  for (const [p, sha] of tree) if (/\.(html|css|webmanifest)$/.test(p)) files.set(p, await checkedBlob(sha));
  const refs = collectRefs((p) => (files.has(p) ? files.get(p) : tree.has(p) ? Buffer.alloc(1) : null));
  const assets = {};
  for (const [url, ref] of [...refs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const buf = await checkedBlob(tree.get(ref.path));
    assets[url] = { path: ref.path, v: ref.v, blob: tree.get(ref.path), sha256: sha256(buf) };
  }
  return { name: r.name, commit: r.commit, image: r.image, indexBlob: tree.get("index.html"), assets };
}

async function generate(getTree = api, getBlob = blobContent) {
  const out = {
    about: "已发布版本当时浏览器会按固定 URL 缓存的本地静态文件（相对 public/）；由 tools/gen-released-assets.js 从 GitHub 远程提交生成，勿手改。test/cache-bust.test.js：现在相同的 URL 必须内容相同。",
    repo: REPO,
    releases: [],
  };
  for (const r of RELEASES) out.releases.push(await release(r, getTree, getBlob));
  return out;
}

// 写入失败保留旧清单；临时文件与目标同目录，rename 是唯一替换点。
function writeManifest(file, text, io = fs) {
  const tmp = file + "." + require("node:crypto").randomUUID() + ".tmp";
  let fd;
  try {
    fd = io.openSync(tmp, "wx", 0o644);
    io.writeFileSync(fd, text);
    io.fsyncSync(fd);
    io.closeSync(fd); fd = undefined;
    io.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) try { io.closeSync(fd); } catch (_) {}
    try { io.unlinkSync(tmp); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}

async function main() {
  const out = await generate();
  const text = JSON.stringify(out, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    const same = fs.existsSync(OUT) && fs.readFileSync(OUT, "utf8") === text;
    console.log(same ? "released-assets.json 与远程一致" : "released-assets.json 与远程不一致（重跑本脚本生成）");
    process.exit(same ? 0 : 1);
  }
  writeManifest(OUT, text);
  for (const r of out.releases) console.log(r.name, r.commit.slice(0, 7), Object.keys(r.assets).length, "URLs");
  console.log("写入", path.relative(ROOT, OUT));
}
module.exports = { RELEASES, generate, writeManifest };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
