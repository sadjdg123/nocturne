# 夜曲 Nocturne · 开发交接

V2.0.0 基于已验收 RC.5 发布；当前分支 v2，main 保持 V1.1。Node 22 内置模块后端（server.js + auth-store.js），原生 public/ 前端，没有运行依赖或构建步骤。

**边界**：不改 main、不覆盖已有镜像标签、不操作 NAS/生产数据。jingbo.men 后续作为本人私人首页；本次不改 Cloudflare、Sun-Panel 或线上路由。新功能先讨论，重大高风险修改单独确认；普通修复连续完成。

## 0. 维护入口

### 0.1 版本 / 镜像 / digest

正式版发布结果登记于 [V2.0.0 发布记录](v2.0.0-report.md)，成功后在此补齐固定镜像。历史镜像：

| 版本 | 远端提交 | 镜像（`标签@digest`） | CI |
|------|---------|-----------------------|----|
| **[RC.5 `2.0.0-rc.5`（历史候选）](v2.0-rc5-report.md)** | `v2@c5f36addc2d85b8ed24edb605015b7ff0be9070b` | `ghcr.io/sadjdg123/nocturne:sha-c5f36ad@sha256:85303abb887ed0ec8dee5865cc5171bda7b4b24036bfde38312022c852d7e993` | [37917714749](https://github.com/sadjdg123/nocturne/actions/runs/37917714749)（test 510 / 510 → build，双架构） |
| RC.4 `2.0.0-rc.4`（历史基线） | `v2@f51662961ba7a86782cb863104917d75fb587553` | `ghcr.io/sadjdg123/nocturne:sha-f516629@sha256:2c4bf740a106ce78dda34815da9558234e27d0301e397e9dd5c4711e0886b57f` | [37849652604](https://github.com/sadjdg123/nocturne/actions/runs/37849652604)（test 210 / 210 → build） |
| RC.3 `2.0.0-rc.3` | `v2@e4de70bc25df4bce6b586bdff523a269bae105eb` | `ghcr.io/sadjdg123/nocturne:sha-e4de70b@sha256:e37da36ff107dac5df6f6af17c624f06d3ec5a2478b40be6703f80fe75e8d47b` | 37843878107（204 / 204） |
| RC.2 `2.0.0-rc.2` | `v2@3d5beaf4c5327d02312ab9096e9ba4dc9e095db2` | `ghcr.io/sadjdg123/nocturne:sha-3d5beaf@sha256:08ff9c086757ab68a8d2fbff2ba97bbd8a87f9fe8a6b6aaf162c7a1320e9444e` | 37838079107（180 / 180） |
| RC.1 `2.0.0-rc.1`（历史基线） | `v2@2ee09835ea780cc2885f389a62b9cde188b13f2e` | `ghcr.io/sadjdg123/nocturne:sha-2ee0983@sha256:85ee7ab40781b3d6284e52a4152f852a8b2e6f27a96e91375f296f13d2d277fa` | — |
| V1.1 `1.1.x` | `main@3e6da3cf80c59fda12fa0a719afb8745829679b4` | `ghcr.io/sadjdg123/nocturne:sha-3e6da3c@sha256:58a4c8349242ca80ca4a46681410eafcbbb41e0411c3567e3cbef9abff19e861` | — |

### 0.2 按任务查阅

- 发布/日常使用：README、当前发布记录；历史阶段报告见 [归档](archive/README.md)。旧报告的审批流程与环境路径是历史证据，不作为日常指令。
- 认证/数据：本文数据约束、[认证事务](auth-transactions.md)、[工程回滚](engineering-rollback.md)。
- 备份恢复：[停写完整备份](stopped-backup.md)、[恢复材料保护](restore-recovery.md)。
- UI/平台：[人工验收](v2.0-manual-acceptance.md)、[按需工程验证](engineering-verification.md)。

### 0.3 最短开发流程

1. 读相关代码，最小修复；本地语法检查与对应回归（旧代码失败、新代码通过）。认证/存储修复保留必要故障注入。
2. 推 v2，现有 Actions 一次全量测试和双架构构建。相同源码无新问题不重复全量验收；Linux 异常重启、恢复、性能验证按改动影响执行。
3. 发布前只读确认新 SHA 标签不存在；发布后核对 CI 零失败/零跳过、唯一新 SHA 标签、完整 revision、双架构和 digest。不重跑已完成的发布；发布/标签规则变动或异常时才逐一核对旧标签。
4. 交付简要更新、CI 链接和固定镜像，用户自行升级。仅文档/工具维护无需镜像时先本地验证，提交 [skip ci]；不得跳过产品发布验证。不默认制作长报告或证据包。
5. 修改静态资源须更新缓存 URL；发布成功后更新 tools/gen-released-assets.js、清单与缓存回归，再以 [skip ci] 登记实际镜像到 tools/v2test/lib.sh 与版本表，不重复构建。

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
- 版本号：package.json version → /api/health、启动日志、writer.v；版本/提交/固定镜像统一见第0.1节。
- 兼容测试按 **blob SHA** 从 git 历史取旧版本代码运行（`test/v11.js`、`test/rc1.js`），需要完整历史（CI `fetch-depth: 0`）。

## 3. 开发与测试

运行：Node 22（engines >=20），无需 npm install。DATA_DIR=./data node server.js；测试专用 jsdom@24 通过 JSDOM_PATH 提供，CI 临时安装，运行镜像不包含。

```sh
npm run check
CI=true JSDOM_PATH=/path/to/node_modules/jsdom npm test
# 本地全量按需并行；先准备完整环境
CI=true JSDOM_PATH=/path/to/node_modules/jsdom node --test --test-concurrency=4 test/*.test.js
node tools/gen-released-assets.js --check
```

完整测试须零失败/零跳过，Python/dash/BusyBox 与回环环境须可用，不能用工具缺失或 root 跳过故障。2026-10-09 macOS Node22 并行4：512/512，187.661 秒；RC.5 本地串行507.032秒，CI461.835秒，仅供环境耗时参考。故障注入工具在 test/；必要日志保留仓库外 audit-evidence/。

POSIX 套件：sh test/v2test-kit/run.sh dash busybox，需隔离 Linux 回环别名。浏览器复现：tools/e2e/ 和 stage*/dock_verify.py；后者有历史 Linux arm64 固定路径，只供有对应环境的视觉回归，不作为日常门禁。字体/设计预览生成工具保留，preview/v2/standalone.html 为忽略的本地产物。

## 4. CI 与部署

现有 docker.yml：push v2/main、v* 标签、PR main、手动入口；test → build linux/amd64 + linux/arm64。v2 普通推送仅生成 sha-<7位提交>；latest/main 留给默认 main，不创建发布 Git tag 或版本别名。docs/tools 的 paths-ignore 不构建，但 test/** 会触发。GHCR 防覆盖辅助实现尚未接入生产；当前依靠发布前存在性检查和禁止重跑，不能宣称 registry 强制不可变。

engineering-verify.yml 仅隔离 verify/phase2-engineering 分支，contents:read/packages:none、无登录或推镜像；按需使用。原生双架构构建/启动/SIGKILL/恢复结果见 [第二阶段报告](phase2-engineering-report.md)，无运行逻辑变更时不用重跑整个矩阵。

NAS 升级由用户执行：停唯一写入实例 → 完整备份校验 → 固定标签@digest → 健康/登录/空间/图片核验。认证/存储或格式改动需副本站与隔离恢复演练。公网检查与私人入口约束见 README；未切换域名时不能声明线上登录已验收。旧版接管前须处理活动认证事务，不能丢弃退休清理凭据。

## 5. 已知风险与维护约定

- 用户已确认 RC.4 NAS/iPhone/重启；RC.5 后续升级反馈、DSM 宿主工具、真实断电/磁盘性能仍需现场证据。Linux 验证不能替代真机结论。
- 同步认证事务和大资产删除可能阻塞事件循环；性能和适用边界见工程报告。不要借瘦身改事务、Cookie 默认名、空间语义或数据格式。
- spaces 自动找回受最近20版本及指纹规则限制；RC.1 旧旁路无法当作新格式使用，必要时人工恢复快照。
- 字体/图标/manifest 无版本 URL 时保持内容不变或换 URL；兼容与缓存清单不能按年龄删除。
- 内联脚本多，页面 CSP 尚未启用；先讨论再处理，保持已验收 UI。Docker socket 风险见 README，默认不挂载。

提交：类型(范围): 简体中文说明；修复与对应回归靠近。日志/文档不含密码、令牌、会话或真实数据。tools/*.sh 用 sh 调用。保留有复现价值的历史材料，明确无用产物可清理，不为减少行数重构稳定模块。
