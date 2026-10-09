# 隔离 Linux/Docker 验证复现

本流程用于认证/存储/备份恢复、Docker 或平台改动的按需深度验证，不是每次普通修复的发布前置条件。日常流程见 `HANDOFF-CODEX.md` 第 0.4 节。

第二阶段测试源码提交、环境、结果与证据索引见 `phase2-engineering-report.md`。以下仅用于开发隔离环境，不是 NAS 部署命令。

## 前提

完整 Git 历史、Node 22、支持 buildx 的隔离 Docker daemon、足够磁盘和内存。Docker 配置必须独立且没有 auths、credsStore 或 credHelpers；不要挂载生产数据、用户目录、Docker socket 或转发 SSH 凭据。构建可读取公开 Node/registry 基础镜像，容器回归为 network none，容器启动和注册表验证使用内部网络。

测试容器仅获 NET_ADMIN 以添加容器内回环别名 `192.168.77.10/32` 与 `192.168.77.11/32`。后者是合成 nas.local 的固定解析，只连接容器自身，不访问外部 DNS 或 NAS。root 只设置别名与 docker cp 副本属主，然后降为 node（UID 1000）执行回归；chmod 故障测试不能以 root 跳过。测试代码复制至 `/work` 并由测试用户拥有，没有改变宿主 Git 安全设置。生产镜像本身以 PUID 1026、PGID 100 运行。恢复辅助容器的数据卷为只读源及新空目标卷。

## 执行

将 DOCKER_HOST 指向独立虚拟机/开发 daemon，DOCKER_CONFIG 指向无凭据目录，再运行：

```sh
node tools/engineering/check-ci.js --docker
sh tools/engineering/verify-local.sh arm64 /tmp/nocturne-evidence-arm64
sh tools/engineering/verify-local.sh amd64 /tmp/nocturne-evidence-amd64
```

脚本仅本地 `--load` 镜像，没有登录、push、registry exporter。镜像命名带完整源码 SHA。工具缺失、非零退出、任何 skipped/cancelled/todo 或失败都使验收非零；不会接受 v2test 套件自己的 SKIP。Git 和配置校验先于构建。

输出含 Docker 构建日志/元数据、实际启动与 12 项故障重启结果、BusyBox 备份恢复、隔离 registry 的 9 项 HTTP 场景、完整 TAP/汇总、102 项 dash/BusyBox 套件、Node 文件 API 与延迟基准。只清理脚本创建的容器/卷/网络，不 prune 其他对象；本地构建镜像保留。

SIGKILL 注入在指定文件操作边界等待测试标记，宿主对测试容器执行真实 Docker KILL，并断言退出 137。这个测试握手仅预加载在测试容器：Linux PID 1 对自身 signal 的行为不能当作成功杀死证据。正常生产进程不加载注入器。

性能基准使用合成账户/会话及 8 MiB 资产，旧 RC.4 与当前 HTTP 登录实际执行 scrypt；核心事务另对比退休清理补修前实现。Node API 计数不代表物理 IOPS，虚拟机 p95 不能作为 NAS 延迟 SLA。

## 远程 CI

`engineering-verify.yml` 是 JSON 格式的 YAML；根级和每个 job 权限为 `contents: read`、`packages: none`，只允许隔离分支 push，没有 PR、标签或 dispatch 入口，checkout 不保留凭据。Docker 配置由可用的 github/matrix job context 构造，原生 runner 分别为 `ubuntu-24.04` 与 `ubuntu-24.04-arm`。

上传工作流需本机 Git 凭据具备 workflow 更新权限，这与 CI 运行令牌的镜像权限不同。首次权限不足的推送被拒，原记录保留；用户补齐权限后，仅推独立分支的 `d30eca2f32d92e997d65f887612678ac8b275220`，工程 CI [37913738091](https://github.com/sadjdg123/nocturne/actions/runs/37913738091) 已成功。原生双架构各 510/510、零失败/零跳过，启动 12/12、工具 102/102、registry 9/9；preflight 26/26。三份 job 实际权限均只有 Contents/Metadata read；原发布 workflow 未触发，main/v2 未变。原始 artifacts 的 SHA-256 已与 GitHub 元数据核对，并保存本地证据副本。

以后需要远程深度验证时，只推上述隔离分支（不要为工程验证推 main/v2），检查目标 SHA、只读 job 权限和验证结果。工程门禁校验本工作流的权限和隔离边界，不再要求生产工作流与第二阶段基点逐字节相同。工程 workflow 对文档 push 也会运行；本次补齐实际结果的最终文档提交保留本地，详见报告的分支状态。固定 action 出现 Node 20 目标被平台强制改用 Node 24 的提醒，本次步骤全过；后续升级固定 SHA 时独立回归。

actions 的权限定义与平台依据：[GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)、[GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。构建平台与本地导出依据：[Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/)。
