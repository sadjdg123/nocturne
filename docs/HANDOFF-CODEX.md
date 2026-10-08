# 夜曲 Nocturne · 开发交接（Codex / 接手者阅读）

一句话：群晖 NAS 自托管起始页。后端 `server.js` 单文件、零依赖（Node 22 内置模块），前端是 `public/` 里的原生 JS / HTML / CSS，没有构建步骤。
当前开发分支 `v2`（V2.0 Midnight Edition，候选版 `2.0.0-rc.3`）；`main` = V1.1（生产 `:latest`）。

**三条红线**：不改 `main`（合并需要用户明确批准）；永远不碰生产数据 / NAS（Hark 与开发环境都没有 NAS 访问权，部署由用户自己在群晖上做）；不覆盖已发布的镜像标签。

---

## 1. 架构

### 1.1 `server.js`（约 1870 行，按 `/* ---- 名字 */` 分节）

| 分节 | 内容 |
|------|------|
| 常量 / 环境变量 | `PORT`、`DATA_DIR`、探测、缓存、快照环、cookie 前缀等（完整列表见 README「环境变量」） |
| storage | `readJSON`；`atomicWrite`（`<目标>.<pid>.<8hex>.tmp` + `wx` 打开 + fsync + rename；只在 `created` 后清理自己的临时文件）；`writeJSON`（按文件串行队列）；`sweepStaleTmp`（启动时只删确认是自己遗留的过期临时文件）；`withUserLock` / `withAccountsLock` |
| users / sessions | `users.json`（scrypt 哈希，N=16384）、`sessions.json`（键 = sha256(令牌)，2 秒防抖写）；已知设备；`currentUser`；cookie 名 `cookieNames(NOCTURNE_COOKIE_PREFIX)` → `<前缀>sid` / `<前缀>dev`（`HttpOnly`、`SameSite=Lax`、`Path=/`，仅 HTTPS / 可信代理 HTTPS 时 `Secure`） |
| rate limiting / 客户端 | `parseCidrList`、`clientInfo`（`TRUSTED_PROXY_CIDRS` 内的直连对端才读转发头）、登录失败计数 |
| configs | 快照环 `backup/<用户>/`（`addBackup` / `listBackups` / `snapshotDue`：30 分钟或 20 个版本）；`readConfig`（mtime 缓存）；`canonical` + `dataHash`（键排序 JSON 的 sha256）；`writeConfig`（`hist` 最近 20 个版本指纹，V2 写的条目 `g:2`；`ops` 最近 50 个 opId；顶层 `writer:{app,v,gen:2}`） |
| 回滚写保护 | `writeGuard` / `guardWriteFailed` / `guardFormatOk` / `guardMatches` / `lastV2FromBackups` / `guardRecover` / `guardHeal` / `guardNotice`；`preV2Snapshot`（首次 V2 启动、检测到 V1.1 数据时写 `pre-v2-snapshot-<时间>/` + `MANIFEST.json`） |
| 校验 | `aliasesError`、`spacesError`、`reconcileSpaces`（按客户端 `caps` 决定是否接受 / 保留 `spaces`）、`newUnsafeUrls`（URL 白名单，旧值豁免规则见 README） |
| wallpapers / icons | 壁纸 `wallpapers/<用户>.<ext>`（≤15MB，嗅探格式）；上传图标 `icons/<用户>/<id>.<ext>`（≤512KB、≤500 个 / 50MB，引用消失 24h 后清理）；旧 data URL 启动 / 同步时迁移成文件（`migrateAll`） |
| status | 服务状态探测 `runProbes`（`STATUS_INTERVAL`，`vetTarget` 防 SSRF：私网 / 元数据地址规则、`PROBE_PRIVATE_ONLY`、`PROBE_ALLOW`、每账户 / 总量上限）；docker.sock（可选，只读）容器状态 |
| static | `serveStatic` / `serveIndex`（注入 `window.NOCTURNE`：用户、版本、`recovered` 等；gzip；缓存刷新用资源指纹，见 `test/cache-bust.test.js`） |
| icon proxy | Iconify 上游代理 + `data/cache/` 磁盘缓存（大小 / 数量 / TTL 上限，6 小时清扫） |
| API | `api()` 里按路径分支（见下表） |
| server / main | 安全响应头；`main()`：cookie 配置校验（不合法退出码 2）→ `ensureDirs` → `loadState` → `preV2Snapshot` → `sweepStaleTmp` → `migrateAll`（每个账户：迁移 + `guardHeal` + `guardRecover`）→ listen → 探测 / 缓存定时器。`require()` 时不启动，只导出单元测试用的函数 |

API（全部在 `/api` 下；除 health / me / setup / login 外需要登录）：

| 路径 | 说明 |
|------|------|
| `GET /health` | `{ok, app, version, auth, uptime}`；管理员额外 `client`（连接诊断）与 `guard:{ok, issues:[{user, kind, at, since?, error?, detail?}]}` |
| `GET /me`、`POST /setup`、`POST /login`、`POST /logout` | 账户状态 / 首个管理员 / 登录（限速、已知设备）/ 退出 |
| `GET/PUT /config` | 读写配置。PUT 必须带 `baseVersion`；`opId` 去重；冲突 409；`force` + `expectVersion`（用本机版覆盖）；`restore`；响应可带 `guardWarning`。`?backup=<id>` 取一份快照，`?prev=1` 最新快照 |
| `GET /config/backups`、`POST /config/stash` | 快照环列表 / 冲突时存本机版本 |
| `/wallpaper`、`/icons[/<id>]` | 壁纸、上传图标 |
| `GET /status`、`GET /docker` | 服务状态 / 容器状态 |
| `/icon/*` | 图标代理 |
| `POST /password`、`/users[/<name>]` | 改密码 / 用户管理（管理员） |

### 1.2 `public/`

| 文件 | 作用 |
|------|------|
| `index.html` | 页面 + 核心 `window.App`（状态、渲染、编辑、命令面板、`toast`、撤销、设置面板）；纯静态模式（直接打开文件）也能用 |
| `nocturne.js` | NAS 模式同步层：登录界面、拉 / 推配置（防抖 800ms、opId、409 冲突面板、离线 dirty）、设置 → 账户（用户管理、连接诊断、「恢复较早的版本」）、找回提示、管理员旁路写入失败提示（RC.3） |
| `spaces.js` | 空间模型（前后端共用）：`data.spaces=[{id,name,groupIds,itemIds?,excludeItemIds?,theme?,density?}]`，只存引用不复制项目；`check` / `prune` / `view` / `reorder` |
| `midnight.js` / `midnight.css` | V2 新外观（本机设置，可切回经典） |
| `status.js` | 状态的「可信」标注（只说测到的） |
| `netmode.js` | 三态网络（自动 / 优先内网 / 优先外网）地址选择 |
| `cmdrank.js` | 命令面板排序 |
| `urlcheck.js` | URL 白名单（前后端共用：只收 http/https） |
| `fonts/`、壁纸、图标 | 子集化 woff2（`tools/subset-fonts.py`）、默认壁纸、PWA 图标 |

### 1.3 回滚写保护（spaces guard）要点

- 旁路 `data/spaces-guard/<用户>.json`：`{fmt:2, version, h, updatedAt, writer, spaces, spacesVersion?, recovered?}`。V2 每次写配置后写旁路（先配置后旁路）。
- 写失败：删旧旁路（删不掉则靠校验拦）、`ERROR spaces guard write failed` 日志、保存响应 `guardWarning`、管理员 health `guard`、页面 toast（RC.3）。
- 找回（配置不是 V2 写的 + `data` 没有 `spaces` + 配置比旁路新）：旁路必须 `guardFormatOk`（`fmt===2`、`h` 为 64 位小写十六进制）且 `h` 等于 `hist` 中该版本指纹、之后没有 `g:2` 版本；否则只用快照环里「最后一个 `g:2` 版本」（版本号 + 指纹一致），RC.1 旧格式旁路比它新时也不找回。宁可不找回。
- 启动自愈：配置最后是 V2 写的 → 旁路缺失 / 损坏 / 旧格式 / 格式不对 / 版本或指纹不符时按当前配置重写（只写旁路）。

## 2. data 目录与兼容约束

```
data/
├── users.json  sessions.json
├── config/<用户>.json          {version, updatedAt, data, hist:[{v,h,g?}], ops?:[{id,v,h}], writer:{app,v,gen}}
├── backup/<用户>/<15 位时间戳>-<序号>-v<版本>[-auto|replaced|restore|local|legacy|guard].json
├── spaces-guard/<用户>.json
├── pre-v2-snapshot-<时间>/      MANIFEST.json + users.json + config/ + icons/ + wallpapers/（永不轮换）
├── wallpapers/<用户>.<ext>   icons/<用户>/<id>.<ext>   cache/
```

兼容约束（改数据格式前必读）：

- **只加不删**：新字段放在已有对象里，旧版本（V1.1 / RC.1 / RC.2）必须能读、并在它们保存时不出错。V1.1 的 `writeConfig` 只写 `{version, updatedAt, data, hist, ops}`——顶层新字段会在 V1.1 保存时丢失（`writer` 就是靠这一点判断「最后一次是不是 V2 写的」）；`data` 里的未知字段 V1.1 前端会原样带回。
- `hist` 条目：旧版本原样复制 `cur.hist.slice()`，所以条目上的新标记（`g:2`）能活过回滚。不要改 `canonical` / `dataHash` 算法（指纹跨版本比较）。
- 不要改 cookie 默认名（`nocturne_sid` / `nocturne_dev`），否则升级 / 回滚会让所有设备掉登录。
- 快照环文件名格式、`kind` 后缀集合、`BACKUP_ID` 正则不要改（旧版本列 / 读快照）。
- 版本号：`package.json` `version` → `/api/health`、启动日志、`writer.v`。V1.1 = `1.1.x`（`main@3e6da3c`，镜像 `sha-3e6da3c`），RC.1 = `2.0.0-rc.1`（远端 `v2@2ee0983`），RC.2 = `2.0.0-rc.2`（`v2@3d5beaf`），RC.3 = `2.0.0-rc.3`。
- 兼容测试按 **blob SHA** 从 git 历史取旧版本代码运行（`test/v11.js`、`test/rc1.js`），需要完整历史（CI `fetch-depth: 0`）。

## 3. 开发环境

- Node 22（`engines >=20`），**没有 npm 依赖**；`npm install` 不需要。本地运行：`DATA_DIR=./data node server.js` → `http://localhost:8080`。
- jsdom：不是依赖。CI 临时 `npm install --no-save jsdom@24`；本地用 `JSDOM_PATH=<…/node_modules/jsdom>`（沙盒里是 `/workspace/work/jsdom-env/node_modules/jsdom`）。找不到时本地跳过、CI 里失败。
- Chromium / Playwright（只给 `tools/e2e/*.py`、`tools/stage*_*.py` 截图 / 端到端用）：沙盒里由 `/workspace/work/.tools/setup.sh` 解出 Debian arm64 的 chromium + CJK 字体 + `pip --target` 的 playwright；需要 `PYTHONPATH=/workspace/work/.tools/py`。
- 故障注入：`test/fsfail.js`（`NODE_OPTIONS=--require`，控制文件 `FSFAIL_CTL` 每行 `<enospc|partial|open|rename> <路径正则>`，运行中可开关）。
- 以 root 运行时 chmod 类测试会自动跳过（模拟不了「目录不可写」）。

## 4. 测试

```bash
npm run check                         # node --check 所有前端 / 后端脚本
npm test                              # node --test --test-concurrency=1 test/*.test.js（CI 用法；约 4 分钟）
JSDOM_PATH=… node --test --test-concurrency=4 test/*.test.js   # 本地并行，约 100 秒（用例互相独立：临时 DATA_DIR + 空闲端口）
sh test/v2test-kit/run.sh [dash] [busybox]   # tools/v2test 套件沙盒自测（不在 npm test 里）：需要回环别名 sudo ip addr add 192.168.77.10/32 dev lo
python3 tools/e2e/rc_regression.py [输出目录]   # Chromium 端到端回归；另有 rollback_drill.py / restore_drill.py / rc_perf.py / https_proxy.py
```

- RC.3 时：`npm test` 204 项全过；套件自测 dash 50 项。
- v2test 套件的固定镜像 / 期望版本统一在 `tools/v2test/lib.sh`（`IMAGE_TAG` / `IMAGE_DIGEST` / `EXPECT_VERSION`），套件自测会核对 `EXPECT_VERSION` 与 `package.json` 一致——**发新 RC 后要更新 lib.sh**。

## 5. CI/CD

- `.github/workflows/docker.yml`：push 到 `main` / `v2`、tag `v*`、PR 到 main、手动。`paths-ignore: **.md, docs/**, tools/**, LICENSE, docker-compose.yml`（只改这些不触发；`test/**` 会触发）。同分支 `concurrency` 取消旧运行。
- 任务：`test`（checkout `fetch-depth: 0` → Node 22 → 临时装 jsdom → `npm run check && npm test`）→ `build`（QEMU + buildx，`linux/amd64,linux/arm64`，推 GHCR）。
- 标签：`:latest` 与分支名只在默认分支（main）；`v2` 只产出 `sha-<7 位提交>`；semver tag 产出 `X.Y.Z` / `X.Y`。**镜像标签对应触发构建的代码提交**，之后的仅文档提交不会有镜像。
- digest：看 build 任务日志里 `docker/build-push-action` 的 `containerimage.digest`（多架构 manifest list）。也可匿名核对（包是公开的）：
  `curl -s "https://ghcr.io/token?scope=repository:sadjdg123/nocturne:pull"` 取 token，再 `curl -sI -H "Authorization: Bearer <token>" -H "Accept: application/vnd.oci.image.index.v1+json" https://ghcr.io/v2/sadjdg123/nocturne/manifests/<tag>` 看 `docker-content-digest`。
- 推送方式（Hark 沙盒）：没有 git push 权限，用 GitHub Contents API 逐文件上传（`/workspace/projects/96b6658f-a5d1-4f1c-980b-192e9a6c9735/work/gh_v2.py upload …`），**每个文件一个远端提交**，远端提交 SHA 与本地不同（按 blob 比对）。只有最后一个文件的提交不带 `[skip ci]` → 一次 CI；先传文档 / 测试、最后传 `server.js` 之类的代码文件，确保触发 CI 的提交已包含全部改动。Contents API 上传的文件模式都是 `100644`（`tools/*.sh` 的可执行位丢失，脚本都用 `sh 脚本` 调用）。
- 核对：`gh_v2.py verify <ref> --require <路径,…>` 用 `git/trees/<提交>?recursive=1` 逐文件比对 blob SHA、打印比对的是哪个远端提交、工作区不干净时失败。**核对 CI / 镜像对应的那个提交**，不要只核对分支最新提交。

## 6. 部署流程（用户在群晖上自己做）

1. 先在 `tools/v2test` 测试站试（另一个端口 8089 + 生产数据的热备份副本，不碰生产 data；见 `tools/v2test/README.md`）。
2. 生产升级前 `tools/backup.sh`（热备份或 `--stop`）+ `verify-backup.sh`。
3. compose `image:` 写 `标签@digest`，重建；检查 `/api/health` 版本、登录、空间。
4. 回滚：image 改回上一版的 `标签@digest`；一般不用换 data。
- RC 之间：`docs/v2.0-upgrade-rc.md`；V1.1 ↔ V2：`docs/v2.0-upgrade-rollback.md`；人工验收：`docs/v2.0-manual-acceptance.md`。
- 生产当前：RC.1 `sha-2ee0983@sha256:85ee7ab4…77fa`（Synology Container Manager，真实数据）。

## 7. 已知风险 / 待办

- 真机 Safari（iPhone / Mac）、真实 HTTPS 反代、群晖实机的人工验收仍待用户完成（`docs/v2.0-manual-acceptance.md`）。
- 自动找回只覆盖「最近 20 个版本」内的情况；`RC.1 → V1.1 → 直接升 RC.3` 不会自动找回（RC.1 旧格式旁路不用），需手动「恢复较早的版本」。RC.1 期间的写入在 `hist` 里没有 `g:2`，无法与 V1.1 写入区分。
- 管理员旁路提示依赖内存诊断（`guardIssues`）：容器重启后诊断清空（启动自愈会重写旁路；若仍写不进去会再次记录）。
- 未启用 CSP（内联脚本多）；`tools/*.sh` 远端无可执行位。
- `main` 建议开启分支保护（需要 GitHub 套餐支持）。

## 8. 约定

- 提交信息：`<类型>(<范围>): <中文说明>`，类型 `fix` / `test` / `docs` / `tools` / `release`，范围如 `rc3`；修复与回归测试同一提交或紧邻提交，回归测试必须能在旧代码上失败。
- 文档、报告、界面文字一律简体中文；文档 / 日志 / 报告里不写任何秘密（密码、令牌、会话、哈希）。
- 不加新功能、不改界面设计，除非用户明确要求；最小改动，沿用已有 toast / 诊断等 UI。
- 只在 `v2` 分支；不合并 / 不推 `main`（需用户批准）；不重打已发布镜像标签（新提交 → 新 `sha-*` 标签）。
- 永远不碰 NAS / 生产数据；需要真实环境验证时给用户脚本和步骤。
- 每次推送后：核对远端树（逐文件 blob）、等 CI test → build 成功、从日志取 digest，写进当版报告。
