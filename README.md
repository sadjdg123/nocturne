# 夜曲 Nocturne

一个跑在群晖 NAS 上的自托管起始页：星空壁纸、分组图标、内网/外网一键切换、服务在线状态。
在原来的纯静态页面基础上加了一个零依赖的小后端（Node.js 22，只用内置模块）：

- **多账户登录**：首次打开创建管理员，管理员可添加/删除用户、重置密码；每个人有自己的分组和设置。
- **配置同步**：配置保存在 NAS 上，手机、电脑登录同一账户自动同步；浏览器里仍保留一份离线缓存。
- **服务端状态检测**：NAS 每 30 秒从内网检测每个服务，所以你在外面用 4G/5G 打开时，状态点也是准的。
- **容器状态（可选）**：挂载 docker.sock 后，可以给项目「关联容器」，用容器运行状态当作在线依据。
- **图标代理与缓存**：Iconify 图标经 NAS 代理并缓存到本地，不怕限流；字体也已自托管（子集化，约 0.8MB），不依赖 Google Fonts。
- **自定义壁纸存成文件**：从相册选的壁纸上传到 NAS（`data/wallpapers/`），配置里只记一个引用，换设备也在。
- **多设备冲突提示**：另一台设备刚改过配置时，会提示「已用本机版本覆盖」，并可一键「改用服务器版」。
- **添加到主屏幕**：带图标与 Web App Manifest，iPhone Safari「添加到主屏幕」后是全屏的「夜曲」。
- 镜像同时支持 **x86（amd64）** 和 **ARM（arm64）** 群晖。

![夜曲 Nocturne 桌面截图（示例数据）](docs/screenshot.png)

---

## 目录

1. [在群晖 Container Manager 部署](#在群晖-container-manager-部署)
2. [首次使用：创建管理员](#首次使用创建管理员)
3. [从旧页面迁移配置](#从旧页面迁移配置)
4. [容器状态（docker.sock，可选）](#容器状态dockersock可选)
5. [外网访问 / HTTPS（反向代理）](#外网访问--https反向代理)
6. [更新](#更新)
7. [备份与恢复](#备份与恢复)
8. [环境变量](#环境变量)
9. [本地开发](#本地开发)

---

## 在群晖 Container Manager 部署

需要 DSM 7.2 及以上（套件中心里的 **Container Manager**）。两种方式任选其一。

### 方式一：使用构建好的镜像（推荐）

前提：把这个仓库推到你自己的 GitHub，`main` 分支每次推送都会由 GitHub Actions 自动构建镜像并发布到
`ghcr.io/sadjdg123/nocturne:latest`（只改文档不触发构建；连续推送时只构建最新的一次）。
仓库是私有的话，镜像默认也是私有的，NAS 拉取会报 `denied` / `unauthorized`。两种办法任选：

- **保持私有（推荐）**：
  1. GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate new token，
     **只勾 `read:packages`**，复制生成的 token。
  2. 控制面板 → 终端机和 SNMP → 启用 SSH，用 SSH 登录 NAS，执行：
     ```bash
     sudo docker login ghcr.io -u sadjdg123
     # Password 处粘贴上一步的 token（不是 GitHub 密码）
     ```
     登录信息保存在 NAS 上，之后 Container Manager 的「项目」创建和「更新」都能正常拉取。
  3. 也可以在 Container Manager → 注册表 → 设置 → 新增，填 `https://ghcr.io`、用户名和上面的 token
     （这条路径**未实测**，不行就用 SSH 的方式）。
- **改成公开**：GitHub → 你的头像 → Packages → nocturne → Package settings，把可见性改为 **Public**
  （任何人都能拉取镜像，镜像里包含全部代码）。

1. 打开 **File Station**，在 `docker` 共享文件夹里新建文件夹 `nocturne`，再在里面新建 `data` 文件夹。
2. 把本仓库的 `docker-compose.yml` 上传到 `/docker/nocturne/`，用文本编辑器把
   `sadjdg123` 改成你的 GitHub 用户名（**全部小写**）。
3. 打开 **Container Manager → 项目 → 新增**：
   - 项目名称：`nocturne`
   - 路径：选择 `/docker/nocturne`
   - 来源：选择「使用现有的 docker-compose.yml」
4. 一路下一步，勾选「项目创建完成后启动」，完成。
5. 浏览器打开 `http://NAS的IP:8088`。

> 如果 8088 端口被占用，把 compose 里的 `"8088:8080"` 左边的数字改成别的端口。

> **数据文件的属主**：容器默认以 uid/gid `1000:1000` 写 `data/`（文件权限 0600）。如果你想用 File Station / SMB
> 直接复制或查看 `data/`，可以在 compose 的 `environment` 里加上你自己的 uid/gid，群晖常见是：
> ```yaml
>       - PUID=1026
>       - PGID=100
> ```
> （SSH 执行 `id 你的用户名` 可以查到）。重启容器后会自动把 `data/` 改成这个属主。Hyper Backup 以 root 运行，不受影响。

### 方式二：在 NAS 上从源码构建

适合不想用 GitHub 的情况。

1. 把整个项目文件夹（包含 `Dockerfile`、`server.js`、`public/` 等）上传到 `/docker/nocturne/`。
2. 编辑 `docker-compose.yml`：注释掉 `image:` 这一行，取消注释 `# build: .`。
3. 按方式一的第 3、4 步创建项目，Container Manager 会在 NAS 上构建镜像（第一次需要几分钟，要能访问 Docker Hub）。

### 网络说明

默认的 bridge 网络就够用：状态检测是由容器直接访问你填写的**内网 IP**（例如 `http://192.168.1.20:8096`），
容器能访问到局域网。只有当你用 `localhost` / `127.0.0.1` 来填写服务地址时，才需要改成 `network_mode: host`
（这时端口映射失效，直接访问 `http://NAS的IP:8080`）。

> 💡 **内网地址建议填 IP**（如 `http://192.168.1.20:5000`），不要填 `xxx.local`：群晖的 `.local` 名字靠 Bonjour（mDNS），
> Mac / iPhone 的浏览器能解析，但容器里解析不了。遇到解析不了的 `.local` 地址，夜曲会改用浏览器自己检测，不会误报离线，
> 但只有填 IP 才能由 NAS 统一检测。

---

## 首次使用：创建管理员

第一次打开页面时还没有任何账户，会显示「**创建管理员**」界面：输入用户名（字母、数字、`.` `_` `-`）和至少 6 位的密码即可，创建后自动登录。

> ⚠️ 在创建管理员之前，任何能访问这个地址的人都能抢先创建。请**先在内网完成初始化，再开放外网访问**。

之后：

- **设置 → 账户**：查看当前账户、修改自己的密码、退出登录。
- 管理员在同一页可以**添加用户**（可设为管理员）、**重置密码**、**删除用户**（会同时删除该用户的配置）。
- 修改或重置密码后，该账户在其他设备上的登录会失效，需要重新登录。
- 连续输错密码 5 次，该 IP 会被锁定 10 分钟；另外同一个用户名 15 分钟内输错 10 次（不论来自哪个 IP），
  这个用户名会暂停登录 15 分钟（第 5 次起每次会逐渐变慢）。只影响这一个用户名，其他账户照常登录；登录成功即清零。
- 登录状态保存 30 天（使用中会自动续期）。

只在家里内网使用、不想要登录？设置环境变量 `NOCTURNE_NO_AUTH=1`，所有人共用一份配置。**不要在开放外网时这样做。**

---

## 从旧页面迁移配置

旧版起始页把配置存在浏览器的 localStorage 里，而 localStorage 是**按网址隔离**的：换了地址（例如从
`file://` 或别的网址换到 `http://NAS:8088`），新页面读不到旧数据。所以推荐：

1. 在**旧页面**：设置 → 数据 → **导出配置**，得到一个 `yeqv-backup-日期.json`。
2. 在**新页面**登录后：设置 → 数据 → **导入配置**，选择刚才的文件。导入后会自动同步到 NAS。

自动迁移：如果新页面和旧页面是**同一个网址**（例如你原来就在 `http://NAS:8088` 上用旧版），第一次登录时，
若服务器上还没有你的配置，会自动把浏览器里已有的配置上传到 NAS，无需手动操作。

---

## 容器状态（docker.sock，可选）

在 `docker-compose.yml` 里取消注释这一行：

```yaml
      - /var/run/docker.sock:/var/run/docker.sock:ro
```

重新构建/启动项目后，编辑项目时「更多」里会出现「**关联容器**」输入框（带容器名称提示）。
当某个项目没有可检测的网址，或者 HTTP 检测失败（连接不上）时，会改用该容器是否 `running` 作为在线状态。
没有挂载 docker.sock 时，这个功能会自动隐藏，不影响其他功能。

> 🔐 **安全说明**：能访问 docker.sock 就等于拥有 NAS 上 Docker 的完全控制权（相当于 root）。
> `:ro` 只是让挂载点只读，**并不能**阻止通过这个 socket 调用 Docker API。夜曲本身只会读取容器列表
> （`GET /containers/json`），但如果夜曲被攻破，攻击者理论上可以控制所有容器。
> 只在你信任的网络环境里开启；更稳妥的做法是使用 [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)
> 只开放 `CONTAINERS=1`，再把 `DOCKER_SOCK` 指向它（目前仅支持 unix socket 路径）。
>
> 容器内进程以非 root 的 `node` 用户运行；启动脚本会自动把它加入 docker.sock 所属的用户组以便读取。

---

## 外网访问 / HTTPS（反向代理）

不要把 8088 端口直接暴露到公网，建议走 HTTPS 反向代理：

**群晖自带反向代理**：控制面板 → 登录门户 → 高级 → 反向代理服务器 → 新增

| 项目 | 来源 | 目的地 |
| --- | --- | --- |
| 协议 | HTTPS | HTTP |
| 主机名 | `home.你的域名.com` | `localhost` |
| 端口 | 443（或你的外网端口） | 8088 |

证书在 控制面板 → 安全性 → 证书 里为该域名配置（可用 Let's Encrypt）。

**Lucky**：Web 服务 → 添加规则 → 反向代理，目标填 `http://NAS的IP:8088`，开启 TLS 即可。

后端会读取代理传来的 `X-Forwarded-Proto: https`，自动给登录 Cookie 加上 `Secure`。

登录失败限流按真实客户端 IP 计算：只有直连夜曲的是**内网地址**（群晖反代、Lucky、Docker 网关）时才信任代理头，
优先用 `X-Real-IP`（DSM / Lucky / nginx 设成 `$remote_addr`），没有再取 `X-Forwarded-For` **最右边**的地址
（离夜曲最近的那一跳代理追加的；最左边的值客户端可以随便伪造）。多层代理时请让最外层代理设置 `X-Real-IP`。

---

## 更新

- **方式一（镜像）**：Container Manager → 项目 → nocturne → 操作 → **停止**，然后到「映像」里对
  `ghcr.io/…/nocturne` 点 **更新**（或删除后重新拉取），再启动项目。
  也可以 SSH 执行：`cd /volume1/docker/nocturne && sudo docker compose pull && sudo docker compose up -d`
- **方式二（源码）**：用新文件覆盖 `/docker/nocturne/` 里的代码（**不要覆盖 `data/`**），然后在项目里选择 **构建** 再启动。

数据都在 `data/`，更新不会丢失配置。

---

## 备份与恢复

所有数据都在 compose 文件旁的 `data/` 文件夹：

```
data/
├── users.json        账户（密码为 scrypt 哈希）
├── sessions.json     登录会话
├── config/<用户名>.json  每个用户的配置
├── wallpapers/<用户名>.jpg|png|webp  自定义壁纸（从相册上传的图片）
├── icons/<用户名>/<id>.png|jpg|webp  上传的图标（不再被引用满 24 小时后自动清理）
├── backup/<用户名>/<时间>.json  被覆盖前的配置，每人保留最近 10 份（「改用服务器版」用）
└── cache/            图标缓存（可随时删除）
```

备份：直接复制整个 `data/` 文件夹（Hyper Backup 勾选 `/docker/nocturne` 即可）。
恢复：停止容器 → 放回 `data/` → 启动。
单个用户也可以随时在 设置 → 数据 → 导出配置 做一份 JSON 备份（上传的图标会内嵌进去；**自定义壁纸文件不包含在导出里**，
换实例后需要重新设置壁纸，找不到壁纸文件时页面会显示默认壁纸）。

---

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
| `DOCKER_SOCK` | `/var/run/docker.sock` | Docker socket 路径 |
| `PROBE_PRIVATE_ONLY` | 未设置 | 设为 `1` 时状态检测**只访问内网地址**（10/8、172.16/12、192.168/16、100.64/10、fc00::/7、回环；`.local` / `.lan` / `.home.arpa` 也必须解析到这些地址）。外网域名会显示为「未检测」。默认不限制，因为外网地址通常就是公网域名 |
| `PROBE_TLS_STRICT` | 未设置 | 设为 `1` 时校验 HTTPS 证书；默认不校验（家里的自签名证书也算在线） |

自定义壁纸固定存放在 `DATA_DIR/wallpapers/`（单张上限 15MB，支持 JPEG / PNG / WebP；页面会先把图片缩到长边 2560px 再上传）。
上传的图标存放在 `DATA_DIR/icons/<用户名>/`（单个上限 512KB，只收 PNG / JPEG / WebP，不收 SVG；没有透明通道的图标会存成 JPEG）。
旧版本把壁纸和上传的图标以 data URL 存在配置里，升级后启动或下次同步时会自动转存成文件并改写配置。

---

## 状态检测规则

- 每个项目优先检测**内网地址**，没有则检测外网地址；多个用户里相同的地址只检测一次。
- 发送 HTTP 请求，4 秒超时，默认**忽略证书错误**（自签名证书也算在线，`PROBE_TLS_STRICT=1` 可改为校验）；任何 `< 500` 的响应都算在线，并记录响应耗时。
- 返回 **401 / 403** 的服务显示为「在线 · 需登录」（琥珀色状态点），同样计入在线数。
- 安全边界：主机名会先解析，所有解析结果都要通过检查，且只连接检查过的地址。**永远不探测**链路本地地址
  （`169.254.0.0/16`、`fe80::/10`，包括云服务器元数据 `169.254.169.254`）、`metadata.google.internal` 等元数据主机名、
  `0.0.0.0`，以及 Nocturne 自己的端口；内嵌 IPv4 的 IPv6 地址（`::ffff:a.b.c.d`、`::a.b.c.d`、NAT64 `64:ff9b::/96`）按内嵌的 IPv4 检查。
  这些项目的状态是 `blocked`，页面上显示灰色状态点「未检测」，不计入在线 / 离线数。
- `xxx.local` 在容器里解析失败时，NAS 不返回这一项，页面改用浏览器自己检测（见上面「网络说明」，建议填 IP）。
- 全部服务都离线时，状态卡片只显示一句提示（多半是地址还没填，或当前网络到不了）；桌面版的离线芯片可以直接点开对应服务。
- `example.com` 等保留域名（默认示例数据）直接视为离线，不发请求。
- 页面每 30 秒从 NAS 拿一次结果；刚添加的项目在 NAS 检测到之前，会先用浏览器自己检测。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（容器 HEALTHCHECK 使用） |
| GET | `/api/me` | 当前登录状态 |
| POST | `/api/setup` · `/api/login` · `/api/logout` | 初始化 / 登录 / 退出 |
| GET / PUT | `/api/config` | 读取 / 保存当前用户配置（带 `version`、`updatedAt`，后写覆盖）。PUT 带 `baseVersion`；若期间另一台设备改过，返回 `overwrote: true`，被覆盖的版本进入环形备份（保留 10 份），`GET /api/config?prev=1` 取最新一份；内容和服务器相同时不算冲突、不升版本；带 `restore: true` 时先备份当前版本再覆盖。同一用户的写入串行执行。JSON 请求体上限 2MB（页面在配置超过 800KB 时提示） |
| GET / PUT(POST) / DELETE | `/api/wallpaper` | 当前用户的自定义壁纸。PUT/POST 请求体为原始图片（`Content-Type` 为 `image/jpeg`、`image/png` 或 `image/webp`，≤15MB）；GET 带 ETag，`?v=` 版本号可长期缓存 |
| POST / PUT / GET / DELETE | `/api/icons` · `/api/icons/<id>` | 上传的图标：POST（服务器生成 id）或 PUT 指定 id，请求体为原始 PNG / JPEG / WebP（≤512KB）；配置里记 `{type:"image", value:"api/icons/<id>"}` |
| GET | `/api/status` | `{项目ID: {up, status, code, ms, checkedAt}}`，`status` 为 `up` / `auth` / `down` / `blocked` |
| GET | `/api/docker` | 容器列表（未挂载 docker.sock 时 `available: false`） |
| GET | `/api/icon/<前缀>/<名称>.svg`、`/api/icon/search?query=…`、`/api/icon?q=…` | Iconify 代理（缓存在 `data/cache`） |
| POST | `/api/password` | 修改自己的密码 |
| GET / POST | `/api/users` | 管理员：列出 / 添加用户 |
| POST / DELETE | `/api/users/<名字>/password` · `/api/users/<名字>` | 管理员：重置密码 / 删除用户 |

---

## 本地开发

不需要 `npm install`：

```bash
DATA_DIR=./data node server.js
# 打开 http://localhost:8080
```

`public/index.html` 直接双击打开也能用（纯静态模式，配置只存在浏览器里，自定义壁纸和上传的图标仍以 data URL 存在本机），和旧版行为一致；
后端相关逻辑都在 `public/nocturne.js`，只有在由 `server.js` 提供页面时才会启用。

字体是子集化后的 woff2（界面里出现的所有汉字 + 约 3500 个常用字，生僻字回退到系统宋体）。
需要重新生成时见 `tools/subset-fonts.py` 顶部说明（开发工具，需要 `pip install fonttools brotli`，运行时不需要）。

## 许可

MIT
