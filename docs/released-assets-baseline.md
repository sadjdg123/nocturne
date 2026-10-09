# RC.4 缓存基线

已将 RC.4 的发布提交 `f51662961ba7a86782cb863104917d75fb587553` 和镜像 `ghcr.io/sadjdg123/nocturne:sha-f516629` 加入生成器；清单来自该提交的 public 树与逐个 git blob 校验。RC.4 发布 digest 的交接记录为 `sha256:2c4bf740a106ce78dda34815da9558234e27d0301e397e9dd5c4711e0886b57f`；本轮没有访问或修改镜像仓库，资源内容核验依据发布 Git 提交。

`node tools/gen-released-assets.js --check` 只读核对 GitHub 提交内容，不写清单。普通生成先完整构建并校验五个版本，然后同目录临时文件写入、fsync 和原子替换。网络、权限、截断树、损坏 blob 或写入失败保留旧清单；该保证针对程序失败，不替代断电测试。

CI 保留跨 V1.1、RC.1–RC.4 的全部历史 URL 校验；内容发生变化且 URL 未变必须失败。新增测试注入四个 RC 的内容变化、伪造 hash，以及清单生成/写入故障。本工作包没有修改 public、UI、版本号或静态 URL。

## RC.5 发布登记

RC.5 构建成功后登记完整提交 `c5f36addc2d85b8ed24edb605015b7ff0be9070b` 与镜像 `ghcr.io/sadjdg123/nocturne:sha-c5f36ad`，重新生成六个版本的清单。静态文件与 RC.4 相同；增加 RC.5 的同 URL 内容核验和故障注入报警覆盖，缓存登记专项 25/25、零失败/零跳过。发布镜像内的运行代码未因此改变。
