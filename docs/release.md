# 发布检查

1. 在三平台 CI 中运行单元测试、SQLite 探针、目录包内容检查、首次安装与交互界面检查，确认全部通过。
2. 按 [三平台实际使用验收](platform-qa.md) 完成有设备的平台；macOS 和 Linux 实机未验收时，发行说明需明确标注测试范围。
3. 将版本写入 `package.json`，创建同版本 `v<version>` tag。发布工作流会拒绝与包版本不一致的 tag。
4. 发布工作流汇总 Windows NSIS、macOS DMG、Linux AppImage 和 deb，并生成 `SHA256SUMS.txt`。用户可校验下载文件的 SHA256。
5. 安装包只允许包含示例配置，不包含 `config.json`、`.state`、数据库或凭证。CI 会检查目录包内容。

当前没有 Apple 开发者账号，macOS 包未签名或公证；Windows 也未配置发布证书。发布前不要把测试包描述为已签名。后续取得证书后再配置签名、公证，并验证升级与自启；特别是 macOS 登录项可能受签名状态影响。

应用内“检查新版本”只读取 GitHub Release 列表，并在用户点击时打开固定的本仓库下载页。它不会自动下载、安装或执行远程文件。Linux 更新继续使用对应的 AppImage 或 deb 安装方式；正式自动更新留待签名与安装升级验证完成后再评估。
