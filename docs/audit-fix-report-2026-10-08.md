# 夜曲 Nocturne · 审计修复工单（2026-10-08）交付报告

> 仓库：`/workspace/work/nocturne-app`，基准 `22e0efc`（内容等同远端 `main` `5b77bf3`）。
> 分支：**`audit4-fixes`**，HEAD **`81335fe`**，共 13 个本地提交。**未推送**，未改动 `main`，未接触任何 NAS / 线上数据。
> 改动文件清单见 `FILES.txt`（`git diff --name-status 22e0efc HEAD`）。

## 一、实际改动与提交

| 提交 | 内容 |
| --- | --- |
| `d898f44` | P0-1 统一 URL 白名单（新增 `public/urlcheck.js`，前后端共用） |
| `2427399` | P0-2 `TRUSTED_PROXY_CIDRS`，只信任明确配置的代理 + 管理员连接诊断 |
| `ae65cca` | P0-3 普通账户探测策略 `PROBE_ALLOW`、每账户 / 总量上限 |
| `01a84c7` | P1-4 `/api/docker` 仅管理员；关联容器只对管理员生效 |
| `08576b8` | P1-1 图标缓存配额 / 过期清理 / 上游限制 / 异步原子写 |
| `1d0eefa` | P1-3 全局账户锁 + P2-8 新密码至少 8 位 |
| `a2dea2c` | P1-2 乐观并发（409 + 冲突面板）、opId、定期快照、设备本地状态 |
| `11ad4f1` | P2-1 `node:test` 测试套件（`npm test`，零依赖） |
| `5044470` | P2-2/P2-3 CI 先 `npm run check && npm test`，`build needs: test` |
| `195ce0a` | P1-4 补充：`DOCKER_SOCK` 支持 `tcp://`（可选 docker-socket-proxy）+ 测试 |
| `7eb12a1` | README / compose 文档 |
| `99b008f` | 冲突面板焦点框与说明文字间距微调 |
| `81335fe` | `nocturne.js?v=2` 缓存刷新，避免新页面配一天前缓存的同步模块 |

修改：`server.js`、`public/index.html`、`public/nocturne.js`、`package.json`、`README.md`、`docker-compose.yml`、`.github/workflows/docker.yml`
新增：`public/urlcheck.js`、`test/*.js`（9 个文件）
未改：`Dockerfile`、`docker-entrypoint.sh`（`COPY public` 已包含 `urlcheck.js`；测试文件不进镜像）。无新增依赖。

## 二、逐项状态

先核对了基准代码，审计里的疑点**全部在基准代码中成立**（只有 P2-3 部分已具备），没有发现“已修复可跳过”的项目。

### P0

| 项 | 状态 | 说明 |
| --- | --- | --- |
| P0-1 恶意协议 URL | **已修复** | 核实：基准的导入 `valid()`、服务端 `validConfig()` 都不查协议，`itemHTML` 直接把 `wan/lan` 放进 `href`。现统一用 `urlcheck.js`：导航只认字面以 `http://`/`https://` 开头、不含控制字符 / 零宽 / 首尾空白、能被 URL 解析且有主机名；搜索模板 http(s)+`%s`；图标图片 http(s) / `api/icons/<id>` / 旧版 `data:image/*`（仅兼容迁移）；壁纸 http(s) / 旧版 `data:image/*`。覆盖：添加/编辑表单、JSON 导入（拒绝并列出位置）、服务端 `PUT /api/config`（**新出现**的不安全值 → 400 + 列表）、渲染（`itemHTML` / `A.url` / 最近使用 / 离线芯片 → 无效当作没地址，`href="#"`、点击提示，不再打开空白新标签页）、⌘K 打开与搜索、自定义搜索引擎添加与使用、壁纸。**旧配置不变砖**：当前版本或快照里已有的不安全值被放行（不删除），页面不可点击，编辑面板显示「地址无效…请修改或清空」。 |
| P0-2 转发头信任 | **已修复** | 核实：基准只要对端是私网就采信 `X-Real-IP`/`XFF`/`X-Forwarded-Proto`。现默认空 = 一律用 TCP 对端；对端在 `TRUSTED_PROXY_CIDRS` 中才从右往左跳过可信跳读 XFF（遇非法段停止），无 XFF 时用 `X-Real-IP`；`X-Forwarded-Proto` 同一门槛决定 `Secure`。保留 IP / 用户名限流、在途上限、已知设备、内网豁免（按解析出的客户端 IP，且**带转发头但对端不可信时不给内网豁免**）。新增：有效「已知设备」Cookie 不受按 IP 硬锁（防止未配置代理时别人把主人锁在外面），用户名限流不变。管理员可在 设置 → 账户「连接诊断」或 `/api/health`（管理员登录时多 `client` 字段）看到对端与识别结果；被忽略的转发头会在日志提示一次。README 写了 DSM / Lucky / Cloudflare Tunnel 填法与不配置的后果。 |
| P0-3 探测 SSRF | **已修复（按单人 NAS 的威胁模型）** | 核实：基准已有元数据 / 链路本地 / 未指定 / 自身端口拦截、DNS 解析后只连检查过的地址、mapped/NAT64 归一（保留）；**不跟随重定向**（`res.destroy()` 只看首个响应，已用测试验证重定向目标从未被请求）。新增：管理员的地址照旧探测；**只有普通账户在用的地址**仅当匹配 `PROBE_ALLOW`（IP/CIDR 要求所有解析结果都在内、主机名 / `*.域名` / `*`，可带端口）时才由服务器探测；默认空 = 服务器不发请求也不查 DNS，`/api/status` 不返回这项，前端退回浏览器探测（与 `.local` 相同）；普通账户也拿不到管理员对同一地址的结果。每轮每账户 `PROBE_MAX_PER_USER`=200、总 `PROBE_MAX_TOTAL`=2000；超时 / 并发 8 不变；`blocked` 与离线区分不变。未封任何内网网段 / 端口。 |

### P1

| 项 | 状态 | 说明 |
| --- | --- | --- |
| P1-1 图标缓存 | **已修复** | `CACHE_MAX_MB`=50、`CACHE_MAX_FILES`=5000、`CACHE_TTL_DAYS`=30；启动 5 秒后、每 6 小时、写入后估算超限时异步清理（按 mtime，命中会刷新 mtime，近似 LRU；清理孤儿 `.tmp`）；只碰 `data/cache`，测试确认 `data/icons` 不受影响。搜索参数白名单 + 长度限制 + 规范化重建（同一搜索一份缓存），SVG 请求忽略查询串，路径 ≤200；上游 256KB 上限、8 秒整体超时、内容类型必须是 `image/svg+xml` / `application/json`、非 200/404 不缓存；断网回退旧缓存；读写全部异步，写入 tmp+rename；保留并发去重。`ICON_UPSTREAM` 可配（自建 Iconify / 测试用）。 |
| P1-2 多设备冲突 | **已修复（行为变化）** | 基准验证：后写覆盖 + 10 秒 toast。现在：`baseVersion` 不符 → **409**（不写）；前端弹「配置冲突」面板（沿用 `x-sheet` 样式）：**使用服务器版**（本机版先 `POST /api/config/stash` 存为快照；服务器拒收时自动导出成文件）/ **用本机版覆盖**（`force:true`+`expectVersion`，服务器锁内复核，先存被替换版本，又变了再 409）/ **导出本机版** / 稍后处理。冲突未处理时暂停推送，本机修改保留在 localStorage 并带脏标记。**opId** 取代补推启发式：同一内容的重试 / keepalive / 下次打开补推共用一个 opId，服务器记最近 50 个（写在配置文件 `ops` 字段，响应里剥掉），重复 → `{duplicate}` 不升版本；成功后清掉 opId，撤销回同一内容会用新 opId。旧 hash 判定只给**没有 opId 的旧前端**用，且从不作用于 `restore:true`（测试覆盖“恢复旧版本不被误判”）。**设备本地状态**：内网/外网 `settings.net`、「最近使用」`recent` 不再参与同步（推送时剔除，拉取 / 恢复时保留本机值）——切换不再产生新版本或冲突；代价是最近使用不跨设备（README、设置页文字已说明）。**快照**：普通保存距上一份 ≥30 分钟或 ≥20 个版本时存一份；强制覆盖 / 恢复前 / 冲突时本机版必存；上限 `BACKUP_KEEP`=30 份、`BACKUP_MAX_MB`=20MB，最新一份永远保留；快照引用的上传图标不会被清理（原 `cleanupIcons` 已扫描快照，测试确认）。**壁纸不在版本历史里**（README / 设置页已写明）。拉取时本机有未同步修改不会被覆盖。 |
| P1-3 账户并发 | **已修复** | 全局 `withAccountsLock` 串行：初始化管理员、新建、删除、重置、改密、已知设备令牌写入；「查重 → scrypt → 写入」在锁内；用户名大小写不敏感唯一。锁顺序：**账户锁 → 用户锁**（仅删除用户时在账户锁内拿用户锁清文件），持有用户锁的代码从不拿账户锁，无死锁。登录在锁内复核“用户仍存在且哈希未变”，防止与改密 / 删除竞争时换到新会话；删除 / 改密后会话失效（测试覆盖）；配置写入在用户锁内确认账户仍存在。 |
| P1-4 Docker 权限 | **已修复** | `/api/docker` 普通账户 403（前端随之隐藏「关联容器」）；`/api/status` 的容器状态回退只对管理员项目生效（否则普通账户填容器名即可探测任意容器）。默认仍不挂载 socket，未挂载时优雅降级（测试）。README 显著说明 `:ro` 挂 docker.sock 仍等同 root；可选 tecnativa/docker-socket-proxy（仅 `CONTAINERS=1`，不映射端口），`DOCKER_SOCK=tcp://docker-proxy:2375` 已支持，**非默认**。夜曲只发 `GET /containers/json`（测试断言）。 |

### P2

| 项 | 状态 | 说明 |
| --- | --- | --- |
| P2-1 自动化测试 | **已完成** | `npm test`（`node --test`，零依赖）：URL 校验、代理头、SSRF 规则、409/force/opId/stash/restore、快照与恢复、图标缓存、账户并发、Docker 权限。集成测试每个用例以临时 `DATA_DIR` 起独立 `server.js` 子进程 + 本地模拟服务。 |
| P2-2 失败阻止发布 | **已完成** | workflow 新增 `test` job（Node 22，`npm run check && npm test`），`build: needs: test`；保留 amd64/arm64。 |
| P2-3 版本与回滚 | **部分已具备 → 已完善** | 基准的 metadata-action 已有 `type=sha,format=short` 与 semver 标签；把 `sha-` 前缀写明并加注释。README 新增「版本与回滚」（备份 `data/` → 固定 tag/digest → 验证 → 回滚步骤），compose 注释建议固定标签。未改 NAS 正在运行的镜像。 |
| P2-4 分支保护 | **暂缓（仅建议）** | 按指示不动仓库设置；README「安全说明」记录建议（要求 `test` 通过、禁止强推）。 |
| P2-5 CSP | **暂缓** | 按指示不加，README 说明原因。 |
| P2-6 重构 | **不适用（本轮不做）** | 未做拆分重构。 |
| P2-7 Service Worker | **不适用（本轮不做）** | 未添加。 |
| P2-8 密码策略 | **已修复（取 8 位）** | 按本次指令取 **8 位**（工单原建议 12 位，未采用）；新建 / 改密 / 重置 / 初始化都要求 ≥8、≤200；**已有 6–7 位旧密码照常登录**，不强制下线；所有界面占位符 / 提示改为“至少 8 位”；登录限流保留。 |

## 三、验证记录

区分三类：**自动化测试通过** / **代码审查通过** / **真机验收：未进行**。

1. `npm run check && npm test` → **29/29 通过**（日志 `npm-test.log`，约 13 秒）。
2. curl 冒烟（`curl-tests.sh` / `curl-tests.log`）：未配置代理时伪造 `X-Forwarded-Proto` 不加 `Secure`、伪造 XFF 不改变识别 IP；`javascript:` / `data:text/html` 导航和 `javascript:%s` 搜索模板 → 400；合法内网 http + 公网 https → 200；两设备基于 v1 → 后者 409；重复 opId → duplicate 不升版本；force+expectVersion → 200 并生成 `replaced` 快照；非法图标搜索参数 → 400；无 socket 时 `/api/docker` → `available:false`。
3. Playwright（系统 Chromium，`ui-test.py` / `ui-test-result.json`）：
   - **390px 首页元素框与基准完全一致**：106/106 个元素位置尺寸相同（`home-390-base.png` / `home-390-new.png`），无页面错误。编辑模式 / SortableJS 拖拽代码区未改动（`git diff` 无相关 hunk）。
   - **冲突面板** 390（`conflict-390.png`）与 1440（`conflict-1440.png`）均正确弹出，弹出期间服务器保持另一台设备的版本；390 选「使用服务器版」→ 本机变为服务器版、快照里有 `local` 且内容为本机修改；1440 选「用本机版覆盖」→ 服务器为本机版、快照里有 `replaced`；两种视口下切换内网/外网**不产生新版本**。
   - **旧配置无效地址**（`invalid-url-edit-390.png`）：`javascript:` 项目 `href="#"`，点击不开新页、无弹窗、提示「地址无效，请在编辑里修改」；编辑面板显示「地址无效：只支持 http:// 或 https:// …」，保存按钮禁用；服务器上的项目未被删除。
   - **纯静态模式**（`file://…/index.html`，无 `window.NOCTURNE`）：正常渲染 12 个项目、无页面错误、URL 校验已加载；导入含 `javascript:` 的 JSON 被拒绝且状态未变（`static-390-import-rejected.png`）。
   - 管理员「连接诊断」行（`settings-390-diagnostic.png`）。
4. 未能执行：`docker build`（沙箱无 Docker）——amd64/arm64 镜像构建**未验证**，需看 CI；GitHub Actions 新 workflow **未实际运行**（未推送）。
5. 环境说明：沙箱里的 Node 把 `Date#toISOString` 改写成了本地格式（如 `Thu 2026-10-08 12:41 PM CST`），日志 / 响应里的 `updatedAt` 因此看起来不像 ISO；这是测试环境问题，不是代码改动，测试用例不依赖它。截图里 Emoji 显示为方框是沙箱缺 Emoji 字体。

**真机未验证**：iPhone Safari / 添加到主屏幕、真实触摸拖拽、真实 DSM / Lucky / Cloudflare Tunnel 反向代理、真实 docker.sock / socket-proxy、群晖上的升级与回滚流程，均**未经真机或真实环境验收**。

## 四、向后兼容

- **旧数据**：旧配置（无 `hist`/`ops`）、旧单槽备份、旧 `-vN.json` 快照、`data:image` 图标 / 壁纸迁移都照常工作（测试覆盖 legacy 配置加载 + 迁移）。配置文件只新增 `ops` 字段、快照文件名多了 `-auto`/`-replaced`/`-restore`/`-local` 后缀，旧版本会忽略 / 照常列出，**回滚镜像一般无需恢复 `data/`**。
- **新环境变量（全部可选）**：`TRUSTED_PROXY_CIDRS`（默认空）、`PROBE_ALLOW`（默认空）、`PROBE_MAX_PER_USER`（200）、`PROBE_MAX_TOTAL`（2000）、`CACHE_MAX_MB`（50）、`CACHE_MAX_FILES`（5000）、`CACHE_TTL_DAYS`（30）、`ICON_UPSTREAM`、`BACKUP_KEEP`（30）、`BACKUP_MAX_MB`（20）；`DOCKER_SOCK` 现在也接受 `tcp://`。
- **用户可见的行为变化**：
  1. 多设备冲突从“后写覆盖 + toast”改为 **409 + 冲突面板**，期间暂停同步（README、设置页文字已更新）。
  2. 「最近使用」和内网/外网切换**只存在本设备**，不再跨设备同步。
  3. 反向代理后面：**不配置 `TRUSTED_PROXY_CIDRS` 时**，外网访客共用代理 IP 限流、无内网豁免、Cookie 不带 `Secure`——升级后建议按「连接诊断」配置。
  4. 多用户时，普通账户的项目默认改由浏览器探测（单管理员使用无变化）；普通账户看不到容器清单 / 关联容器。
  5. 新密码至少 8 位；没有地址或地址无效的图标点击后提示，而不是打开空白新标签页；导入含不安全地址的 JSON 会被拒绝。
  6. 快照从“最多 10 份、仅冲突时”变为“最多 30 份、定期 + 冲突 + 恢复前”。
- **过渡期**：升级瞬间仍开着旧页面的设备，旧脚本遇到 409 只会提示“暂时无法同步”并重试（不丢数据，本机修改留在本机）；刷新页面后加载新脚本（已加 `?v=2`）即弹冲突面板。

## 五、NAS 部署（最少步骤，未在生产执行）

1. 停止项目，备份：`cp -a /volume1/docker/nocturne/data /volume1/docker/nocturne/data.bak-$(date +%Y%m%d)`。
2. 合并 / 推送分支后等 CI（test → build）通过，在 compose 里把镜像固定为新的 `:sha-xxxxxxx`（记下旧标签）。
3. `sudo docker compose pull && sudo docker compose up -d`。
4. 验证：`/api/health` 为 `ok`；登录后配置、壁纸、上传图标、状态点正常。
5. 走反向代理的话：管理员登录 → 设置 → 账户 →「连接诊断」，把“直连地址”（DSM 常见 `172.17.0.1` 或 NAS IP；cloudflared 为其容器网段）填入 `TRUSTED_PROXY_CIDRS`，重建容器后确认显示“经可信代理”。
6. 回滚：停止 → 改回旧标签 → 必要时用第 1 步备份替换 `data/` → 启动 → 检查 `/api/health`。

## 六、遗留风险

- **真机与真实代理未验收**（见上）；镜像多架构构建与 CI 首次运行未验证。
- `TRUSTED_PROXY_CIDRS` 填得过宽（整个局域网）会让列表里任何主机都能声明客户端 IP；compose 自定义网络的网关 / cloudflared 容器 IP 可能在重建后变化，需要按诊断复核。
- `PROBE_ALLOW` 的**主机名规则按名字匹配**，不校验解析结果（由管理员自行判断）；IP/CIDR 规则才要求所有解析结果在范围内。管理员账户的探测范围不受限制（设计如此：单人 NAS）。
- 默认策略下，普通账户的地址（包括元数据地址）会由**用户自己的浏览器**做 no-cors 探测——不经过服务器，但仍是一次浏览器请求。
- 冲突面板「使用服务器版」是“先存本机快照、再拉服务器版”两步；第二步失败时按钮恢复可重试，本机数据不丢，但快照里可能多一份。
- `stash` 的本机版本可能含未迁移的 `data:image` 图标，会占用快照配额（上限 20MB 内）。
- 无 CSP；内联脚本依旧，XSS 防线主要靠转义 + 本次的 URL 白名单。
- 分支保护未开启（仅建议）。
- 本报告不代表项目“绝对安全”：P0/P1 修复基于静态审查 + 本地自动化 / 浏览器测试。

## 七、复查修复（第二轮）

针对 ChatGPT 复查提出的 6 项。每项先在旧代码上复现（新增测试在旧 `server.js` 上 10 个里 8 个失败，换成新代码全部通过），再修复。

| # | 问题 | 状态 | 修复要点 | 测试 |
| --- | --- | --- | --- | --- |
| 1 | opId 复用靠 32 位弱哈希，`{"settings":{"title":"ab"},"groups":[]}` 与 `…"bA"…` 都得到 `13pgf9p.13`，会被服务器当成重复推送吞掉 | ✅ 已复现并修复 | 前端改用**纯 JS SHA-256**（同步；`http://` 内网非安全上下文没有 `crypto.subtle`，统一用纯 JS，结果与 `node:crypto` 一致，800KB 约 20ms）。服务器为每个 opId 记 `h = sha256(键排序 JSON)`（迁移前的收到内容）；同一 opId 内容不同 → **422 `{code:"opid_mismatch"}`**，不写入、绝不报成功；旧记录没有 `h` 时用 `hist` 里同版本的指纹核对，核对不了一律不认。前端收到 422 → 作废本地 opId、带新 opId 正常重推（照样走 409 冲突判定）；`pagehide` keepalive 收到 422 也作废 opId | `review2.test.js`：碰撞对确实在旧哈希下相同、新哈希不同；首次 PUT 成功但“响应丢失”，再用同一 opId 推碰撞的另一份 → 422，数据仍是 v1；换新 opId → 409；同 opId 同内容仍为 duplicate；旧 ops 记录的 hist 核对 |
| 2 | `PUT /api/config` 不带 `baseVersion` 可绕过 409 | ✅ 已复现并修复 | `baseVersion` 必须是非负整数（`Number.isSafeInteger`），缺失 / 字符串 / 小数 / 负数 → **400 `{code:"bad_base_version"}`**；版本不符 → 409；服务器还没有配置时任何合法值都可写（通常 0）。前端所有路径（普通推送、keepalive/pagehide、启动补推、恢复、强制覆盖、导入——导入走普通推送）本来就带 `baseVersion: serverVer`（整数），无需改动 | 先存 v1，再不带 / 带非法 `baseVersion`（含 force、restore）→ 400，版本和数据不变；有配置后 0 → 409 |
| 3 | 旧不安全地址豁免只看「类型 + 字符串」 | ✅ 已修复 | 豁免键改为 **（类型, 项目 / 搜索引擎 id, 字段, 原值）**，来源为当前配置和备份（备份也只对同一 id 生效）；没有 id 的项目不豁免；壁纸只有一个槽位 | A 保留自己的旧值 → 200；新项目 B 抄同值 → 400；A 的值挪到 A 的另一个字段 → 400；已有项目 C 抄 → 400；无 id 项目 → 400；改一个字符 → 400；A 的旧值从备份恢复回 A → 200 |
| 4 | 壁纸 / 图标上传、删除拿到用户锁后不再确认账户 | ✅ 已复现并修复 | 新增 `assertAlive`：拿到用户锁后确认账户仍存在且本会话仍有效，否则 **401** 且不写任何文件；壁纸 / 图标 PUT·POST·DELETE、配置 PUT、stash 都用它。`writeFileAtomic` 失败时删除临时文件，壁纸写入也改用它 | 慢速上传（先发 20 字节）→ 管理员删除该用户 → 发完：壁纸 PUT、图标 POST、图标 PUT 均 401，`wallpapers/` 无文件 / 临时文件，`icons/<user>` 未被重建；另一设备改密码使会话作废后上传 → 401 |
| 5 | `X-Forwarded-Proto` 取最左值，可被客户端伪造 | ✅ 已修复 | 可信代理时按与 XFF 相同的跳数**从右往左**取（单跳 = 最右边、代理追加的值；多跳 = 记下客户端地址那一跳）；列表比跳数短（代理是覆盖写）取最左边；重复的头（Node 以 `, ` 合并）同样处理；不可信对端一律不看。README 增加「反向代理必须覆盖 `X-Forwarded-Proto`」及 DSM / Lucky / cloudflared / nginx 说明与自查方法 | 单元：`forwardedProto` 各情形；集成：不可信对端伪造 → 非 https；可信代理在伪造值后追加 `http` → 非 https；两跳 `https, http` + XFF `1.2.3.4, 10.1.1.1` → https；左侧伪造的第三个值被忽略；重复头两种顺序 |
| 6 | 补测试：PROBE_ALLOW / 端口 / 通配符 / 图标缓存并发 | ✅ 已补 | 图标缓存：上游并发上限 8（排队），超限后立即异步清理、清理中又超限则结束后再跑一次；README 注明 `CACHE_MAX_FILES/MB` 是**软上限** | `probe-allow.test.js`（模拟 DNS）：一个允许 + 一个不允许地址 → 不允许；含元数据地址（含 `::ffff:` 形式）→ 拦截；`10.0.0.0/8:8096` 只放 8096，默认 80/443 不放；`*.lan` 不匹配 `lan`、`evil-lan`、`xlan`、`lan.evil.com`、`nas.lan.evil.com`；端口越界规则被忽略。`iconcache.test.js`：80 个不同图标并发，上游并发峰值 ≤ 8，磁盘峰值实测 32–33 个文件（上限 20、共写 160 个），断言 ≤ 60，之后回落到 ≤ 20 |

**用户可见变化**：无界面改动（390px 首页 85 个元素的位置尺寸与修改前逐一相同）。仅在异常情况下有差别：同一 opId 内容不符时前端自动换 opId 重推（用户无感）；上传途中账户被删 / 会话失效时上传失败并提示登录过期；`index.html` 把 `nocturne.js` 缓存参数升到 `?v=3`。

**本地验证**：`node --check`、`npm run check` 通过；`npm test` **43/43 通过**（原 29 + 新增 14）。Playwright（`/usr/bin/chromium`，390×844）：正常编辑 → 服务器 v1→v2 且标题一致；另一设备写入后本机再改 → 冲突面板弹出、服务器未被覆盖；选「用本机版覆盖」→ 写入成功；模拟一次 422 `opid_mismatch` → 前端换新 opId 重推成功；390 首页元素框与修改前完全相同；纯静态打开 `index.html` 无报错。

**CI**：代码提交（远端 `4d85cf35ede4f9182a12d82f0b0f1554ae38fb71`，最后上传 `server.js` 触发）的运行 **#37734538894：success**（test 43/43 通过，build 通过）——<https://github.com/sadjdg123/nocturne/actions/runs/37734538894>。本报告随后单独以 `[skip ci]` 提交，不触发新的运行。

**取舍说明**：
- 前端不用 `crypto.subtle`：它是异步的，且在 `http://NAS-IP` 上不可用；统一用同步纯 JS 实现，避免两套结果、也不用改推送流程。
- opId 不符用 **422** 而不是 409：旧前端会把任何 409 当成冲突弹面板，422 对旧前端只是“暂时无法同步、稍后重试”（不丢数据）。
- 服务器上没有配置时不校验 `baseVersion` 的值（只校验格式），以便数据目录被清空后设备还能把本机配置推上去。
