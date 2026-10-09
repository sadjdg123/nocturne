# 镜像标签防覆盖：设计与模拟，尚未启用

本阶段不修改 `.github/workflows/docker.yml`，不运行 Docker 构建、登录、镜像写入或 Actions。本辅助模块没有命令行入口、默认 HTTP 客户端或真实推送适配器；测试传入纯内存 HTTP 响应和标为 simulation 的发布器。现有生产工作流仍保留旧行为，正式接入需要另行批准。

## 最小协议

`tools/image-publish-policy.js` 的模拟计划要求显式 approved 标记，限定仓库 sadjdg123/nocturne、原 push 事件的待发布提交、v2 ref、完整 40 位 revision，标签只能是与该提交对应的一个 sha-七位标签。拒绝 latest、main/v2、浮动 semver、重复或附带标签。独立开发分支不能进入此模拟发布协议；不改变现有 V1.1 工作流。正式版本的不可变版本标签须另行设计和授权，当前不支持。

读取器要求显式 HTTP 适配器和 scoped Bearer 授权，不获取或记录凭据。验证带授权的 V2 API 响应后，对标签执行 HEAD 和 GET；只有两次均 404 且 GET 是唯一 MANIFEST_UNKNOWN 错误时，才判定缺失。401/403、限流、服务器故障、网络错误、网页 404、NAME_UNKNOWN、状态变化或缺失 digest 一律阻断。凭据真实权限与 GHCR 错误语义仍需未来集成验收。

存在的标签核对原始响应 SHA-256、索引和子清单/config 的 digest 与大小，确认 linux/amd64、linux/arm64 均存在且配置 revision 为同一完整提交。相同 revision 返回 skip，绝不重推；短 SHA 一样而完整 revision 不同阻断。Buildx 明确标记的 unknown/unknown 证明条目不算运行平台。已有标签缺损也不能用覆盖“修补”。

模拟写入前紧邻再次核查，完成后核对发布器返回的索引 digest 与注册表读取结果、双架构和完整 revision。丢失成功响应后重跑须先检查，不盲目重推。推送后验证失败必须报告失败并保留诊断，不自动删除或重写远端标签。

## 并发和正式接入的批准边界

模拟协调器以仓库+标签串行，测试三次并发只写一次。正式接入须在整个检查—推送—验收区间使用独立发布 job 的仓库+标签 concurrency group，`cancel-in-progress: false`，且所有向该标签写入的工作流共享该锁。避免当前按 ref 取消正在发布的任务。构建/测试可以单独取消，但发布临界区不能沿用这条规则。

未来须把自动构建验证与有 packages:write 的发布任务分离。普通 push 不等于发布批准；正式入口应使用用户批准的显式触发和受保护环境，审批结果由可信工作流赋予，而不能让任意客户端声明 approved。本轮的 approved=true 只表示授权进行本地模拟。发布 job 不向测试/PR 泄露写权限。

进程内锁不能替代 Actions 跨 runner 锁。Registry V2 标签 API 没有本方案可依赖的通用原子“仅不存在时创建”接口；即使二次检查，也无法阻止不遵循同一锁的外部客户端插入写入。正式启用前必须收敛全部写入入口/权限，核实 GHCR 支持边界，获得工作流变更批准，再在独立测试仓库做真实认证、并发和双架构验证。生产 v2/main 不在本轮操作范围。

## 验证与依据

测试使用协议结构的 OCI 索引、子清单和 config，不访问 GHCR，不从环境读 token；所有 HTTP 请求方法断言为 GET/HEAD。旧工作流反证只重放源文件中的 `event_name != pull_request` 推送条件，证明它对既有标签和注册表异常没有上述门禁；这不是实际 Actions 或 GHCR 发布证据。

协议参考：[Distribution Registry V2 API](https://distribution.github.io/distribution/spec/api/)、[OCI image index](https://github.com/opencontainers/image-spec/blob/main/image-index.md)、[GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。HEAD/GET、内容 digest、索引平台字段和共享并发组按这些官方说明实现；正式切换另行批准。
