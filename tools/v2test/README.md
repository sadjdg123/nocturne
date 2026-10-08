# 夜曲 Nocturne · V2 RC 并行测试套件（`tools/v2test/`）

在群晖 NAS 上，**不影响正在使用的 V1.1**，起一个独立的 V2 RC 测试容器 `nocturne-v2test`（端口 8089），数据来自一份**校验过的备份恢复出来的副本**。

所有命令都在 NAS 的 SSH 里用 `sudo` 运行（DSM 7 的 `/bin/sh`；需要 Container Manager 提供的 `docker` 与 `docker compose` 或 `docker-compose`）。

| 文件 | 作用 |
|------|------|
| `deploy.sh` | 预检 → 拉取并核对固定镜像 → 热备份 → 校验 → 恢复到测试目录 → 只在副本里清会话 / 已知设备 → 启动 → 检查 → 报告 |
| `check-persist.sh` | 你在测试站登录并改一处配置后运行：只重启 `nocturne-v2test`，核对配置 sha256、版本号、`/api/health` |
| `teardown.sh` | 确认后只删除测试容器、它的网络和测试目录（`--keep-backups` 保留备份） |
| `lib.sh` | 三个脚本共用的函数（不单独运行） |

依赖同目录上一级的 `tools/backup.sh`、`tools/verify-backup.sh`、`tools/restore.sh`，请把整个 `tools/` 一起放到 NAS 上。

> 测试站的检查用脚本探测到的局域网 IP（`http://<LAN_IP>:8089/api/health`），不用 `127.0.0.1`。要手动看**生产**的健康状态：生产端口绑定在 `192.168.50.141:8088`，
> 用 `NAS_IP=${NAS_IP:-192.168.50.141}; curl -s "http://$NAS_IP:8088/api/health"`（以 `sudo docker port nocturne 8080/tcp` 的输出为准）；`127.0.0.1:8088` / `localhost:8088` 连不上。

## 1. 把套件放到 NAS

仓库是私有的，NAS 上不需要 git：

1. 在电脑上拿到 `v2test-kit.tar.gz`（Hark 发给你的文件），用 File Station 上传到 NAS，例如 `/volume1/docker/`。
2. SSH 到 NAS：

```sh
cd /volume1/docker
mkdir -p nocturne-v2test-kit && tar -xzf v2test-kit.tar.gz -C nocturne-v2test-kit
cd nocturne-v2test-kit
sha256sum -c SHA256SUMS          # 每一行都应是 OK
```

（能访问仓库的话也可以在电脑上 `git archive --format=tar.gz -o v2test-kit.tar.gz origin/v2 tools/` 再上传。）

## 2. 部署

```sh
sudo sh tools/v2test/deploy.sh --dry-run    # 只做预检，不做任何改动
sudo sh tools/v2test/deploy.sh              # 看完计划输入 y
```

常用选项（`--help` 看全部）：

- `--prod-container nocturne`、`--prod-data DIR`：生产容器名 / 数据目录。默认从 `docker inspect nocturne` 的 `/data` 挂载自动检测；手动指定的与检测结果不同就拒绝。
- `--test-root /volume1/docker/nocturne-v2test`：测试项目目录，测试数据固定在 `<目录>/data`。
- `--port 8089`、`--lan-ip 192.168.x.x`：端口与绑定的内网 IP（默认取默认路由网卡的 RFC1918 地址）。
- `--prod-opened-by ip|name`：你平时怎么打开生产站，只影响推荐的测试网址。
- `--from-backup FILE`：不做热备份，改用一份已有的备份（仍会完整校验）。

### 预检会拒绝的情况

- 测试数据路径与生产数据路径相同，或其中一个在另一个里面；测试目录是生产 compose 项目目录。
- 测试目录已存在但不是本套件创建的（没有 `.nocturne-v2test` 标记），或里面已有测试数据（先 `teardown.sh`）。
- 已有名为 `nocturne-v2test` 的容器（不是本套件的就不会动它）。
- 端口 8089 已被占用（`docker ps` 端口映射、`ss` 或 `netstat`）。
- 检测到的 IP 不是内网地址，或不在本机网卡上。
- 镜像拉取后 RepoDigest 不等于固定的 digest。

### 镜像是私有包时

拉取被拒绝（401 / denied）时脚本会停下并提示：在 GitHub 新建一个**只勾选 `read:packages`** 的 classic PAT，然后

```sh
sudo docker login ghcr.io -u <你的GitHub用户名>    # Password 处粘贴令牌，不会显示
sudo sh tools/v2test/deploy.sh
sudo docker logout ghcr.io                          # 部署完就注销
```

套件不读取、不保存任何令牌；不要把令牌写进命令行或贴给任何人。

### 热备份不一致时

默认**不停生产容器**做热备份（`backup.sh` 会逐个比对 sha256，变化就重试，最多 3 次）。如果一直不一致，脚本退出（退出码 4），不会自己去停生产容器。你可以换个没人用的时间再跑，或者**你自己决定**短暂停止生产容器做一次备份，再用这份备份继续：

```sh
sudo sh tools/backup.sh --stop nocturne -o /volume1/docker/nocturne-v2test/backups /volume1/docker/nocturne/data
sudo sh tools/v2test/deploy.sh --from-backup /volume1/docker/nocturne-v2test/backups/nocturne-backup-<时间>.tar.gz
```

## 3. 打开测试站（重要）

**cookie 不按端口区分。** 2.0.0-rc.2 起 cookie 名前缀可配置：`deploy.sh` 生成的测试 compose 里设置了 `NOCTURNE_COOKIE_PREFIX=nocturne_v2test_`，测试站的 cookie 叫 `nocturne_v2test_sid` / `nocturne_v2test_dev`，与生产的 `nocturne_sid` / `nocturne_dev` 互不覆盖。镜像是 2.0.0-rc.1 时这个变量不起作用：两个版本的 cookie 名一样，在同一个主机名下打开 8089 会覆盖你在 8088 的登录和「已知设备」。稳妥起见仍建议：

- 生产站用 IP 打开（`http://192.168.x.x:8088`）→ 测试站用 `http://<NAS主机名>.local:8089`；生产站用主机名 / 域名打开 → 测试站用 `http://<内网IP>:8089`。脚本会打印推荐网址。
- 并且在 **Safari 无痕窗口**里打开测试站（单独的 cookie）。
- `<主机名>.local` 需要 DSM「控制面板 → 文件服务 → 高级 → Bonjour」开启。

副本里的会话和已知设备已清空：用生产账户的密码重新登录即可。测试站里的修改不会回到生产。

## 4. 持久化检查

在测试站登录、改一处配置（例如给一个项目改名）并保存，然后：

```sh
sudo sh tools/v2test/check-persist.sh
```

还没改过配置时它会提示你先去改（退出码 2）。

## 5. 报告

`deploy.sh` 和 `check-persist.sh` 各写一份 `/volume1/docker/nocturne-v2test/v2test-report-<时间>.txt`（权限 600）。报告里没有密码、密码哈希、会话、令牌或配置内容（只有备份归档的 sha256 和镜像 digest），可以直接整段贴回。
生产 data 的 sha256 清单只留在 NAS 上的 `/volume1/docker/nocturne-v2test/.v2test/`，不进报告。

## 6. 删除

```sh
sudo sh tools/v2test/teardown.sh                 # 输入 yes 确认
sudo sh tools/v2test/teardown.sh --keep-backups  # 保留 backups/（含密码哈希与会话，请妥善保管）
```

只删带本套件标签的 `nocturne-v2test` 容器、`nocturne-v2test_default` 网络和带标记的测试目录；`--remove-image` 另外删除 RC 镜像。

## 保证

- 不停止、不重启、不修改生产容器 `nocturne`；部署前后核对它的状态、启动时间、重启次数。
- 不挂载、不修改生产 data；部署前后对生产 data 做 sha256 / 大小 / 修改时间清单对比。
- 不改生产 compose、反向代理、Cloudflare、路由器；不开隧道 / 代理；端口只绑内网 IP。
- 测试容器不挂 docker.sock，登录保持开启（没有 `NOCTURNE_NO_AUTH`），PUID/PGID 与生产相同。
- 镜像固定 `ghcr.io/sadjdg123/nocturne:sha-e4de70b@sha256:e37da36ff107dac5df6f6af17c624f06d3ec5a2478b40be6703f80fe75e8d47b`（2.0.0-rc.3；RC.2 为 `sha-3d5beaf@sha256:08ff9c086757ab68a8d2fbff2ba97bbd8a87f9fe8a6b6aaf162c7a1320e9444e`，RC.1 为 `sha-2ee0983@sha256:85ee7ab40781b3d6284e52a4152f852a8b2e6f27a96e91375f296f13d2d277fa`）。换镜像只改 `lib.sh` 的 `IMAGE_TAG` / `IMAGE_DIGEST` / `EXPECT_VERSION`。

## 开发者：沙盒自测

`test/v2test-kit/run.sh`：假的 `docker` / `ip` / `ss` / `hostname`（`test/v2test-kit/bin/`），「容器」是真实的 `node server.js`，「生产」数据由真实的 V1.1 基线 server.js 生成；dash 与 busybox sh 各跑一遍正向与反向用例。需要回环上的别名地址：`sudo ip addr add 192.168.77.10/32 dev lo`。
