# OpenUsage Grok

Windows 托盘应用：监控 **Grok / SuperGrok** 和 **ChatGPT / Codex** 多账号用量。保留 Grok 原版卡片、托盘及代理设置，通过顶部标签切换服务。

[![Build Windows](https://github.com/chenzai666/openusage-grok/actions/workflows/build.yml/badge.svg)](https://github.com/chenzai666/openusage-grok/actions/workflows/build.yml)

## 功能

- Device-code 登录（复制链接，**不自动打开浏览器**）
- 从 **Cliproxy / CLIProxyAPI** 导入 xAI 账号（扫描 `~/.cli-proxy-api`、选 JSON、或粘贴 `xai-*.json`）
- 多账号卡片：周限 / Build / API / 按量
- 托盘显示周限百分比数字
- 应用内代理（自动 / 自定义 / 环境变量 / 系统 / 直连）
- `%APPDATA%\OpenUsageGrok\accounts.json` DPAPI 加密
- 启动/刷新自动同步 `~/.grok/auth.json`（只读合并，不覆盖 CLI；解密失败可从 CLI 重建）
- 设置页：代理、同步 CLI、退出设置回总览
- 手动粘贴续费文案（`Renews on … · billed via …`）
- ChatGPT / Codex：CLIProxy 扫描、选择文件或目录、粘贴 JSON，以及只读同步本机 Codex OAuth 登录
- ChatGPT 卡片：会话限额、周限额、其他模型限额、重置时间和可用重置卡
- 删除本机卡片后保持隐藏，可在设置中手动同步恢复；不删除或修改 CLI 的 `auth.json`
- 重置卡需要原生确认；请求结果未知时保留幂等编号，后续核对复用同一编号

## ChatGPT / Codex 使用

1. 切换到顶部 **ChatGPT / Codex**，点击 CLIProxy 导入或进入设置选择扫描、文件、目录、粘贴。
2. CLIProxy 导出需要 Codex / ChatGPT OAuth 的 `access_token`。仅 API Key 登录没有订阅额度，不会自动生成本机卡片。
3. Grok 与 ChatGPT 共用设置页的代理模式，支持自动、自定义、环境变量、系统和直连；升级保留已有设置。
4. 在卡片菜单中删除账号，只清理本程序的副本。本机卡片可以通过“同步本机 Codex”恢复。
5. 点击可用重置卡后，核对原生对话框中的账号和数量再确认。没有可重置额度时，服务端可能返回“无需重置”。

CLIProxy 导入为只读凭据快照，不使用或轮换源账号的 `refresh_token`。访问令牌过期后，请让原 CLIProxy / Codex 完成刷新，再重新导入或同步。程序不修改源凭据文件。

## 开发

```bash
npm install
npm test
npm start
```

冒烟（Electron 内拉账单）：

```bash
npm run smoke
```

## 打包

```bash
npm run dist
# 或
npm run release   # dist + 复制到 Desktop\OpenUsage-releases\
```

产物：

- `OpenUsage-Grok-{version}-portable.exe`
- `OpenUsage-Grok-{version}-setup.exe`

## GitHub 发布

1. 确保 `package.json` 的 `version` 正确  
2. 使用 `gh` 创建标签触发构建与 Release：

```bash
gh api repos/chenzai666/openusage-grok/git/refs -f ref=refs/tags/v0.1.19 -f sha="$(git rev-parse HEAD)"
```

也可在 Actions 里手动 `workflow_dispatch`。PR 会先测试再构建安装包，不创建正式 Release。

## 数据目录

`%APPDATA%\OpenUsageGrok\`

| 文件 | 说明 |
|------|------|
| `accounts.json` | 多账号（DPAPI envelope） |
| `chatgpt-accounts.json` | ChatGPT 独立 DPAPI 加密凭据、本机隐藏标记、待核对重置编号 |
| `config.json` | 主题、刷新、代理等 |
| `debug\billing-last.json` | 最近一次账单（已打码） |

更新前备份此数据目录。ChatGPT 凭据仅在系统加密可用时保存，不降级写入明文；损坏的凭据文件会保留并报错。备份仍含敏感信息，应限制访问。

## 技术栈

Electron 44 · 原生 HTML/CSS/JS · 无 React

## License

MIT
