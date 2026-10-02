# 个人微信 PushPlus 接入验收

日期：2026-10-02。开发版本 v2.3.0，基于已发布 v2.2.3；本记录不代表新版已发布或本机正式安装已更新。

## 范围

| 项目 | 行为 |
| --- | --- |
| 入口 | 保持统一“设置”，在“提醒”页选择“微信（PushPlus）”并配置连接 |
| 接收人 | 使用一个 PushPlus 用户 Token，所有开启提醒的账号共享接收人，正文注明所属账号 |
| 凭据 | 系统密钥加密存储；不写入普通配置、数据库或日志，不回显到界面；留空保留已存 Token |
| 测试 | 保存 Token 与开关后，用户显式点击“发送微信测试”并确认才提交一条演示通知；不读取正式卡片、不消费卡、不自动发送测试消息 |
| 消息 | 账号名称、卡名、编号尾号、到期时间、剩余时间；仅通知，正式用卡仍在本机确认 |
| 状态 | PushPlus `code=200` 表示请求已接收，显示“已提交”，不称为已送达 |
| 去重 | 同一账号、卡片、提醒节点独立记录；已提交或结果未确认不重复提交；重启继续保留 |
| 补发 | 明确失败遵守首次加最多 3 次补发、1 / 5 / 15 分钟及已有账号、免打扰、延期限制；服务返回账号受限时停止自动补发 |
| 兼容 | 保持 Electron 37、Node 核心、SQLite、原生 HTML/JS；保留桌面、飞书及旧微信通道语义 |

## 服务依据

- [PushPlus 消息接口文档](https://www.pushplus.plus/doc/guide/api.html)：微信 `channel=wechat`，JSON POST，请求接收与异步送达是不同状态。
- [PushPlus 系统功能额度](https://www.pushplus.plus/doc/guide/use.html)：实名认证、发送频率及额度依服务方当期规则，应用不固定承诺。
- [PushPlus 官网](https://www.pushplus.plus/)：用户自行登录、关注与取得自己的 Token；不在聊天中提供真实 Token。

## 验证边界

自动验证使用临时 profile、临时数据库和模拟 HTTP/安全存储依赖；不读取或修改正式配置，不使用真实 Token，不发送真实飞书或微信，不消费真实卡。界面检查使用模拟 `window.api`，只检查页面交互和布局，不冒充正式 IPC 或实际微信送达。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `npm test` | 141 项，140 通过、1 项平台条件跳过、0 失败；含请求、节点去重、旧库迁移、未知结果、服务限额、Token 保存及 sidecar 两账号隔离 |
| `npm run probe:sqlite` | Electron 37.10.3，运行时 22.21.1，SQLite 可用 |
| `npm run dist` | Windows NSIS 2.3.0 构建成功，包内本轮源码比对一致 |
| 包内容与更新附件 | `npm run verify:package`、`npm run verify:updates` 通过；未混入配置、数据库、账号或渠道凭据 |
| 普通安装包烟测 | `node scripts/smoke-packaged.mjs --native-dialogs` 通过，包含加密 Token 保存、状态恢复、页面权限及取消测试；微信始终关闭 |
| 多账号安装包烟测 | `node scripts/smoke-packaged.mjs --accounts --native-dialogs` 通过，包含同卡号隔离、独立故障、记录范围与重启恢复 |
| Windows 实际签名 | 安装器 `Get-AuthenticodeSignature` 返回 `NotSigned` |
| Chromium 页面布局 | 560×500、660×700，浅色/深色，均无横向溢出；微信标签与按钮单行、底部保存区在视口内 |
| 显式发送 | 打开页面、保存配置及点击“获取 Token”均未调用测试发送；点击“发送微信测试”才调用一次模拟 API |
| Token 草稿与保存 | 未配置时空值阻止启用；跨页签与设置再次打开信号保留草稿；保存后密码框清空，留空保留已存状态 |
| 保存失败 | 保留输入与未保存状态，不允许用旧接收人测试；替换 Token 或改变微信开关时测试按钮禁用 |
| 忙碌与关闭保护 | 测试处理中锁定保存、取消、账号修改和重复测试，通知主进程 working；完成后保留其他提醒草稿 |
| 提交与未知反馈 | 已接收显示“已提交”；结果待核实时显示错误反馈，不表述为已送达；保留旧公众号“已发送”标签 |
| 旧公众号配置 | 不自动迁移；保存无关提醒配置后保持旧 provider 与启用状态，全部渠道关闭提示不误报 |

以上使用本机私有 `.git/pushplus-ui-review.py` 的 Python Playwright + Chrome 模拟页面检查，命令为 `python -u .git/pushplus-ui-review.py`，退出码 0。截图与尺寸结果保存在本机 `.git/pushplus-ui-evidence/`，不加入公开仓库；此脚本依赖本机历史模拟材料，不是可移植构建流程。

本机证据位于 `.git/pushplus-tests-final.log`、`.git/pushplus-sqlite.log`、`.git/pushplus-build-final.log`、`.git/pushplus-packaged-ui-final.log`、`.git/pushplus-packaged-accounts.log`，不加入公开仓库。

真实微信送达需由用户完成 Token 配置后显式点击“发送微信测试”并在手机确认，当前未验收。本记录的本地通过结果不代表远端三平台 CI 已完成，也不代表新版已发布或正式安装已更新。
