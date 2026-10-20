# RC.4 缓存基线

已将 RC.4 的发布提交 `f51662961ba7a86782cb863104917d75fb587553` 和镜像 `ghcr.io/sadjdg123/nocturne:sha-f516629` 加入生成器；清单来自该提交的 public 树与逐个 git blob 校验。RC.4 发布 digest 的交接记录为 `sha256:2c4bf740a106ce78dda34815da9558234e27d0301e397e9dd5c4711e0886b57f`；本轮没有访问或修改镜像仓库，资源内容核验依据发布 Git 提交。

`node tools/gen-released-assets.js --check` 只读核对 GitHub 提交内容，不写清单。普通生成先完整构建并校验五个版本，然后同目录临时文件写入、fsync 和原子替换。网络、权限、截断树、损坏 blob 或写入失败保留旧清单；该保证针对程序失败，不替代断电测试。

CI 保留跨 V1.1、RC.1–RC.4 的全部历史 URL 校验；内容发生变化且 URL 未变必须失败。新增测试注入四个 RC 的内容变化、伪造 hash，以及清单生成/写入故障。本工作包没有修改 public、UI、版本号或静态 URL。

## RC.5 发布登记

RC.5 构建成功后登记完整提交 `c5f36addc2d85b8ed24edb605015b7ff0be9070b` 与镜像 `ghcr.io/sadjdg123/nocturne:sha-c5f36ad`，重新生成六个版本的清单。静态文件与 RC.4 相同；增加 RC.5 的同 URL 内容核验和故障注入报警覆盖，缓存登记专项 25/25、零失败/零跳过。发布镜像内的运行代码未因此改变。

## V2.0.0 发布登记

正式发布后登记完整提交 `93d9bec8e4e581107d375d57f9870b3353ade879` 与新 SHA 镜像，清单覆盖 V1.1、RC.1–RC.5、V2.0.0 七个版本。public 内容保持 RC.5 原样；对应旧 URL 同内容及注入内容变更仍必须报警。

## V2.1.0 发布登记

发布成功后登记完整提交 `1bb4b2087697f1b38cb0b0b0332377ec55f1778c` 与新镜像 `ghcr.io/sadjdg123/nocturne:sha-1bb4b20`。清单保留 V1.1、RC.1–RC.5 与 V2.0.0，增加 V2.1.0；Midnight 样式/行为使用新 URL（v4/v3），旧 URL 内容约束保持严格。

## V2.1.3 发布登记

发布后登记完整提交 `9c960614ab41f21159193519df04833a9e371a5f` 与新镜像 `ghcr.io/sadjdg123/nocturne:sha-9c96061`，清单保留全部历史版本。新增 config-shape.js 有独立缓存 URL，nocturne.js 使用新的版本 URL；共享 URL 的历史内容约束保持严格。

## V2.2.0 发布登记

发布后登记完整提交 `d0ff57d72158ff5f5452511cff9f04a0dd6a3f67` 与新镜像 `ghcr.io/sadjdg123/nocturne:sha-d0ff57d`，清单保留全部历史版本。首页内联脚本 / 样式拆出的 `app.js`、`app-ui.js`、`app.css`、`app-ui.css` 使用内容指纹 `?v=`（新 URL，与历史版本不共享）；带 `?v=` 的文件自本版起 immutable，同 URL 同内容约束更为关键，历史共享 URL 的内容约束保持严格。GitHub API 在登记环境不可用，清单用 `test/released-assets-reliability.test.js` 同款本地 git 树 / blob 读取生成（该测试断言离线生成与清单逐字节一致）。
