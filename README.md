# 夜曲 Nocturne

**V2.1.0 · Midnight Edition**。群晖 NAS 自托管的私人起始页，Node 22 零运行依赖，原生 HTML/CSS/JS，无前端构建步骤。镜像支持 linux/amd64 和 linux/arm64。

- Midnight 与经典外观；手机底栏、场景空间、排序及撤销。
- 多账户、跨设备配置同步、离线修改、冲突保护与配置快照。
- 内外网地址选择、搜索别名、⌘K 快速打开、NAS 侧服务状态。
- 自托管字体、图标代理缓存、自定义图片及 iPhone 主屏幕模式。
- 损坏文件保护、账户/会话持久事务、完整备份与失败恢复保护。

![夜曲 Nocturne 桌面截图（示例数据）](docs/screenshot.png)

## 部署与首次使用

需要 DSM 7.2+ Container Manager，操作由用户自行完成。

1. 准备项目目录与 data/，复制 docker-compose.yml。
2. 将 `image:` 替换为 [版本表](docs/HANDOFF-CODEX.md#01-版本--镜像--digest) 的 V2 正式版固定镜像。模板的 latest 仍是 V1.1，不要用它升级 V2。
3. 按实际用户设置 PUID/PGID（常见 1026/100），确认端口不冲突，然后创建并启动项目。
4. 在内网打开 `http://NAS的IP:8088`，创建管理员（新密码 8–200 字）。初始化前不要公开入口，防止他人抢先创建。
5. 确认健康、配置保存与重启持久性。新安装有副本站工具可选，见 [人工验收](docs/v2.0-manual-acceptance.md)。

公开 GHCR 镜像可匿名拉取；自建私有镜像需要用户在 NAS 执行 `docker login ghcr.io`（仅 read:packages），不要把令牌写进 compose 或文档。源码部署时注释 image 并启用模板的 build。

```sh
sudo docker port nocturne 8080/tcp
NAS_IP=${NAS_IP:-192.168.50.141} # 替换为实际绑定 IP
curl -s "http://$NAS_IP:8088/api/health"
```

端口绑定到具体 IP 时 localhost/127.0.0.1 不可达，应使用绑定 IP。bridge 网络通常足够；服务地址用 NAS 可达的内网 IP，容器一般不能解析 Bonjour `.local`。不直接暴露应用端口到公网。

### 账户与迁移

设置 → 账户 可修改密码、退出、由管理员管理用户。密码修改后其他设备会话失效；已有旧短密码仍可登录。登录失败有 IP/账户限流，可信客户端地址与已知设备按已有规则处理；默认会话有效期 30 天。公网私人首页保持认证开启，不设置 `NOCTURNE_NO_AUTH=1`。

旧静态页迁移：在旧地址导出配置，再在新地址登录并导入（localStorage 按网址隔离）。同地址且服务器无配置时会迁移已有本机配置；迁移兼容代码保留。

### 可选容器状态

默认不挂载 Docker socket。需要时按模板挂载，只有管理员可列容器与关联项目。**docker.sock 的 :ro 挂载仍可调用 Docker API，等同 Docker 管理权限**；仅在可信环境启用，或使用限制 API 的 socket proxy 并通过 DOCKER_SOCK 配置。此功能不影响普通 HTTP 状态检测。

## 外网访问 / HTTPS（反向代理）

不要把 8088 端口直接暴露到公网，建议走 HTTPS 反向代理：

TLS 在反向代理终止，夜曲上游为 HTTP。代理目标须使用容器地址或实际绑定的 NAS IP；端口绑到具体 IP 时不要使用 localhost。

### jingbo.men 私人首页（后续部署）

本次只发布镜像，不切换域名、Tunnel 或 Sun-Panel。后续应先完成内网管理员初始化，保持夜曲登录开启；现有 Cloudflare Access 入口须仅允许本人身份，不设置 Everyone/Bypass，并确保不能绕过入口直接访问源站。Access 配置与上线验证留到域名切换时执行，参见 [Cloudflare 官方说明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

实际切换后检查有效 HTTPS 证书、未授权身份被拒、管理员诊断 `client.https=true`，以及会话和设备 Cookie 均为 `Secure; HttpOnly; SameSite=Lax`；不能用本地测试代替线上结论。

### 可信代理：`TRUSTED_PROXY_CIDRS`

夜曲**默认不信任任何转发头**（`X-Forwarded-For`、`X-Real-IP`、`X-Forwarded-Proto`），一律以 TCP 直连对端的地址作为客户端 IP，
也只按这个连接本身判断是否 HTTPS —— 这样谁都不能靠伪造请求头绕过登录限流或「内网豁免」。

放在反向代理后面时，请把**代理连到夜曲时使用的地址**填进 `TRUSTED_PROXY_CIDRS`（逗号分隔，IP 或 CIDR），例如：

```yaml
    environment:
      - TRUSTED_PROXY_CIDRS=172.17.0.1
```

只有直连对端在这个列表里时，夜曲才读取转发头：`X-Forwarded-For` 从右往左跳过列表里的代理，第一个不在列表里的地址就是真实客户端；
没有 `X-Forwarded-For` 时用 `X-Real-IP`；`X-Forwarded-Proto: https` 才会让登录 Cookie 带上 `Secure`。
`X-Forwarded-Proto` 若是逗号列表（或出现多次），按和 `X-Forwarded-For` 相同的跳数**从右往左**取：
只经过一层代理时取最右边那个（代理追加的值），客户端自己塞进来的 `X-Forwarded-Proto: https` 不会被采信。

> **反向代理必须覆盖（而不是透传）`X-Forwarded-Proto`**，否则客户端伪造的值可能原样到达夜曲：
> - **群晖 DSM 反向代理**：在规则的「自定义标头」里新增 `X-Forwarded-Proto`，值填 `$scheme`。
> - **Lucky**：在反向代理规则的自定义请求头里设置 `X-Forwarded-Proto`（TLS 入口填 `https`）。
> - **cloudflared**：Cloudflare 边缘会按访客到 Cloudflare 的协议设置 `X-Forwarded-Proto`；不要在 cloudflared 和夜曲之间再叠一层透传该头的代理。
> - **nginx**：`proxy_set_header X-Forwarded-Proto $scheme;`（覆盖而不是追加）。
>
> 自查：管理员登录后访问 `/api/health`，`client.https` 应与浏览器地址栏的协议一致。

**怎么知道该填什么**：先不填，经反向代理用**管理员**账号登录，打开 设置 → 账户，页面底部有一行「连接诊断」：

> 连接诊断：服务器看到的直连地址 **172.17.0.1** → 识别为客户端 172.17.0.1（收到了转发头，但 172.17.0.1 不在 TRUSTED_PROXY_CIDRS 里…）

「直连地址」就是要填的值（也可以访问 `/api/health`，管理员登录时会多出 `client.peer` / `client.ip` 字段；日志里也会提示一次）。
填好、重建容器后再看：应显示「→ 识别为客户端 <你的公网 IP>（经可信代理）」。常见情况：

| 部署方式 | 夜曲看到的直连地址（通常） | 建议填写 |
| --- | --- | --- |
| 群晖 DSM 反向代理 → `localhost:8088`（bridge 网络；仅当 `ports` 没有绑定具体 IP 时可用，绑定了如 `192.168.50.141:8088` 就要填那个 IP，见下一行） | Docker bridge 网关，例如 `172.17.0.1`；自定义 compose 网络常见 `172.18.0.1`、`172.19.0.1`… | 诊断里显示的那个网关地址 |
| 群晖 DSM 反向代理 → `NAS的IP:8088` | NAS 自己的内网 IP（如 `192.168.1.10`），有时也是网关地址 | 诊断里显示的地址 |
| Lucky（host 网络 / 套件）| 同上：网关地址或 NAS IP | 诊断里显示的地址 |
| Cloudflare Tunnel（cloudflared 容器在同一 compose 网络） | cloudflared 容器的 IP（如 `172.20.0.3`，重建后可能变化） | 优先只填该代理 IP；需要 CIDR 时只含受控代理，不信任共享容器网段 |

> ⚠️ 只填你自己的代理。**不要**填 `0.0.0.0/0`，也尽量不要把整个家庭局域网（如 `192.168.1.0/24`）都填进去 ——
> 列表里的每个地址都可以替任何人「声明」客户端 IP。
>
> **不配置时的后果**：通过反向代理来的所有访客在夜曲看来都是同一个代理地址：按 IP 的登录限流会合并计算
> （别人输错 5 次，其他人也要等 10 分钟；你自己的「已知设备」不受影响），「内网不受用户名封禁」的豁免对这些请求**不生效**，
> 登录 Cookie 也不会带 `Secure`（浏览器到代理这一段仍然是 HTTPS，只是 Cookie 少了这个标记）。直接用内网 IP 访问不受影响。

---

## 网络模式、搜索别名与快速打开

### 三态网络：自动 / 优先内网 / 优先外网

页头右上角的网络按钮显示**当前实际生效的选择**，例如「自动·外网」「内网」。点它弹出小菜单：

| 模式 | 行为 |
| --- | --- |
| **自动** | 只看「你是从哪个地址打开夜曲的」：私网 IP（10/8、172.16/12、192.168/16）、回环、IPv6 ULA（fc00::/7）、链路本地、`localhost`、`*.lan` / `*.local` / `*.home.arpa` → 优先内网；其余（公网域名、Tailscale 的 100.64.0.0/10 与 `*.ts.net`、无法判断）→ **保守地优先外网** |
| **优先内网** | 用项目的内网地址，没有有效内网地址时用外网地址 |
| **优先外网** | 用项目的外网地址，没有有效外网地址时用内网地址 |

- 只填了一个地址的项目总是用那个地址；两个都无效（不是 http/https）时不可点击，并提示去编辑。
- **自动不会做网络探测**：不扫描网段、不测速、不发跨域 / no-cors 请求。NAS 的状态点只说明「NAS 能访问这个服务」，**不代表你这台设备能打开它**，
  所以也不拿它来选地址。在家里用公网域名打开时，自动会偏向外网；觉得内网更快就在菜单里选「优先内网」，这台设备会记住。
- 网络模式**只存在这台设备上**（和「最近使用」一样）：切换不会产生新的配置版本、不会和其他设备冲突；导入配置、撤销、从服务器恢复都不改它。
- 升级兼容：以前在这台设备上选过「内网」/「外网」的，升级后**保持原样**；从没打开过夜曲的新设备默认「自动」。
- `https://` 页面打开 `http://` 内网地址时交给浏览器正常跳转；打不开时浏览器会自己报错，夜曲不会把它记成「访问成功」。

**备用地址**：同时有有效内网、外网地址的项目，可以显式用另一个地址打开：

- 命令面板里选中这个项目（搜索结果第一项默认选中，或用 ↑↓ 移过去）时，下面会多出「用内网地址打开」「用外网地址打开」两行，标出哪个是当前推荐；
- 编辑模式下点一下项目，操作菜单最上面也有这两项（手机上不用长按、不用键盘）。

主页面点项目仍然按当前模式**立即打开**，不会先探测再跳转。长按图标仍然是进入编辑。

### 搜索别名（`aliases`）

编辑项目 →「更多」→「搜索别名」，例如给 MoviePilot 填 `mp, 影视订阅, moviepilot`，之后在命令面板输入 `mp` 就能直接命中。

- 逗号或回车分隔；自动去掉首尾空格、大小写不敏感去重；最多 10 个，每个最多 32 个字。
- 别名**只是搜索文本**：不会被当成网址、脚本或命令执行。随项目一起同步、导出 / 导入、进快照；不填别名的旧项目完全不变（没有 `aliases` 字段）。
- 服务器会校验：不是字符串数组、超过 10 个、单个超过 32 字或含控制字符 → 整份配置 400（`code: "bad_aliases"`），不写入、不升版本；纯静态页导入时同样校验。

### 命令面板 / 快速打开

- 打开：`⌘K` / `Ctrl+K` / `/`；手机上点右上角「···」→「**快速打开**」（主搜索框的行为不变，仍是用搜索引擎搜索）。
- 排序：**标题完全相同 > 标题开头相同 > 别名（完全相同 / 开头相同）> 标题包含 / 模糊 > 描述或地址**；同一档里最近用过的靠前。
  同一个项目只出现一次；别名和别的项目标题重名时，标题命中的那个排前面，两者都显示（命中别名的会注明「别名：…」）。
  结果标注「服务 / 分组 / 操作 / 搜索」，分组、操作和搜索引擎那一行不会被挤掉。
- 输入 `>` 只显示内置操作：自动网络、优先内网、优先外网、重新检测状态、进入 / 退出编辑、打开设置、添加项目。
  执行后按真实结果提示，例如「检测完成：5 个在线，1 个离线（NAS 侧检测）」；读取失败会直接说失败。
- 键盘：↑↓ / Tab 选择，Enter 打开，`⌘Enter` / `Ctrl+Enter` 新标签页打开，Esc 关闭。
- iPhone：软键盘弹出时面板会缩到可见区域内，结果可以滚动，点一下即执行；右上角「取消」或点面板外面关闭。

---

## 更新、备份与恢复

当前正式版与历史镜像统一见 [开发交接版本表](docs/HANDOFF-CODEX.md#01-版本--镜像--digest)。生产固定到 `标签@digest`；SHA 标签按项目约定不覆盖，GHCR 本身不保证标签不可变。`:latest` 跟随 main，仍为 V1.1。

1. 用户停止唯一写入实例，按 [停写完整备份](docs/stopped-backup.md) 保存并校验整个 `data/`。
2. 将 compose 的 image 改成目标 `标签@digest`，拉取并重建。
3. 检查 `/api/health` 版本、登录、空间、配置、壁纸和图标；公网入口检查连接诊断和 Cookie。

```sh
# 唯一写入实例停止后，创建并校验完整备份
sh tools/backup.sh -o /path/to/backups ./data
sh tools/verify-backup.sh /path/to/backups/nocturne-backup-<时间>.tar.gz
# 恢复只写新空目录；--force 会保留原目录，详见恢复手册
sh tools/restore.sh <备份.tar.gz> <新空目录>
```

热备份用于日常尽力备份，不能代替跨文件一致的停写灾备基准。完整备份包含账户、会话、配置、空间旁路、图片、固定快照及认证事务/退休清理凭据，不能只复制 users.json/config。恢复失败或中断时保留材料，按 [恢复保护](docs/restore-recovery.md) 处理。

正常数据保持 RC.1–RC.5 兼容；旧 RC 不认识新增认证事务材料。**回滚旧版前必须由当前版完成事务恢复并正常停止**，或使用完整升级前备份，见 [工程回滚边界](docs/engineering-rollback.md)、[RC 升级](docs/v2.0-upgrade-rc.md)、[V1.1 ↔ V2](docs/v2.0-upgrade-rollback.md)。

配置保存有版本冲突保护、最近 50 个操作去重和快照环。冲突时可使用服务器版、以本机版覆盖、导出或稍后处理；覆盖和恢复之前均保留当前快照。设置 → 账户 → 数据 →「恢复较早的版本」可找回配置。**壁纸历史不在快照环中**，应保存完整备份。配置 JSON 导出含上传图标，但不包含自定义壁纸文件。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 容器内监听端口 |
| `DATA_DIR` | `/data` | 数据目录 |
| `TZ` | `Asia/Shanghai` | 时区：日志按本地时间输出（带时区偏移，如 `+08:00`） |
| `PUID` / `PGID` | `1000` / `1000` | 容器内运行用户的 uid / gid，并把 `data/` 改成这个属主（群晖常见 `1026` / `100`） |
| `UV_THREADPOOL_SIZE` | `16` | Node 线程池大小（DNS 解析用），一般不用改 |
| `NOCTURNE_NO_AUTH` | 未设置 | 设为 `1` 关闭登录，所有人共用一份配置（仅限纯内网） |
| `STATUS_INTERVAL` | `30` | 服务状态检测间隔（秒，最小 10） |
| `PROBE_TIMEOUT` | `4` | 单次检测超时（秒） |
| `SESSION_DAYS` | `30` | 登录有效天数 |
| `NOCTURNE_COOKIE_PREFIX` | `nocturne_` | Cookie 名前缀（2.0.0-rc.2 起）：会话 cookie 叫 `<前缀>sid`、已知设备 cookie 叫 `<前缀>dev`，默认就是原来的 `nocturne_sid` / `nocturne_dev`（改了前缀，所有设备要重新登录一次）。浏览器的 cookie **不按端口区分**：同一主机名下跑两个实例（例如生产 8088 + 测试 8089）时给其中一个换前缀（如 `nocturne_v2test_`），登录和「已知设备」就互不覆盖。只能用字母、数字、`_` `.` `-`，1–32 个字符、以字母或数字开头；不支持 `__Host-` / `__Secure-`（它们要求每个响应都带 `Secure`，本程序只在 HTTPS 请求上加）。不合法时启动报错退出。`HttpOnly` / `SameSite=Lax` / `Secure` 规则不变 |
| `DOCKER_SOCK` | `/var/run/docker.sock` | Docker socket 路径，或 `tcp://主机:端口`（docker-socket-proxy） |
| `PROBE_PRIVATE_ONLY` | 未设置 | 设为 `1` 时状态检测**只访问内网地址**（10/8、172.16/12、192.168/16、100.64/10、fc00::/7、回环；`.local` / `.lan` / `.home.arpa` 也必须解析到这些地址）。外网域名会显示为「未检测」。默认不限制，因为外网地址通常就是公网域名 |
| `PROBE_TLS_STRICT` | 未设置 | 设为 `1` 时校验 HTTPS 证书；默认不校验（家里的自签名证书也算在线） |
| `TRUSTED_PROXY_CIDRS` | 空（不信任转发头） | 可信反向代理的地址（IP / CIDR，逗号分隔）。只有直连对端在这里面时才读 `X-Forwarded-For` / `X-Real-IP` / `X-Forwarded-Proto`。见「外网访问 / HTTPS」 |
| `PROBE_ALLOW` | 空 | **普通账户**的项目允许由 NAS 探测的目标：IP / CIDR（所有解析结果都要在范围内）、主机名或 `*.域名`、`*`，都可带 `:端口`，例如 `192.168.1.0/24,nas.lan:5000,*:8096`。空 = 普通账户的地址一律由浏览器自己检测。管理员的项目不受影响 |
| `PROBE_MAX_PER_USER` / `PROBE_MAX_TOTAL` | `200` / `2000` | 每轮检测：每个账户最多多少个地址 / 总共多少个（多出的地址由浏览器检测） |
| `CACHE_MAX_MB` / `CACHE_MAX_FILES` / `CACHE_TTL_DAYS` | `50` / `5000` / `30` | 图标缓存 `data/cache` 的上限与过期天数（启动后和每 6 小时清理一次，超限时立即异步清理；按最近使用时间淘汰；不影响 `data/icons`）。这是**软上限**：同时最多拉取 8 个不同的上游图标，突发大量新图标时磁盘上的文件数会短暂超出上限（约「上限 + 一轮清理期间新写入的文件」），随即回落 |
| `ICON_UPSTREAM` | `https://api.iconify.design/` | Iconify API 地址（可换成自建实例） |
| `BACKUP_KEEP` / `BACKUP_MAX_MB` | `30` / `20` | 每个账户保留的配置快照份数 / 总大小 |

自定义壁纸固定存放在 `DATA_DIR/wallpapers/`（单张上限 15MB，支持 JPEG / PNG / WebP；页面会先把图片缩到长边 2560px 再上传）。
上传的图标存放在 `DATA_DIR/icons/<用户名>/`（单个上限 512KB，每个账户最多 500 个、共 50MB，超出返回 413；只收 PNG / JPEG / WebP，不收 SVG；没有透明通道的图标会存成 JPEG）。
旧版本把壁纸和上传的图标以 data URL 存在配置里，升级后启动或下次同步时会自动转存成文件并改写配置。

---

## 开发与维护

```sh
DATA_DIR=./data node server.js  # http://localhost:8080
npm run check
CI=true JSDOM_PATH=/path/to/node_modules/jsdom npm test
```

运行不需要 npm install；完整测试需要测试专用 jsdom@24，以及 Python/dash/BusyBox 等环境。CI 安装 jsdom，镜像不包含它。详细开发环境、数据布局、API 和验证范围见 [开发交接](docs/HANDOFF-CODEX.md)。

直接打开 public/index.html 仍支持纯静态模式。字体子集再生成用 tools/subset-fonts.py；不会进入运行依赖。开发流程：相关测试 → v2 → 现有 Actions 全量测试/双架构构建 → 新 SHA 镜像 → 用户自行升级。main 保持 V1.1，不覆盖旧镜像，不操作生产 NAS。

## 安全与维护边界

链接仅允许 http/https，旧无效值保留但不可点击；旧 data URL 图片自动迁移。当前有 DENY/nosniff 等响应头，尚未启用页面 CSP（内联脚本多）。认证同步事务的磁盘 I/O 与 DSM 真机性能见 [工程报告](docs/phase2-engineering-report.md)，本地与 Linux 测试不代替真实断电或域名上线验收。

- [当前发布记录](docs/v2.1.0-report.md)
- [账户事务](docs/auth-transactions.md)、[恢复保护](docs/restore-recovery.md)、[停写备份](docs/stopped-backup.md)
- [按需工程验证](docs/engineering-verification.md)、[人工验收](docs/v2.0-manual-acceptance.md)
- [历史阶段归档](docs/archive/README.md)；RC 报告仍保留在 docs/ 供升级核查。

## 许可

MIT
