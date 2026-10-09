# Nocturne 认证事务提交后边界补修验收报告

日期：2026-10-09。补修基线：`5e9462f59bc66273001bbccb335f22296921d392`。独立分支：`fix/p1-storage-protection`。冻结代码提交：`fe2423fd3d6a3a7350bacf8788a46d28e0a4fbed`。

## 修复范围与行为

已确认独立审查指出的问题：COMMITTED 建立后，`finish(r, true)` 核验 users.json 出现一次 EIO，外层 catch 将其转换成 cleanupPending，API 可以继续报告成功。补修保留现有事务格式和恢复协议，只收窄正常提交的终结检查及错误处理。

生产代码差异仅两处：`auth-store.js` 新增 11 行、删除 3 行；`server.js` 新增 1 行。新增两个专用测试文件，没有修改其他运行模块、前端、Dockerfile、package.json、生产工作流或数据格式。

1. 正常提交调用 `finish(r, true, false)`：复核实际记录及 COMMITTED；两个认证文件必须严格等于已提交的新字节。删除资产必须已在暂存位置，不能把异常旧/缺失状态当作启动恢复进行重做；后续再读不一致也拒绝自动补写。
2. 启动恢复继续使用原 `finish(r, committed)` 路径，允许按已有记录完成撤销/重做。本次不重构认证、账户锁、恢复器或数据迁移。
3. DONE 写入、退休目录移动和目录同步均须成功；核验/读写/移动/同步异常返回 `storage_unavailable`、HTTP 503，并带 `committed:true`，保留活动或退休材料。标记建立后不退回旧内存，但不发成功 Cookie。
4. 只有已经确认认证文件、记录/标记正确，且 DONE 与退休目录移动已持久化后，删除退休目录或同步该删除的单纯清理失败仍返回 cleanupPending，允许已持久提交的成功响应。
5. 在既有 `assertAuthStorage()` 中补一行事务故障锁存检查。单次 EIO 消失也不能在本进程自动恢复后继续认证；相关 API、登录及健康检查保持 503，材料保留，受控重启重新恢复和验证。

第 5 项是返回存储错误后维持阻断所必需的紧邻修复：只修改 auth-store 的版本在专项中仍有 2 项失败，后续登录错误返回 200。该中间失败日志保留，不是借此扩大认证系统改造。

## 独立回归、旧版反证及故障证据

新增 21 项回归测试，均使用合成临时 DATA_DIR。专用 preload 只有在 COMMITTED 的目录 fsync 成功后才启用，记录 armed/hits；没有生产故障开关。

| 覆盖 | 验证内容 |
| --- | --- |
| COMMITTED 后 EIO | users、sessions、COMMITTED 读取错误必须报告存储异常；不能变成 cleanupPending |
| 文件丢失 | users 文件丢失，以及首次提交旧 sessions 文件原本不存在时的新文件丢失，均禁止成功/自动补写 |
| 核验失败 | 旧字节替换、第一次核验后第二次读取才被替换、损坏文件、标记丢失/损坏、记录损坏均拒绝成功 |
| 退休前错误 | DONE 打开失败、退休目录 rename 失败、移动后根目录 fsync 失败，均返回存储错误并保留材料 |
| 真正清理失败 | 退休目录删除失败、删除同步失败仍为非致命清理状态；认证文件正确，退休记录可重启清理 |
| API 与 Cookie | EIO、丢失、损坏及退休同步异常：503、无 Set-Cookie、持续阻断、不清理记录；暂时性故障受控重启恢复后新密码有效、旧密码无效 |
| 正常清理降级 | 清理失败仍允许正确提交后的设备 Cookie、健康 200；重启清理退休材料 |

补修前完整 Git archive 与原对象一致。相同 21 项测试指向旧实现：**18 fail、3 pass、0 skipped**。3 项是原本应通过的清理正对照；COMMITTED 读取 EIO 用例在旧版因缺少该复核而未命中，作为缺失检查的反例，其余异常用例的注入实际命中。

直接复现 users.json 单次 EIO 的独立脚本输出：

```text
old   result={cleanupPending:true}, pending=true, armed=true, hits=1
fixed error={code:storage_unavailable,status:503,storage:true,committed:true}, pending=true, armed=true, hits=1
```

只改存储层的中间版本：20 项中 18 pass、2 fail，证明后续登录仍能解除阻断；补一行锁存检查及最终补齐第二次核验测试后，**21/21 通过，0 fail、0 skipped**。专用测试没有修改或削弱既有断言。

## 专项与完整测试

- 新增边界专项：**21/21 通过**。
- 新边界 + 既有 auth-reliability + auth + Cookie 前缀专项：**73/73 通过**，0 fail、0 skipped，耗时 99.047 秒，包含原 SIGKILL、回退失败、重启恢复及删除一致性用例。
- 冻结代码最终完整测试：**413/413 通过，0 fail、0 skipped、0 cancelled、0 todo；耗时 485.908 秒**。原 392 项保留，新增 21 项，合计 413。
- `npm run check`、两个新增测试文件的 Node 语法检查、`git diff --check` 通过。结束后复核冻结的全部 151 个跟踪文件字节未变；报告在测试之后作为文档提交。

环境仍为隔离 Node 22.23.3、jsdom 24.1.3、Python 3.9.6；沿用审计环境的静态测试服务队列 wrapper，不修改仓库或产品来适配本机。不存在跳过/降低标准来通过测试的处理。

## 兼容性与恢复边界

users/sessions、RECORD/DONE/COMMITTED、资产路径、配置与空间格式均不变；RC.1–RC.4 双向兼容、默认 Cookie 名称和前缀规则由完整测试复核。UI、静态资源和版本号仍保持原样。本补修只把“状态异常误报成功”改为阻断，不给旧 RC 增加新事务能力。

状态异常保留材料，不自动猜测或修写外部替换。瞬时读取故障或退休同步失败经受控重启可完成验证；损坏/冲突材料仍沿原恢复协议保守拒绝。单实例写入、真实断电/DSM 平台验收和生产 CI 尚未启用等原报告边界不变；本轮没有扩大这些授权范围。

## Git 状态与审查材料

代码提交 `fe2423f`，报告另作纯文档提交。最终 HEAD、工作树与受保护引用见状态文件。v2/origin-v2 本地引用仍为 af5104c；本轮没有修改、合并或推送 v2/main，没有发布标签、镜像构建/推送、GHCR、Actions 或 NAS 操作。

- [补修完整代码差异](../../audit-evidence/auth-boundary-code-diff.patch)：仅基线 5e9462f 到最终交付提交。
- [21 项专项日志](../../audit-evidence/auth-boundary-after-final.log)、[73 项账户回归日志](../../audit-evidence/auth-boundary-checkpoint.log)、[最终完整测试日志](../../audit-evidence/auth-boundary-full-final.log)。
- [旧实现失败反证](../../audit-evidence/auth-boundary-before-final.log)、[只改存储层仍失败的日志](../../audit-evidence/auth-boundary-after-store-only.log)、[直接复现日志](../../audit-evidence/auth-boundary-direct-proof.log)及同名 .cjs 脚本。
- [冻结复核及结果汇总](../../audit-evidence/auth-boundary-summary.json)、[Git 状态](../../audit-evidence/auth-boundary-git-state.txt)、[补修审查包](../../audit-evidence/auth-boundary-review-bundle.tar.gz)。证据留在本机，不随代码上传。

复现专项：`node --test test/auth-commit-boundary.test.js`。旧版反证设置 `NOCTURNE_AUTH_BOUNDARY_ROOT` 指向 `git archive 5e9462f` 的独立目录，预期非零；不要改写旧代码。完整复现沿用第一阶段环境：

```sh
cd /Users/million/nocturne/source
PATH=/Users/million/nocturne/audit-env:/Users/million/nocturne/audit-env/node_modules/node/bin:$PATH JSDOM_PATH=/Users/million/nocturne/audit-env/node_modules/jsdom CI=true npm test
```

完成补修后暂停，等待最终审核；本报告不授权合并、发布或部署。
