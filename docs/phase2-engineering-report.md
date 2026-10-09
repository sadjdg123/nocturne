# Nocturne V2.0 第二阶段发布前工程验证验收报告

日期：2026-10-09。独立开发分支：`verify/phase2-engineering`。第一阶段最终基线：`a7a9ca0104084f78458949f9919af000d3b1abfa`；本轮验证源码冻结：`018a696a8b1f6893b714f0d462af22ba0cf0fbc3`。

**验收结论：本地隔离构建、启动与可靠性验证通过；远程 CI 尚未完成，不能据本报告批准发布。** GitHub 拒绝新增工作流的 push，原因是本机 PAT 缺少 workflow scope；没有创建远端开发分支，没有触发发布工作流或 GHCR 推送。最终逐项结果与性能数据在以下各节记录。

## 1. 范围与隔离

所有数据为临时合成夹具。创建独立 Colima `nocturne-phase2`：ARM64 Ubuntu 24.04.4、Linux 6.8.0-117、4 CPU/6 GiB、Docker 29.5.2，宿主 Docker CLI 29.7.1/buildx 0.36。无宿主目录挂载、SSH agent 转发或生产 Docker socket；Docker 配置独立且没有注册表凭据。Node 22.23.3，测试 jsdom 24.1.3，Alpine BusyBox 1.37.0。

ARM64 原生执行；AMD64 使用 VM 的 QEMU 执行真正的 Linux x64 Node 进程，不是仅生成清单。完整回归使用普通 node 用户 UID 1000，生产镜像启动验证使用 PUID 1026/PGID 100。测试网络为 none 或内部 Docker 网络，无宿主发布端口；合成 nas.local 仅解析至容器回环别名。普通用户权限故障用例不能用 root 跳过。

`main` / `v2`、生产工作流、产品 `server.js` / `auth-store.js` / `public/` / Dockerfile / package.json 均未改。版本字符串保留 `2.0.0-rc.4`，本地镜像不代表 RC.5 或新发布版本。

## 2. 构建、实际启动与 Linux 可靠性

双架构本地 OCI 导出及运行镜像绑定完整冻结源码 SHA，没有 --push 或 registry exporter。索引、子清单、config 和 layer 描述符逐一复核大小与 SHA-256，两个运行平台的 revision 相同；unknown/unknown attestation 不算运行平台。最终构建摘要见 `final-multi-build.json` 与 `final-oci-validation.json`，不能用本地摘要代替 GHCR 发布 digest。

每个架构实际启动验证 12 项：

1. 实际 Linux Node 架构、PID 1 非 root 与健康启动。
2. 首次初始化、默认 Cookie、账户创建与删除。
3. 配置与空间保存及重启保留。
4. COMMITTED 前真实 Docker SIGKILL（退出 137），旧状态唯一有效。
5. 已停止源实例的只读卷经生产镜像 BusyBox 完整备份、校验、恢复；含中断认证事务的副本启动后正确撤销，密码与空间正确。
6. COMMITTED 后真实 SIGKILL，重启新密码唯一有效。
7. 退休 RECORD 部分删除后 EIO、实际容器重启与重复清理。
8. COMMITTED 后 users 读取 EIO 返回 503、无 Cookie、故障锁存；清除注入仍不得继续登录，重启后恢复唯一状态与配置。
9. Docker HEALTHCHECK 自身达到 healthy。

12 项名称与独立断言在各架构 `smoke.json`；上面合并相近项目便于阅读，不减少实际检查。故障注入只作为测试 preload；PID 1 的自杀信号不能作为退出证据，测试在指定边界写入耐久握手后由宿主对测试容器真实 KILL。没有修改生产认证事务实现。

DSM 兼容结论限定于实际测试的平台：Alpine BusyBox 的完整备份/恢复、普通用户权限、Linux fsync/rename 及中断重启已验证；DSM 特定宿主 shell、tar、权限模型、磁盘满与真实断电尚未验证。

## 3. 定点修复及旧实现反证

| 问题 | 最小改动 | 修复前证据 | 修复后验证 |
| --- | --- | --- | --- |
| BusyBox `ls -di` 前导空白导致 inode 为空、恢复在切换前失败 | restore.sh 先去前导空白、提取 inode，再执行原数字校验；失败保护不变 | 3 个专项中前导空格/制表符 2 个失败；BusyBox sh-x 原始日志定位空 inode | 恢复专项 17/17，实际两个架构的 BusyBox 归档/恢复通过 |
| GHCR config blob 307 导致读取器将合法镜像阻断 | 只对 blob 允许最多 2 次受限 HTTPS CDN 跳转；剥离 Authorization，保留最终 digest/size 校验；清单/标签不跳转 | 原读取器实际 GHCR 读取失败；两条合法跳转回归旧版 2/2 失败 | policy 48/48；只读实查 RC.4 双架构及完整 revision，CDN 请求无 Bearer |
| 备份提示行附加计数，使 deploy.sh 取得的路径不存在 | 恢复 `备份完成：<归档>` 独立行契约，计数另行输出 | 新回归旧版 1/1 失败（包含空格的目录） | 备份专项 24/24，部署工具实际端到端通过 |

注入还覆盖清单命令、文件新增/改名/删除、哈希、归档、发布、恢复目录移动/回退/强杀、认证标记前后及部分退休清理等第一阶段回归；完整 Linux 运行重新验证这些用例。没有仅用模拟结果代替 actual container startup。

工程环境问题及处理也保留失败证据：早期 ARM64 root 运行有 504 pass/1 fail/4 skipped，随后改为普通用户，并用容器自身回环解析消除合成 DNS 等待；对应 18/18 专项通过。macOS 首次运行遗漏既有 audit-env Python 队列 wrapper，静态服务器用例失败；修正 PATH 后完整 510/510。旧脚本无同步后台写入的套件曾 99/100，改为每次真实 cp 后确定性原子替换，新增每个 shell 的三次注入命中断言；仍严格要求退出 4、无测试容器和生产容器保护。没有删测试、放宽断言或接受跳过。

## 4. 自动化结果与源码证明

最终矩阵：macOS 510/510（505.482 秒），原生 ARM64 510/510（417.152 秒），QEMU AMD64 510/510（915.407 秒）；全部 0 fail、0 skipped、0 cancelled、0 todo。各架构 actual container smoke 12/12，隔离 registry 集成 9/9；dash 与 BusyBox 工具套件最终各 51/51。完整 Node 测试从第一阶段 468 项增至 **510 项**：恢复 3、读取策略 12、备份契约 1、工程 CI/TAP 门禁 26，共新增 **42 项**。端到端工具另从两个 shell 各 50 项增加为各 51 项，合计 **102 项**，不混入 npm test 数量。

macOS 的完整 510 项已全过，零失败/零跳过。Linux 完整测试包括权限故障、历史 blob 运行的兼容回归、故障注入和实际服务/DOM 交互。`CI=true`、完整历史与 jsdom 必须存在，缺失或 skipped/cancelled/todo 都使门禁失败。

源码冻结清单记录 144 个非文档跟踪文件。AMD64 runner 开始于 9f5f16b；其 npm 测试运行过程中只补入最终 run.sh 确定性夹具，产品及全部 npm 用例字节未变；完整 144 文件已与 018a696 逐一 SHA-256 相符，Git HEAD 的这一来源差异单独保留，不隐瞒为单一 checkout。最终 ARM64 整条流水线从 018a696 重新复制执行。macOS npm 用例覆盖文件同样没有后续变更。后续提交仅文档。

## 5. GHCR 防覆盖与 CI 权限

只读 GHCR 实测使用匿名 `repository:sadjdg123/nocturne:pull`，仅 GET/HEAD。RC.4 仍为 `sha256:2c4bf740a106ce78dda34815da9558234e27d0301e397e9dd5c4711e0886b57f`，revision 为 `f51662961ba7a86782cb863104917d75fb587553`，双架构齐全；日志不含 Bearer 或签名 URL 查询参数。

真实临时 registry:3 的内部 HTTP 集成 **9/9**：缺失判定、真实索引/config 校验、重跑跳过、短 SHA 冲突、三次并发一次写入、成功响应丢失、已有标签缺失架构、两次检查之间竞争，以及不遵循共享锁的外部 PUT 确实可覆盖标签。只有合成索引写入本地注册表，无 GHCR 写入。

这明确证明防覆盖不是注册表原子 CAS：二次检查和进程内锁不能阻止其他客户端插入写入。正式切换须另行批准，共享仓库+标签发布锁使用 cancel-in-progress:false、所有写入入口遵循它、收敛所有 packages 写权限；普通 push 不应自动赋予发布批准。现有生产 docker.yml 逐字节未改，也尚未获得上述保护；绝不能直接把开发分支推入 v2 来“启用测试”。

新增工程 workflow 只允许独立分支 push，根级和每个 job 都是 contents:read/packages:none；无 PR/tag/dispatch、登录/推送 action、secret 发布凭据或持久 checkout 凭据。固定 action SHA，原生 GitHub runner 矩阵为 ubuntu-24.04 / ubuntu-24.04-arm，独立无认证 Docker 配置，本地 --load，内部注册表和 network none 回归。26 项门禁及官方 actionlint 1.7.12 表达式/语法检查通过；actionlint 曾发现 job env 不允许 runner.temp，已改用可用 github.run_id/matrix context。

远程 push 已被 GitHub 拒绝，报错为 PAT 缺少 workflow scope；查询没有本开发分支的 run。本机上传权限与 CI 令牌权限不同，即使以后补 workflow scope，工程 workflow 仍没有镜像推送权限。**当前不能交付实际 GitHub job 权限日志或原生 AMD64 CI 结果**，这是未完成项，不能用静态校验冒充运行证据。

## 6. 认证磁盘 I/O 性能

以下为最后一条 ARM64 流水线完成回归后的原生测量，此时 AMD64/宿主 macOS 回归均已结束。其他仅两个 sleep 测试容器，统计 CPU 为 0；未用并行负载下的 QEMU 结果作性能结论。方法：小夹具 1 账户/1 会话、典型夹具 20 账户/200 会话各预热 5 次后测 30 次；删除场景 64 文件/8 MiB 测 5 次。核心事务对比退休凭据补修前实现与当前实现；HTTP 对比 RC.4 和当前修复版，各 30 次已知设备实际 scrypt 登录。

| 场景 | 旧实现 p50 / p95（ms） | 当前 p50 / p95（ms） | I/O 变化 |
| --- | --- | --- | --- |
| 实际 HTTP 已知设备登录，RC.4 → 当前 | 20.88 / 28.27 | 25.63 / 30.71 | 30 次登录累计 fsync 从响应时 30/延迟后 31 次增至 540 次；当前响应后计数不再增加 |
| 核心小事务，退休凭据补修前 → 当前 | 2.17 / 2.41 | 2.62 / 3.41 | 每次 fsync 15→18，Node 读取 18→28 次 |
| 核心 20 账户/200 会话 | 3.55 / 3.78 | 4.45 / 4.72 | 每次 fsync 15→18；读取字节约 189→332 KiB |
| 删除 64 文件/8 MiB 资产 | 21.86 / 22.77 | 35.01 / 37.69 | 每次 fsync 17→20；读取字节约 24.18→48.33 MiB，含反复完整性校验 |

此虚拟机实际登录中位延迟增加约 4.76 ms（23%），p95 增加约 2.44 ms；小样本不能作为容量或 SLA 结论。新增 I/O 是明确成本，不是“无性能影响”：尤其认证文件随会话增大、资产删除的重复哈希及普通 HDD 的同步刷盘，需要隔离 DSM 实测。删除场景只有 5 次，p95 等于最大值，没有统计稳定性承诺。本轮没有为降低成本放弃严格校验或重构认证。

文件 API 计数不代表物理 IOPS。RC.4 登录会话允许 2 秒防抖，在响应后才可能落盘；修复版响应包含持久提交成本，不能把旧版较快响应等价为同样耐久性的性能。虚拟机和 QEMU 数值不作为 NAS SLA；同步 fsync、完整 users/sessions 记录及删除资产指纹仍会占用 Node 事件循环。并行回归期间的测量仅留原始日志，最终判断使用回归结束后的空闲原生 ARM64 顺序基准。

## 7. 提交与文件清单

| 提交 | 变更 |
| --- | --- |
| cbd7af1 | restore.sh 前导空白 inode 兼容及 3 项回归 |
| 7293f67 | image-publish-policy.js 受限 blob 跳转、12 项边界回归及设计更新 |
| f4d36c2 | backup.sh 成功行契约及 1 项回归 |
| 3a9f927 | 测试专用 workflow、工程验证/注册表/性能工具、25 项初始门禁 |
| 6ea5f9d | 可用 job context 与新增门禁，最终门禁 26 项 |
| 9f5f16b | 普通用户完整回归、隔离合成 DNS/回环 |
| 018a696 | 确定性热备份变化注入、每 shell 额外命中断言、失败现场保留 |

后续独立文档提交更新 HANDOFF-CODEX、人工验收、RC/V1 回滚入口、备份/恢复说明、防覆盖设计，新增 engineering-verification、engineering-rollback 与本报告。完整逐提交文件表、代码补丁、冻结源码及最终工作树状态在证据包，不以摘要替代独立代码审查。

账户、主配置、空间及默认 Cookie 结构与 RC.1–RC.4 保持兼容；本轮没有产品/UI 改动。旧 RC 不理解新的活动事务恢复记录，回滚前须先由修复版完成恢复并正常停机。完整停写备份保存退休目录及外部清理凭据；未知来源、内容冲突、符号链接和目录身份冲突仍严格阻断。

## 8. 剩余事项与风险

| 等级 | 事项 | 发布前处理 |
| --- | --- | --- |
| P1 阻断 | 远程测试 workflow 未上传、未实际运行 | 用户在本机补 workflow 权限后只推独立分支，核验远端 SHA、原生双架构 job、权限和零跳过日志 |
| P1 阻断 | 现有生产 workflow 自动发布，防覆盖 helper 尚未接入 | 单独批准发布流程切换、共享锁及写权限收敛，先独立测试注册表验证，不直接推 v2 |
| P2 | DSM 宿主工具/文件系统/真实断电未经实测 | 用户另行批准后只在隔离 DSM 数据副本验收；SIGKILL 不等于断电 |
| P2 | 同步认证事务和资产哈希阻塞事件循环，NAS 磁盘可能更慢 | 使用本轮基准评估，再由用户批准隔离 NAS 性能测量；没有据此重构认证或改变数据格式 |
| P2 | 多进程写同一 DATA_DIR 不受支持；无凭据的旧版部分退休材料无法确认来源 | 保持单实例；保留现场并独立核查，不靠目录名称自动删除 |

本轮不发布 V2.0 正式版、不创建发布标签、不推镜像、不合并或推送 main/v2，不操作 NAS。交付后停止，等待用户检查及后续发布审批；未完成远程 CI 不应被批准记录掩盖。

## 9. 证据入口

证据目录：`/Users/million/nocturne/audit-evidence/phase2/`。最终索引、摘要与 SHA-256 清单在 README.md、final-results.json 和 SHA256SUMS；测试原始日志、故障反证、完整差异、源码、OCI 归档均保留。早期失败日志和实验性短 revision 归档不会作为最终通过/发布证明。

主要入口（路径相对证据目录）：各架构 build.log/build.json、smoke.json、full.log/full-summary.json、v2kit.log、registry-integration.json；macos-final-510.log；final-oci-validation.json；ghcr-readonly-cli-final.json；benchmark-idle/auth-io-benchmark.json；phase2-complete-diff.patch；phase2-commits-files.txt；frozen-code.json/freeze-check.json；git-state.json/protected-refs-final.txt；远程推送拒绝证据和 remote-runs.json。
