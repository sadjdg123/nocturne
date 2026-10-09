# 夜曲 Nocturne · 开发交接（Codex / 接手者阅读）

一句话：群晖 NAS 自托管起始页。后端 `server.js` 单文件、零依赖（Node 22 内置模块），前端是 `public/` 里的原生 JS / HTML / CSS，没有构建步骤。
当前维护者为 Codex。可靠性修复已独立验收；发布前工程验证在隔离分支 `verify/phase2-engineering`，测试源码冻结于 `018a696a8b1f6893b714f0d462af22ba0cf0fbc3`。`v2` 暂停推送，`main` 保持 V1.1；已发布候选仍为 **`2.0.0-rc.4`**，开发代码尚无发布镜像。

**三条红线**：不改 `main`（合并需要用户明确批准）；永远不碰生产数据 / NAS（Hark 与开发环境都没有 NAS 访问权，部署由用户自己在群晖上做）；不覆盖已发布的镜像标签。

## 0. 交接摘要（RC.4，2026-10-09）

### 0.1 版本 / 镜像 / digest

| 版本 | 远端提交 | 镜像（`标签@digest`） | CI |
|------|---------|-----------------------|----|
| **RC.4 `2.0.0-rc.4`（推荐候选）** | `v2@f51662961ba7a86782cb863104917d75fb587553` | `ghcr.io/sadjdg123/nocturne:sha-f516629@sha256:2c4bf740a106ce78dda34815da9558234e27d0301e397e9dd5c4711e0886b57f` | [37849652604](https://github.com/sadjdg123/nocturne/actions/runs/37849652604)（test 210 / 210 → build） |
| RC.3 `2.0.0-rc.3` | `v2@e4de70bc25df4bce6b586bdff523a269bae105eb` | `ghcr.io/sadjdg123/nocturne:sha-e4de70b@sha256:e37da36ff107dac5df6f6af17c624f06d3ec5a2478b40be6703f80fe75e8d47b` | 37843878107（204 / 204） |
| RC.2 `2.0.0-rc.2` | `v2@3d5beaf4c5327d02312ab9096e9ba4dc9e095db2` | `ghcr.io/sadjdg123/nocturne:sha-3d5beaf@sha256:08ff9c086757ab68a8d2fbff2ba97bbd8a87f9fe8a6b6aaf162c7a1320e9444e` | 37838079107（180 / 180） |
| RC.1 `2.0.0-rc.1`（历史基线） | `v2@2ee09835ea780cc2885f389a62b9cde188b13f2e` | `ghcr.io/sadjdg123/nocturne:sha-2ee0983@sha256:85ee7ab40781b3d6284e52a4152f852a8b2e6f27a96e91375f296f13d2d277fa` | — |
| V1.1 `1.1.x` | `main@3e6da3cf80c59fda12fa0a719afb8745829679b4` | `ghcr.io/sadjdg123/nocturne:sha-3e6da3c@sha256:58a4c8349242ca80ca4a46681410eafcbbb41e0411c3567e3cbef9abff19e861` | — |

RC.4 构建后用 GHCR 匿名查询复核过：旧标签仍指向上表的 digest。RC.4 相对 RC.3：`nocturne.js?v=8 → ?v=9`（缓存刷新），按已发布版本检查的缓存刷新测试，健康检查文档改用 `NAS_IP`。`server.js` 和数据格式都没变。详见 `docs/v2.0-rc4-report.md`。

### 0.2 先读这些文件

1. `docs/v2.0-rc4-report.md`：RC.4 改了什么、测试、镜像、风险
2. 本文第 1–2 节（架构、data 目录、兼容约束）和第 8 节（约定）
3. `docs/v2.0-upgrade-rc.md`：RC 之间的升级 / 回滚，以及健康检查用的 `NAS_IP`
4. `docs/v2.0-upgrade-rollback.md`：V1.1 ↔ V2
5. `docs/v2.0-rc3-report.md`、`docs/v2.0-rc2-report.md`：回滚写保护（旁路）的来龙去脉
6. `test/cache-bust.test.js`、`test/asset-refs.js`、`tools/gen-released-assets.js`、`test/fixtures/released-assets.json`：缓存刷新规则
7. `docs/v2.0-manual-acceptance.md`：还要人工验收的项目

### 0.3 当前交接与发布边界

1. 用户已确认 RC.4 在 NAS 部署成功、iPhone Safari 正常及重启数据保留；本轮没有访问 NAS。这是用户提供的 RC.4 验收信息，不是未发布修复版的真机验收。
2. 第一阶段及认证事务边界/退休清理补修已通过用户独立验收。先读 `auth-transactions.md`、`restore-recovery.md`、`stopped-backup.md` 和 `phase2-engineering-report.md`。
3. RC.4 已加入 `gen-released-assets.js` 与缓存清单。后续每次发布继续登记固定提交；修改被引用资源必须更新缓存 URL，运行生成器 `--check` 和缓存回归。
4. 测试工作流只允许隔离分支、`contents: read` / `packages: none`，现有生产 `docker.yml` 未改。当前 Git 凭据缺少 workflow 权限，推送被拒，远程 CI 尚未执行；不得据此声称 GitHub 双架构验收通过。
5. 后续发布机制启用、版本号、合并、镜像发布和 NAS 升级均须另行批准。禁止直接推送 `v2` / `main`、创建发布标签或覆盖镜像。

---

## 1. 架构

### 1.1 `server.js` 与 `auth-store.js`（按职责分节）

| 分节 | 内容 |
|------|------|
| 常量 / 环境变量 | `PORT`、`DATA_DIR`、探测、缓存、快照环、cookie 前缀等（完整列表见 README「环境变量」） |
| storage | `readJSON`；`atomicWrite`（`<目标>.<pid>.<8hex>.tmp` + `wx` 打开 + fsync + rename；只在 `created` 后清理自己的临时文件）；`writeJSON`（按文件串行队列）；`sweepStaleTmp`（启动时只删确认是自己遗留的过期临时文件）；`withUserLock` / `withAccountsLock` |
| users / sessions | `users.json`（scrypt 哈希，N=16384）、`sessions.json`（键 = sha256(令牌)，账户/密码/会话/设备变更由 `auth-store.js` 同步持久提交，成功后发布内存和 Cookie；不再依靠 2 秒防抖）；已知设备；`currentUser`；cookie 名 `cookieNames(NOCTURNE_COOKIE_PREFIX)` → `<前缀>sid` / `<前缀>dev`（`HttpOnly`、`SameSite=Lax`、`Path=/`，仅 HTTPS / 可信代理 HTTPS 时 `Secure`） |
| rate limiting / 客户端 | `parseCidrList`、`clientInfo`（`TRUSTED_PROXY_CIDRS` 内的直连对端才读转发头）、登录失败计数 |
| configs | 快照环 `backup/<用户>/`（`addBackup` / `listBackups` / `snapshotDue`：30 分钟或 20 个版本）；`readConfig`（mtime 缓存）；`canonical` + `dataHash`（键排序 JSON 的 sha256）；`writeConfig`（`hist` 最近 20 个版本指纹，V2 写的条目 `g:2`；`ops` 最近 50 个 opId；顶层 `writer:{app,v,gen:2}`） |
| 回滚写保护 | `writeGuard` / `guardWriteFailed` / `guardFormatOk` / `guardMatches` / `lastV2FromBackups` / `guardRecover` / `guardHeal` / `guardNotice`；`preV2Snapshot`（首次 V2 启动、检测到 V1.1 数据时写 `pre-v2-snapshot-<时间>/` + `MANIFEST.json`） |
| 校验 | `aliasesError`、`spacesError`、`reconcileSpaces`（按客户端 `caps` 决定是否接受 / 保留 `spaces`）、`newUnsafeUrls`（URL 白名单，旧值豁免规则见 README） |
| wallpapers / icons | 壁纸 `wallpapers/<用户>.<ext>`（≤15MB，嗅探格式）；上传图标 `icons/<用户>/<id>.<ext>`（≤512KB、≤500 个 / 50MB，引用消失 24h 后清理）；旧 data URL 启动 / 同步时迁移成文件（`migrateAll`） |
| status | 服务状态探测 `runProbes`（`STATUS_INTERVAL`，`vetTarget` 防 SSRF：私网 / 元数据地址规则、`PROBE_PRIVATE_ONLY`、`PROBE_ALLOW`、每账户 / 总量上限）；docker.sock（可选，只读）容器状态 |
| static | `serveStatic` / `serveIndex`（注入 `window.NOCTURNE`：用户、版本、`recovered` 等；gzip；缓存刷新用资源指纹，见 `test/cache-bust.test.js`） |
| icon proxy | Iconify 上游代理 + `data/cache/` 磁盘缓存（大小 / 数量 / TTL 上限，6 小时清扫） |
| API | `api()` 里按路径分支（见下表） |
| server / main | 安全响应头；`main()`：cookie 配置校验（不合法退出码 2）→ `ensureDirs` → 认证事务恢复（失败停止启动）→ `loadState` → `preV2Snapshot` → `sweepStaleTmp` → `migrateAll`（每个账户：迁移 + `guardHeal` + `guardRecover`）→ listen → 探测 / 缓存定时器。`require()` 时不启动，只导出单元测试用的函数 |

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
├── .auth-transaction/         活动事务（严格核验，启动撤销/重做）
├── .auth-done.<UUID>.tmp/       已核验退休材料（可部分清理）
├── .auth-cleanup.<UUID>.json   退休清理凭据（必须随完整备份保存）
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
- 版本号：`package.json` `version` → `/api/health`、启动日志、`writer.v`。V1.1 = `1.1.x`（`main@3e6da3c`，镜像 `sha-3e6da3c`），RC.1 = `2.0.0-rc.1`（远端 `v2@2ee0983`），RC.2 = `2.0.0-rc.2`（`v2@3d5beaf`），RC.3 = `2.0.0-rc.3`（`v2@e4de70b`），RC.4 = `2.0.0-rc.4`（`v2@f516629`）。
- 兼容测试按 **blob SHA** 从 git 历史取旧版本代码运行（`test/v11.js`、`test/rc1.js`），需要完整历史（CI `fetch-depth: 0`）。

## 3. 开发环境

- Node 22（`engines >=20`），**没有 npm 依赖**；`npm install` 不需要。本地运行（开发机，不是 NAS）：`DATA_DIR=./data node server.js` → `http://localhost:8080`。
- jsdom：不是依赖。CI 临时 `npm install --no-save jsdom@24`；本地用 `JSDOM_PATH=<…/node_modules/jsdom>`（沙盒里是 `/workspace/work/jsdom-env/node_modules/jsdom`）。找不到时本地跳过、CI 里失败。
- Chromium / Playwright（只给 `tools/e2e/*.py`、`tools/stage*_*.py` 截图 / 端到端用）：沙盒里由 `/workspace/work/.tools/setup.sh` 解出 Debian arm64 的 chromium + CJK 字体 + `pip --target` 的 playwright；需要 `PYTHONPATH=/workspace/work/.tools/py`。
- 故障注入：`test/fsfail.js`（`NODE_OPTIONS=--require`，控制文件 `FSFAIL_CTL` 每行 `<enospc|partial|open|rename> <路径正则>`，运行中可开关）。
- 完整验收要求零失败、零跳过。`CI=true` 且提供 jsdom；不得用缺工具、root 或环境差异跳过用例。隔离 runner 提供 Python、dash、BusyBox 与回环别名。

## 4. 测试

```bash
npm run check                         # node --check 所有前端 / 后端脚本
npm test                              # node --test --test-concurrency=1 test/*.test.js（CI 用法；约 4 分钟）
JSDOM_PATH=… node --test --test-concurrency=4 test/*.test.js   # 本地并行，约 100 秒（用例互相独立：临时 DATA_DIR + 空闲端口）
sh test/v2test-kit/run.sh [dash] [busybox]   # tools/v2test 套件沙盒自测（不在 npm test 里）：需要回环别名 sudo ip addr add 192.168.77.10/32 dev lo
python3 tools/e2e/rc_regression.py [输出目录]   # Chromium 端到端回归；另有 rollback_drill.py / restore_drill.py / rc_perf.py / https_proxy.py
```

- 已发布 RC.4 历史结果为 210/210。当前修复版结果、平台和日志见第二阶段报告。Linux Alpine 工程 runner 的 dash 与 BusyBox 套件自测各 51/51；旧 Hark 静态 BusyBox 的 39/50 和缺工具 SKIP 只保留为历史环境记录，不能作为当前平台结论。
- 缓存刷新（RC.4 起）：`test/cache-bust.test.js` 对每个已发布版本检查：URL（路径 + `?v=`）相同，内容就必须相同。清单 `test/fixtures/released-assets.json` 由 `node tools/gen-released-assets.js` 生成，`--check` 只核对。
- v2test 套件的固定镜像 / 期望版本统一在 `tools/v2test/lib.sh`（`IMAGE_TAG` / `IMAGE_DIGEST` / `EXPECT_VERSION`），套件自测会核对 `EXPECT_VERSION` 与 `package.json` 一致——**发新 RC 后要更新 lib.sh**。

## 5. CI/CD

- `.github/workflows/docker.yml`：push 到 `main` / `v2`、tag `v*`、PR 到 main、手动。`paths-ignore: **.md, docs/**, tools/**, LICENSE, docker-compose.yml`（只改这些不触发；`test/**` 会触发）。同分支 `concurrency` 取消旧运行。
- 任务：`test`（checkout `fetch-depth: 0` → Node 22 → 临时装 jsdom → `npm run check && npm test`）→ `build`（QEMU + buildx，`linux/amd64,linux/arm64`，推 GHCR）。
- 标签：`:latest` 与分支名只在默认分支（main）；`v2` 只产出 `sha-<7 位提交>`；semver tag 产出 `X.Y.Z` / `X.Y`。**镜像标签对应触发构建的代码提交**，之后的仅文档提交不会有镜像。
- digest：看 build 任务日志里 `docker/build-push-action` 的 `containerimage.digest`（多架构 manifest list）。也可匿名核对（包是公开的）：
  `curl -s "https://ghcr.io/token?scope=repository:sadjdg123/nocturne:pull"` 取 token，再 `curl -sI -H "Authorization: Bearer <token>" -H "Accept: application/vnd.oci.image.index.v1+json" https://ghcr.io/v2/sadjdg123/nocturne/manifests/<tag>` 看 `docker-content-digest`。
- 当前推送方式为 Git 整提交，仅隔离开发分支；禁用向 main/v2 及发布标签推送。原 Hark 逐文件 Contents API 流程已退出日常开发。
- 新 `engineering-verify.yml`：只允许 `verify/phase2-engineering` push，原生 amd64/arm64 runner、完整历史、固定 action SHA、checkout 不保留凭据、独立无认证 Docker 配置。构建使用 `--load`，测试注册表仅内部网络，生产 GHCR 无写权限。
- 远程工作流上传目前被凭据权限阻断；本地可运行 `DOCKER_CONFIG=<无凭据配置目录> sh tools/engineering/verify-local.sh arm64 <日志目录>`。所有 Docker 操作须指向隔离 daemon；不挂载宿主数据或 docker.sock 到容器。
- 防覆盖辅助模块通过只读 GHCR 与真实隔离 registry 测试，尚未接入发布工作流。共享发布锁、收敛所有写入者权限及正式工作流变更仍是发布前批准事项，不能把进程内锁当作跨 CI 的原子保护。

## 6. 部署流程（用户在群晖上自己做）

1. 先在 `tools/v2test` 测试站试（另一个端口 8089 + 生产数据的热备份副本，不碰生产 data；见 `tools/v2test/README.md`）。
2. 用户批准升级后，按 `stopped-backup.md` 先停唯一写入实例，再完整备份、校验和隔离恢复演练；热备份不能作为跨文件事务一致的灾备基准。
3. compose `image:` 写 `标签@digest`，重建；`curl -s "http://$NAS_IP:8088/api/health"` 检查版本（生产端口绑定在 `192.168.50.141:8088`，`NAS_IP` 默认它、以 `sudo docker port nocturne` 为准；**不要用 `127.0.0.1:8088` / `localhost:8088`**，连不上），再登录看空间。
4. 回滚前按 `engineering-rollback.md` 检查活动认证事务与离线恢复记录；必须由修复版完成恢复并验证后，才允许旧 RC 接管正常数据，或使用完整升级前备份。
- RC 之间：`docs/v2.0-upgrade-rc.md`；V1.1 ↔ V2：`docs/v2.0-upgrade-rollback.md`；人工验收：`docs/v2.0-manual-acceptance.md`。
- 用户提供的最近生产状态为 RC.4 已部署成功；本轮不重新检查或操作生产。实际端口和镜像以用户现场记录为准。
- 候选版镜像：**RC.4** `ghcr.io/sadjdg123/nocturne:sha-f516629@sha256:2c4bf740a106ce78dda34815da9558234e27d0301e397e9dd5c4711e0886b57f`（CI 37849652604）。所有版本见第 0.1 节。

## 7. 已知风险 / 待办

- 用户已提供 RC.4 iPhone Safari/NAS 验收。修复版未发布；其 DSM 宿主脚本、真实磁盘/断电与设备性能仍待另行批准后的用户验收。
- Alpine BusyBox 的离线完整备份/恢复及 dash/BusyBox 沙盒套件已验证；这不能代替 DSM 特定版本 `/bin/sh`、tar/权限模型的实机结论。同步认证事务与大资产删除仍可能阻塞事件循环，性能测量见工程报告。
- 自动找回只覆盖「最近 20 个版本」内的情况；`RC.1 → V1.1 → 直接升 RC.3 / RC.4` 不会自动找回（RC.1 旧格式旁路不用），需手动「恢复较早的版本」。
- 缓存刷新清单已包含 RC.4。没有 `?v=` 的资源（字体、图标、manifest、`fonts.css`）靠「内容不变」保证，改它们时要加 `?v=` 或改文件名。RC.1 期间的写入在 `hist` 里没有 `g:2`，无法与 V1.1 写入区分。
- 管理员旁路提示依赖内存诊断（`guardIssues`）：容器重启后诊断清空（启动自愈会重写旁路；若仍写不进去会再次记录）。
- 未启用 CSP（内联脚本多）；`tools/*.sh` 远端无可执行位。
- `main` 建议开启分支保护（需要 GitHub 套餐支持）。

## 8. 约定

- 提交信息：`<类型>(<范围>): <中文说明>`，类型 `fix` / `test` / `docs` / `tools` / `release`，范围如 `rc3`；修复与回归测试同一提交或紧邻提交，回归测试必须能在旧代码上失败。
- 文档、报告、界面文字一律简体中文；文档 / 日志 / 报告里不写任何秘密（密码、令牌、会话、哈希）。
- 不加新功能、不改界面设计，除非用户明确要求；最小改动，沿用已有 toast / 诊断等 UI。
- 只在独立开发分支；不直接推送/合并 `v2` 或 `main`，不创建发布标签，不发布镜像；正式发布需要用户批准。
- 永远不碰 NAS / 生产数据；需要真实环境验证时给用户脚本和步骤。
- 测试分支推送后：核对远端完整 SHA 和只读 CI 权限、两个 Linux job、全部日志与零跳过；构建产物仅本地。正式发布流程另行批准，不沿用原自动 push 作为验收步骤。
