# 2.0.0 正式版发布前验收

- 版本：`package.json`、`package-lock.json` 与本机已安装包均为 `2.0.0`。发布标签使用 `v2.0.0`。
- Windows 本机：`npm test` 共 82 项，81 项通过、1 项 Unix 专属跳过；`npm run probe:sqlite` 输出 `SQLITE_OK 22.21.1 37.10.3`。
- Windows NSIS 安装包构建和 `npm run verify:package` 通过，未包含正式配置、数据库或凭证。安装包 SHA256 为 `BB74FF00161E9F828AAE603F74E9BFDAF2481FB1F766231112A43A4F1D6E2015`。
- 隔离数据与模拟 Codex 依赖下，安装包 `--setup`、普通界面、`--p0`、`--recovery`、`--pending`、`--native-dialogs` 和强制 sidecar 的 `--background` 均通过。没有请求真实用卡接口或发送真实飞书消息。
- 本机旧版退出后静默安装 `2.0.0`，安装器退出码为 0；已安装资源与受测目录包一致。安装前后，两套 `config.json` 与 `data.db` 共四个正式文件的 SHA256 均保持一致。原中文桌面快捷方式指向已安装的正式版；安装器生成的重复英文快捷方式已移至本地备份。

三平台 CI 将在 PR 和正式标签上再次执行。macOS、Linux 的托盘、自启、休眠恢复和升级尚未在实机验收；Windows 未签名，macOS 未签名或公证；真实飞书网络超时后的服务端幂等效果尚未实测。详见[平台验收范围](platform-qa.md)。
