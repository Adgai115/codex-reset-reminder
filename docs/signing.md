# 发布签名

当前 v2.0.3 的 Windows 安装包和 macOS DMG 均未完成操作系统代码签名；本机与 GitHub Actions 尚无正式签名材料。新版本是否签名应在对应发行说明中如实标注。

发布工作流允许没有签名材料的构建继续发布。若完整配置以下 GitHub Actions repository secrets，`v*` 标签构建将尝试签名；CI 会在上传前验证结果。不要把证书、私钥、密码或 App Store Connect 密钥提交到仓库或发到聊天中。

| 平台 | GitHub Actions secrets | CI 验证 |
| --- | --- | --- |
| Windows | `WIN_CSC_LINK`（PFX/P12 路径或 Base64）、`WIN_CSC_KEY_PASSWORD` | 安装包和应用 EXE 均为有效 Authenticode 签名 |
| macOS | `MAC_CSC_LINK`（Developer ID Application P12 的 Base64）、`MAC_CSC_KEY_PASSWORD`、`APPLE_API_KEY_P8_BASE64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER` | 应用通过 `codesign`、Gatekeeper 和公证票据验证 |

macOS 工作流只在完整配置五项材料时将 P8 密钥解码到 runner 的临时目录，供 electron-builder 26 公证使用。配置不完整时按未签名构建处理。Windows 同理。首次签名发布前，应在隔离设备安装和升级，核对发布者、自动更新、登录自启和 macOS Gatekeeper 行为。证书续期或更换后重复验证。

GitHub Actions 的 `actions/attest` 会为新发布资产创建构建来源证明，无需长期保存签名私钥。下载资产后可执行：

```bash
gh attestation verify <下载的安装包路径> -R Adgai115/codex-reset-reminder
```

来源证明、SHA256 校验和操作系统代码签名是不同的验证手段；来源证明不能让 Windows 或 macOS 把未签名包识别为已签名。
