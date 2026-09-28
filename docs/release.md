# 发布检查

1. 在三平台 CI 中运行单元测试、SQLite 探针、目录包内容检查、首次安装与交互界面检查，确认全部通过。
2. 按 [三平台实际使用验收](platform-qa.md) 完成有设备的平台；macOS 和 Linux 实机未验收时，发行说明需明确标注测试范围。
3. 将版本写入 `package.json` 和 `package-lock.json`，编写 `docs/releases/v<version>.md`，创建同版本 `v<version>` tag。发布工作流会拒绝与包版本不一致的 tag，并使用该文件作为发行说明。
4. 发布工作流汇总 Windows NSIS 与 `latest.yml`、macOS DMG、Linux AppImage 和 deb，先将文件名中的空格转换为 GitHub 下载时使用的句点，再核对 Windows 更新元数据，最后生成 `SHA256SUMS.txt` 和 GitHub 构建来源证明。用户可校验 SHA256 和来源证明。
5. 安装包只允许包含示例配置，不包含 `config.json`、`.state`、数据库或凭证。CI 会检查目录包内容。

签名材料为可选配置：缺少时仍允许发布，但发行说明必须明确写出 Windows、macOS 的实际签名状态。配置材料后，CI 会验证 Windows 安装包与应用程序签名，以及 macOS 应用签名和公证；失败则该平台构建失败。配置方法见 [签名说明](signing.md)。GitHub 构建来源证明不等于操作系统代码签名。签名状态变化后需验证 Windows 升级和 macOS 登录项。

Windows 安装版使用 electron-updater 读取同一仓库 Release 的 `latest.yml`，用户主动下载并校验后，再确认关闭应用、在原安装位置升级。发布工作流必须上传 Windows 安装包及 `latest.yml`，两者的文件名和版本需一致。若更新元数据不可用，仍可打开固定的本仓库下载页。macOS 和 Linux 暂保留手动安装方式。未签名的 Windows 安装包可能显示系统安全警告；发布前应在隔离安装目录验证完整升级路径。
