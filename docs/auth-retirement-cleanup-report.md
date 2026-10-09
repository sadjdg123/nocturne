# Nocturne 认证退休目录清理补修验收报告

2026-10-09。范围限定为退休目录部分删除及异常中断恢复。基线 `db3e51f7cdcd1d149dc9d21a9cfd8fbfffd6a440`，独立分支 `fix/p1-storage-protection`。实现提交：`9f904cbab2461260321c7ceffdbb4e2477b2dce0`。

本轮未改用户数据格式、UI、版本号、发布工作流及其他生产模块。未推送任何分支，未修改 v2/main，未创建发布标签、构建或推送镜像，未访问 NAS、容器或生产数据。

## 修复与代码差异

原实现只依赖退休目录内部的 RECORD/DONE/COMMITTED。递归删除一旦先删掉这些文件再 EIO 或 SIGKILL，下次启动无法再验证来源。

现在的顺序为：

1. 原有认证文件核验、DONE 写入、退休目录 rename/fsync 完成。
2. 严格核验退休 RECORD、DONE、COMMITTED 和现存资产，在 data 根目录原子持久化 `.auth-cleanup.<同一 UUID>.json`，记录退休名称、目录结构和逐文件 SHA-256。凭据权限 600，不依赖 inode。
3. 每次清理前，验证凭据完整性、相对路径和剩余目录。只允许原清单的子集，拒绝内容替换、额外文件、符号链接、特殊文件或被替换为普通文件的退休目录。核验失败发生在递归删除之前，按存储错误阻断。
4. 递归删除失败可以返回 cleanupPending；凭据仍在目录外，不会随部分删除丢失。退休目录删除并 fsync 根目录后才删除凭据。目录已经消失而凭据仍在时，也可重试。
5. 完整旧退休材料可先核验并生成凭据；已知原子元数据临时文件只接受标准名称及对应内容的字节前缀，以容忍写入时强杀。退休清理不重新应用旧认证状态。

`auth-store.js` 的活动事务 `record()` 校验函数逐字未变，SHA-256 为 `2016a624322cb101bf04d10cd69076b04e35b260a3d888fcaa6758973aa1f950`。新增的子集校验仅适用于已经持久退休且有清理凭据的目录；活动事务没有获得此宽松条件。

变更文件：

| 文件 | 变更 |
| --- | --- |
| auth-store.js | 清理凭据、严格来源核验、可重复的退休清理 |
| test/auth-retirement-fault.js | 仅测试使用的 EIO、真实 SIGKILL、凭据失败注入 |
| test/auth-retirement.test.js | 55 项专项测试，支持切换旧代码路径作反证 |
| docs/auth-transactions.md | 清理协议、备份保留要求和旧材料边界说明 |

测试预加载器未由生产代码引用，也未进入 Dockerfile 的复制清单。

## 旧实现反证与故障注入

对补修前完整源码快照，使用本轮同一预加载器和同一组核心测试：24 项中 **16 失败、8 通过，0 跳过**。失败包括删除 RECORD、DONE、COMMITTED、整个 assets 或全部目录内容后的 EIO/SIGKILL，回退后部分清理，以及再次中断和 HTTP 重启。8 个通过项为资产局部删除或整个退休目录已消失的对照情形，并非所有异常都必然触发旧缺陷。

独立保留了一份可检查的 RECORD 删除现场：旧版提交返回 `{cleanupPending:true}`，下一进程 recover 退出码 2；修复版提交仍返回清理待重试，下一进程退出码 0，退休目录和凭据均清理完成。两份场景的 users/sessions 在重启前后均保持相同字节。现场位于 `audit-evidence/auth-retirement-reproduction/`，摘要为 `auth-retirement-reproduction.json`，全部使用合成 admin/bob 数据。

新增测试矩阵：

| 覆盖范围 | 数量 |
| --- | ---: |
| EIO / 真实 SIGKILL × RECORD、DONE、COMMITTED、资产文件、嵌套文件/目录、整个 assets、全部内容、整个退休目录 | 18 |
| 退休 rename 后强杀、凭据 rename 后强杀、凭据写入/文件 fsync/目录 fsync/读取失败、凭据 unlink 失败/后强杀、删除后根目录 fsync 失败 | 9 |
| 已回退事务部分清理后恢复 | 3 |
| 完整复制及真实停写归档/恢复工具保留凭据 | 2 |
| 完整旧退休材料兼容 | 1 |
| 已知元数据临时文件完整/部分写入 | 2 |
| 后续认证提交不会被旧退休清理重放 | 1 |
| 未知目录/普通文件/符号链接/额外内容/内容变更/损坏凭据/伪造路径/无凭据残缺材料/未知临时文件拒绝并保留 | 12 |
| 重启清理再次 EIO 或 SIGKILL，然后再重启成功 | 2 |
| 活动事务缺 RECORD、缺 assets、资产改变、COMMITTED 损坏仍阻断 | 4 |
| 实际 HTTP 密码提交、默认 Cookie、重启健康、新旧密码验收 | 1 |
| 合计 | **55** |

注入用例要求实际命中；强杀用例检查子进程确实以 SIGKILL 终止。没有用模拟退出代替强杀，没有测试生产数据。

## 测试结果

- 新增专项：**55/55 通过**，失败、跳过、取消和 todo 均为 0。
- 上一轮认证边界与账户一致性检查：**56/56 通过**，包括原有提交边界、Cookie、SIGKILL、账户及资产一致性用例。
- 最终完整自动化回归：**468/468 通过，失败、跳过、取消和 todo 均为 0，耗时 501.363 秒**。
- `npm run check`、两个新测试文件的 Node 语法检查、`git diff --check` 均通过。
- 完整回归前冻结 **154 个受版本管理的文件**的 SHA-256；结束后复核 **154/154 全部未变**。报告文件在回归结束后新增。

运行环境为 macOS、本地 Node 22.23.3、jsdom 24.1.3。完整命令如下；audit-env 的 Python 包装器仅提高本地静态测试服务的监听队列，未修改仓库测试标准：

```sh
PATH=/Users/million/nocturne/audit-env:/Users/million/nocturne/audit-env/node_modules/node/bin:$PATH \
JSDOM_PATH=/Users/million/nocturne/audit-env/node_modules/jsdom CI=true npm test
```

旧实现反证：

```sh
NOCTURNE_AUTH_RETIREMENT_ROOT=/Users/million/nocturne/audit-evidence/auth-retirement-baseline \
/Users/million/nocturne/audit-env/node_modules/node/bin/node --test \
--test-name-pattern='退休部分删除|已回退事务|重启清理再次|实际 HTTP' test/auth-retirement.test.js
```

修复版专项：`node --test test/auth-retirement.test.js`。完整日志不删减失败反证，也没有因旧版失败而降低断言。

## 兼容与剩余边界

users.json、sessions.json、账户、配置、空间、资产位置、默认 Cookie 名称、事务 RECORD format 1 与归档格式保持不变。新增 JSON 仅是内部退休清理凭据。现有完整回归继续覆盖 RC 缓存基线、旧数据、空间、Cookie 和旧前端兼容。

完整停写备份必须同时保留退休目录与目录外凭据；实际归档/校验/恢复及新进程清理已通过。用内容指纹绑定剩余材料，因此复制或归档恢复至不同目录不依赖旧 inode。唯一写入子进程退出后才运行本轮停写备份测试，没有调用真实 Docker。

已明确保留的边界：

- **历史残缺材料缺少凭据且关键来源核验文件已丢失：** 仍停止启动并保留现场，需要人工独立确认；不能仅凭 `.auth-done.*` 名称自动删除。这是数据保护要求，不能从缺失证据中可靠推断来源。
- **存储或凭据损坏、额外文件、链接和内容冲突：** 保持错误和材料，不能误报为普通清理失败。
- **运行前提：** 唯一写入实例、受保护 DATA_DIR 以及文件系统 fsync/rename 语义。凭据 SHA-256 是完整性校验，不是面对有权写 DATA_DIR 的恶意操作者的签名。没有引入新的安全信任边界。
- **验证范围：** 真实进程强杀不等于设备断电证明；未在 NAS 实测，逐文件指纹的额外 I/O 仍需之后获授权再做实际性能验收。

## 分支状态与独立审查材料

实现及测试已提交至 `fix/p1-storage-protection`。本地 v2 和 origin/v2 均为 `af5104c285abd041e4118faae5d277c23917b113`，未发生修改或推送；本地没有 main 分支。本轮没有创建发布标签。最终交付工作树干净。

材料均位于 `/Users/million/nocturne/audit-evidence/`：

- `auth-retirement-final.patch`：从上述基线到交付 HEAD 的完整差异。
- `auth-retirement-after-final.log`：55 项专项原始日志。
- `auth-retirement-before-final.log`：旧实现 24 项反证原始日志。
- `auth-retirement-full-final.log`：最终完整回归原始日志。
- `auth-retirement-checkpoint-initial.log`、`auth-retirement-syntax.log`：原有认证专项和语法检查。
- `auth-retirement-test-summary.json`、`auth-retirement-frozen-files.json`、`auth-retirement-frozen-verification.json`、`auth-retirement-active-validator.json`：统计、冻结复核与活动校验未变证据。
- `auth-retirement-reproduction.json` 及对应现场目录：旧/新实现独立复现材料。
- `auth-retirement-review-bundle.tar.gz`：完整交付源码、旧模块、差异、测试日志和复现证据，不含 .git；另附 SHA-256 文件及交付状态 JSON。

本轮补修结束，暂停等待最终验收，不进行合并、发布或部署。
