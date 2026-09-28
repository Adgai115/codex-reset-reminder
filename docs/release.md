# 发布检查

1. 在三平台 CI 中运行单元测试、SQLite 探针、目录包内容检查、首次安装与交互界面检查，确认全部通过。
2. 按 [三平台实际使用验收](platform-qa.md) 完成有设备的平台；macOS 和 Linux 实机未验收时，发行说明需明确标注测试范围。
3. 将版本写入 `package.json` 和 `package-lock.json`，编写 `docs/releases/v<version>.md`，创建同版本 `v<version>` tag。发布工作流会拒绝与包版本不一致的 tag，并使用该文件作为发行说明。
4. 发布工作流汇总 Windows NSIS 与 `latest.yml`、macOS DMG、Linux AppImage 和 deb，先将文件名中的空格转换为 GitHub 下载时使用的句点，再核对 Windows 更新元数据，最后生成 `SHA256SUMS.txt`。用户可直接校验下载文件的 SHA256。
5. 安装包只允许包含示例配置，不包含 `config.json`、`.state`、数据库或凭证。CI 会检查目录包内容。

当前没有 Apple 开发者账号，macOS 包未签名或公证；Windows 也未配置发布证书。发布前不要把测试包描述为已签名。后续取得证书后再配置签名、公证，并验证升级与自启；特别是 macOS 登录项可能受签名状态影响。

Windows 安装版使用 electron-updater 读取同一仓库 Release 的 `latest.yml`，用户主动下载并校验后，再确认关闭应用、在原安装位置升级。发布工作流必须上传 Windows 安装包及 `latest.yml`，两者的文件名和版本需一致。若更新元数据不可用，仍可打开固定的本仓库下载页。macOS 和 Linux 暂保留手动安装方式。当前 Windows 安装包未签名，系统可能显示安全警告；正式发布前应在隔离安装目录验证完整升级路径，并在取得证书后增加签名验证。
