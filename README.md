# OpenUsage Grok

Windows 托盘应用：仅监控 **Grok / SuperGrok** 多账号用量。

[![Build Windows](https://github.com/chenzai666/openusage-grok/actions/workflows/build.yml/badge.svg)](https://github.com/chenzai666/openusage-grok/actions/workflows/build.yml)

## 功能

- Device-code 登录（复制链接，**不自动打开浏览器**）
- 多账号卡片：周限 / Build / API / 按量
- 托盘显示周限百分比数字
- 应用内代理（自动 / 自定义 / 环境变量 / 系统 / 直连）
- `%APPDATA%\OpenUsageGrok\accounts.json` DPAPI 加密
- Soft-import `~/.grok/auth.json`（只读合并，不覆盖 CLI）
- 手动粘贴续费文案（`Renews on … · billed via …`）

## 开发

```bash
npm install
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
2. 推送标签触发构建与 Release：

```bash
git tag v0.1.1
git push origin v0.1.1
```

也可在 Actions 里手动 `workflow_dispatch`。

## 数据目录

`%APPDATA%\OpenUsageGrok\`

| 文件 | 说明 |
|------|------|
| `accounts.json` | 多账号（DPAPI envelope） |
| `config.json` | 主题、刷新、代理等 |
| `debug\billing-last.json` | 最近一次账单（已打码） |

## 技术栈

Electron 33 · 原生 HTML/CSS/JS · 无 React

## License

MIT
