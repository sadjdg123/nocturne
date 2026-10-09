# Nocturne V2.0 第一阶段可靠性修复最终验收报告

日期：2026-10-09。开发基线：`v2@af5104c285abd041e4118faae5d277c23917b113`。开发分支：`fix/p1-storage-protection`。冻结代码提交：`d29e3a190cfd91953c5f75da7abb3d73e625a0d8`。本报告是开发验收证据，交付后暂停，等待 ChatGPT 独立检查；不代表发布或部署放行。

## 1. 六个工作包完成情况

| 工作包 | 本地代码提交 | 实现与影响范围 | 状态 |
| --- | --- | --- | --- |
| P1-1 文件损坏保护 | `b092872`、补查 `d29e3a1` | 严格读取关键文件、孤立历史证据检测、故障锁存、禁止坏文件当空配置；合法 `.tmp` 后缀账户目录也算历史证据 | 已完成 |
| P1-2 账户与会话一致性 | `04fbc8e` | 原账户锁内候选副本；users/sessions 受限撤销/重做记录；持久提交后发布内存与 Cookie；删除资产暂存及恢复 | 已完成 |
| 恢复工具 | `083c189` | 验证/解压/二次校验先行；同父目录旧/新材料及身份记录；回退失败和强杀后保留可判定材料 | 已完成 |
| 备份工具 | `588474d`、补查 `c01d89e` | 同规则三次文件/目录清单与源 hash；保存空目录及事务材料；命令错误失败关闭；停写容器原状态保护；合法账户目录不按 `.tmp` 剪枝 | 已完成 |
| RC.4 缓存基线 | `b4a4103` | 五个发布版本清单；RC.4 固定提交和镜像；生成器原子替换与故障保护；跨 RC 的缓存正反例 | 已完成 |
| CI 防覆盖设计与模拟 | `d6689bd` | 精确 SHA 标签白名单、鉴权/未知结果阻断、完整 revision/双架构/digest 验证、并发与重跑模拟 | 授权范围内完成，生产机制未启用 |

各工作包独立提交；补查的两个问题分别追加独立 storage/backup 提交，没有混入 CI 或静态资源提交。P1-1 原验收报告保留为历史阶段记录，其中“其余工作包尚未实施”的描述不代表当前状态。

### 变更清单

- P1-1：`server.js`；`test/storage-protection.test.js`、`test/fsfail.js`、`test/helpers.js`；11 个既有测试文件的合法账户夹具调整；`docs/p1-1-storage-protection-report.md`、`docs/storage-directory-evidence.md`。11 个夹具文件为 appearance、config、dock、review2、spaces-badspaces-frontend、spaces-empty、spaces-exclude、spaces-frontend、spaces-manage、spaces-switcher、writejson-tmp；原业务断言保留。
- P1-2：`server.js`、新增 `auth-store.js`；Dockerfile 仅增加该运行模块的 COPY；package.json 仅补语法检查；`test/auth-reliability.test.js`、`test/fsfail.js`；`docs/auth-transactions.md`、升级手册的旧 RC 回滚边界。
- 恢复：`tools/restore.sh`、`tools/verify-backup.sh`、共用 `tools/archive-common.sh`；`test/restore-reliability.test.js`；`docs/restore-recovery.md`。
- 备份：`tools/backup.sh`；`test/backup-reliability.test.js`；`docs/stopped-backup.md`、`docs/v2.0-upgrade-rc.md`。
- 静态资源：`tools/gen-released-assets.js`；`test/fixtures/released-assets.json`、`test/cache-bust.test.js`、`test/asset-refs.js`、`test/released-assets-reliability.test.js`；`docs/released-assets-baseline.md`。
- CI：`tools/image-publish-policy.js`、`test/image-publish-policy.test.js`、`docs/image-publish-protection-design.md`。`.github/workflows/docker.yml` 字节与 af5104c 相同，没有接入辅助模块。

完整逐提交文件列表在 `phase1-commits-files.txt`；完整补丁在 `phase1-complete-code-diff.patch`。它们包含全部代码与测试，不能只用本报告摘要代替代码审查。

## 2. 环境与最终测试

本机隔离环境：Node 22.23.3、jsdom 24.1.3、Python 3.9.6、macOS sh 与 dash。jsdom 没有进入生产依赖。Python 静态测试服务使用 audit-env 的队列 128 wrapper，解决本机默认监听队列导致的 ECONNRESET；仓库和产品代码未为此修改。

最终完整测试：**392/392 通过，0 fail、0 skipped、0 cancelled、0 todo；耗时 483.180 秒**。运行期间代码及测试文件冻结，结束后对全部冻结跟踪文件复核 SHA-256；记录见 `phase1-frozen-files.json`、`phase1-freeze-verification.json`。完整日志保留所有子测试结果。

| 新增测试来源 | 数量 |
| --- | ---: |
| P1-1 storage-protection，含补查 2 项 | 59 |
| P1-2 auth-reliability | 35 |
| restore-reliability | 14 |
| backup-reliability，含补查 2 项 | 23 |
| released-assets-reliability | 14 |
| 既有 cache-bust 新增 RC.4 对比 | 1 |
| image-publish-policy 模拟 | 36 |
| 新增合计 | 182 |

原有 210 项保留，新增 182 项，最终应为 392 项；最终以日志实际计数为准。`npm run check`、新增工具 JS 语法检查、每个 shell 文件的 sh/dash 语法检查、`git diff --check` 均通过。未删除测试、降低断言或用 skip 掩盖失败。

进入下一包前的专项记录：P1-2 109/109（35 新增+既有认证/Cookie/存储保护）、恢复 17/17、备份最终 26/26、缓存 23/23、CI 模拟 36/36；全部零失败、零跳过。storage 补查及启动对照 19/19。备份规则补查后，恢复工具再次 17/17 通过。

两次较早的完整运行因补查发现 `.tmp` 目录边界而主动中止，日志分别保留为 `phase1-full-before-backup-followup.log`、`phase1-full-before-storage-followup.log`，不能用它们当作最终通过证明。另存的开发期专项失败及修正后结果保留在证据目录；最终日志独立记录，旧版失败反证没有用修复后结果替换。

## 3. 旧版反证与故障注入

| 工作包 | 修复前对照与结果 | 修复后证明 |
| --- | --- | --- |
| P1-1 | af5104c：57 项中 52 失败、5 正常/内部时序对照通过；新补查 c01d89e：`.tmp` 孤立目录 2/2 失败 | 损坏/读取错误/丢失/外部替换/写入中损坏均阻断，保留原字节；内部自写入误判也有独立反证及修复 |
| P1-2 | b092872 旧认证实现：新增 35/35 失败 | 七种账户操作逐一对两个文件的 rename 注入；open/半写/fsync、标记、资产移动、回退及清理失败；Cookie、滑动续期和过期清理均回归 |
| 恢复 | 原工具对照：14 项中 12 失败、2 正常对照通过 | tar、二次 hash、chmod、sync、旧/新移动、二次回退失败、TERM、SIGKILL、冲突、链接与重复恢复通过 |
| 备份 | 原工具：21 项中 14 失败、7 原有正常路径通过；备份补查：2/2 失败 | 新增/末次校验新增、删除/改名/替换、连续变动、find/hash/cp/tar/gzip/发布错误、链接、容器状态、名称冲突、空目录、事务备份恢复通过 |
| 静态资源 | 原清单覆盖断言 2/2 失败；旧 CLI 部分写入故障后原清单被截断 | 同样写入故障修复 CLI 保留原清单；网络/401/截断树/blob/写入/fsync/rename 注入通过；四个 RC 的同 URL 改内容和伪造 hash 均报警，更新 URL 后通过 |
| CI | 按旧工作流原文重放 push 条件的 14 项模拟反例全部失败 | 新策略 36/36；已有/不明确标签模拟写入次数 0，明确缺失且批准时 1；三次并发只写 1 次 |

旧服务器来自独立 git archive；不修改其实现，同一测试通过根目录环境变量切换。工具反证来自原始工具快照。CI 的反证是读取真实工作流条件后的本地模型重放，不是执行旧 Actions 或真实 GHCR 推送；报告明确保留这一证据边界。

注入器仅测试子进程预加载，shell 故障命令只作用于临时目录。容器状态全部是假 Docker 命令；CI HTTP 是内存 Response，逐次断言 GET/HEAD，发布器是内存模拟器；没有连接真实 Docker socket、NAS、GHCR 或生产数据。

## 4. 账户、会话和中断恢复结论

沿用原有账户锁，生成候选副本，不重构完整认证系统。`.auth-transaction` 在改动前保存原 users/sessions 字节、新字节及受限资产路径，权限目录 700/文件 600，内容有 SHA-256 校验；文件替换和 `COMMITTED` 提交点使用 fsync。删除配置、图标、壁纸、备份与旁路先暂存，固定升级快照保留。

- 提交前失败：原文件/资产回退、内存不发布新状态、不发成功 Cookie；失败创建不能随后登录落盘，失败改密旧密码仍有效，失败删除保留账号及资产。
- 回退失败：503、健康检查故障、保留唯一恢复材料并阻断；清除注入后重启完成撤销。不是把不可判定的磁盘状态继续用于认证。
- 标记已出现但耐久性步骤/返回失败：不回到旧内存，不发 Cookie，阻断；重启按标记完成新状态。测试验证旧/新密码不会因不同错误路径混用。
- SIGKILL：首认证文件替换后、标记前、标记后、提交后清理前，均实际 SIGKILL；重启选择唯一旧/新状态。删除资产移动后强杀可恢复资产及旧会话。
- 已提交后的清理失败：不撤销账号删除或改密，保留退休材料，后续启动继续清理；记录损坏、路径伪造或目标冲突则停止启动并保留材料。
- 登录/设备登记/Cookie：响应前会话已在磁盘；成功删除后的旧会话不复活，同名重建不继承旧设备或资产。滑动续期与过期清理共用持久协调器，故障不提前延长会话或覆盖原文件。

恢复工具先完整验证/解压后切换。新目录放置失败回退旧目录；回退再次失败时旧目录、新材料和 restore-state 全部保留。强杀后再次执行：已放入的新目录完成恢复并退出 0；已撤销到旧目录退出 4，表示仍需再次执行恢复。冲突或身份无法确认时非零拒绝，不猜测、不删除材料。此记录绑定同父目录 inode；账户侧车使用内容指纹，两者不能混淆。

## 5. 停写完整备份和跨版本兼容

真实测试链路一：服务创建账户、配置、空间、图标、壁纸和备份环 → 停止测试服务 → 完整备份 → 归档及侧车验证 → 隔离恢复 → 修复版启动，账户登录、配置/空间/素材/环形备份一致。真实测试链路二：改密时实际强杀，主认证文件半提交 → 完整保存恢复记录及空目录 → 隔离恢复 → 修复版撤销未提交改密，旧密码可登录、显式 `spaces:[]` 保留。另有中断删除材料整体复制后恢复的字节对照。

热备份统一三次枚举和源 hash 核查，但仍不能证明跨文件属于同一应用事务时刻；正式升级与灾备推荐停唯一写入实例的完整备份。初始停止的实例保持停止；原运行实例只有工具确实停止后才重启；stop 失败不备份，start 失败非零退出并明确保留已验证归档。操作流程见 [stopped-backup.md](stopped-backup.md)。

| 数据/行为 | 兼容结论与证明边界 |
| --- | --- |
| 账户与会话 | 正常主数据格式不变；逐个真实 RC.1–RC.4 历史 server 创建数据→修复版读取/写入→对应旧版读取通过。未知账户字段保留 |
| 配置与空间 | 格式、未知配置字段、canonical hash、spacesVersion、空空间/缺失空间区别、既有旧 URL、旁路/20 版本历史语义不变；原空间与回滚测试保留 |
| Cookie | 默认 `nocturne_sid` / `nocturne_dev` 不变；现有前缀/域/path 规则及隔离测试保留；改变的是发放时机，持久提交后才发 |
| UI 与静态资源 | `public/` 相对 af5104c 零差异；既有 UI 未修改；RC.4 的 24 个缓存 URL 加入基线，V1.1 与 RC.1–RC.3 条目保持原样 |
| 归档 | format=1、SHA256SUMS 和 BACKUP-INFO 保持兼容；新增保护拒绝链接/特殊文件/危险路径。空目录和中断事务材料完整保存 |
| 中断后切回旧 RC | 有未完成 `.auth-transaction` 时必须先由修复版完成恢复，再正常停机回滚；RC.1–RC.4 不理解事务侧车，不能直接接管半提交目录 |

正常数据格式兼容不等于旧版也获得新可靠性保护。本轮不改变版本号，仍为 `2.0.0-rc.4`；代码分支是未发布候选，不能把它称作 RC.5 或正式版。

## 6. 未解决问题及风险等级

| 等级 | 剩余问题/边界 | 处理要求 |
| --- | --- | --- |
| P1 发布前门禁 | 生产 CI 防覆盖仍未启用，现有 v2/main 工作流仍有自动推送和标签重跑风险 | 本轮不推这些分支；ChatGPT 审查后另行批准发布入口、权限、共享 concurrency 和真实测试仓库验证 |
| P1 平台验收门禁 | 未验证 DSM/BusyBox/Linux 实机文件系统、真实磁盘满或断电 | 故障注入/真实 SIGKILL 不冒充断电证明；上线前须在另行授权的隔离平台验收，不能操作生产数据 |
| P2 | 同步账户持久提交、删除资产内容指纹、严格读取增加 I/O/事件循环延迟，大素材目录尚无 NAS 性能数据 | 用隔离大目录进行性能/容量验收，保持最小协调器，不直接扩大认证重构 |
| P2 | 仍要求唯一写入实例；最后复核与替换间不构成跨进程 compare-and-swap | 部署保持单写入者；外部编辑须停写，不能承诺抵御并行外部进程任意修改 |
| P2 | 热备份仅变化检测；两次恢复 rename 之间目标可能暂时不存在；restore-state 不支持移位/复制续跑 | 使用停写完整备份；恢复完成前不启动实例；保留材料，遇冲突人工核验 |
| P2 | 模拟 CI 锁只在进程内；Registry 标签“检查后写”无法约束其他凭据/客户端 | 正式接入共享发布锁、收敛所有写入口，不能宣称 GHCR 服务端全局不可变 |
| P3 | 所有认证与历史证据一起消失时不能区别全新目录；最低结构校验不能识别所有结构合法的内容篡改 | 保留外部完整备份，不自动猜测/重建；本轮不增加安装身份字段或数据格式 |

没有已知必须靠降低测试标准才能通过的阻断问题。上述发布及平台门禁仍存在，最终开发测试通过不授权合并、发布或升级。

## 7. Git 状态和交付证据

实现提交全部本地完成。`v2` 和 `origin/v2` 的本地引用仍为 af5104c；本地没有 main 分支引用。本轮没有刷新或写入远端 main，不能据本地状态宣称已实时核验远端 main HEAD。没有 push、合并、发布 tag、Docker 构建/推送、Actions 触发、GHCR 写入或 NAS 操作。Git 工作树最终状态见 `phase1-git-state.txt`；报告另以纯文档提交交付。

主要审查材料均在本机 `/Users/million/nocturne/audit-evidence/`：

- [完整代码差异](../../audit-evidence/phase1-complete-code-diff.patch)：af5104c 到最终交付 HEAD，全量二进制兼容补丁。
- [完整测试日志](../../audit-evidence/phase1-full-final.log)、[语法检查](../../audit-evidence/phase1-syntax-final.log)、[测试与反证汇总](../../audit-evidence/phase1-test-summary.json)。
- [逐提交文件清单](../../audit-evidence/phase1-commits-files.txt)、[Git 状态](../../audit-evidence/phase1-git-state.txt)、[冻结文件复核](../../audit-evidence/phase1-freeze-verification.json)。
- 各包专项/旧版失败日志：p1-1-baseline-proof、p1-2-before/checkpoint、restore-before/checkpoint-final、backup-before/names-before/checkpoint、storage-names-before/after、assets-baseline-coverage/write-proof/checkpoint/remote-check、ci-policy-legacy-proof/checkpoint。
- [审查包](../../audit-evidence/phase1-review-bundle.tar.gz) 和 [证据 SHA-256 清单](../../audit-evidence/phase1-evidence-sha256.json)：汇集报告、完整补丁、关键日志、反证脚本及提交状态；不包含生产数据或凭据。

本机完整复现：

```sh
cd /Users/million/nocturne/source
PATH=/Users/million/nocturne/audit-env:/Users/million/nocturne/audit-env/node_modules/node/bin:$PATH JSDOM_PATH=/Users/million/nocturne/audit-env/node_modules/jsdom CI=true npm test
PATH=/Users/million/nocturne/audit-env/node_modules/node/bin:$PATH npm run check
PATH=/Users/million/nocturne/audit-env/node_modules/node/bin:$PATH node tools/gen-released-assets.js --check
git diff --check af5104c..HEAD
```

独立环境建议 Node 22、测试依赖 jsdom 24、完整 Git 历史、sh/tar/gzip/hash/sync/dash；macOS 静态服务队列问题需按本报告环境记录处理。旧版反证命令预期非零：设置 NOCTURNE_STORAGE_TEST_ROOT、NOCTURNE_AUTH_TEST_ROOT、NOCTURNE_TOOL_TEST_ROOT 或 NOCTURNE_BACKUP_TEST_ROOT 指向报告记录的 archive 目录；不要把反证失败当作最终回归失败。CI_POLICY_LEGACY=1 只用于模拟旧工作流条件，绝不连接真实发布。

交付后暂停，等待 ChatGPT 独立检查。后续顺序是处理独立审查意见、授权后的隔离平台与性能验收、另行批准的 CI 机制接入及发布准备；本报告不启动其中任何一步。
