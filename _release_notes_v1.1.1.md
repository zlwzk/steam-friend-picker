# Steam 好友收割机 v1.1.1 · 版本号显示修复

## 缺陷修复

- **版本徽章占位符写死旧版本号**：`popup.html` 里 `v?` 占位（原写死 `v1.0.0`），popup 初始化时直接读本地 `chrome.runtime.getManifest().version` 立即填充——不再依赖 Service Worker 响应，SW 未唤醒/通信失败时也不会闪现错误的旧版本号。

> 其余版本号位置（README 标题、release notes、桌面更新器、打包脚本）全部动态读 `manifest.json`，本版起形成「单一版本源」约定。

## 文件变更

- `manifest.json` — version 1.1.0 → 1.1.1
- `popup/popup.html` — 版本徽章占位 `v1.0.0` → `v?`
- `popup/popup.js` — `init()` 开头用 `chrome.runtime.getManifest().version` 填充徽章
- `README.md` — 标题版本号同步

## 升级步骤

1. 双击桌面 `update.bat` → 点「🚀 一键更新」
2. 等四步打勾，自动打开扩展页后点「重新加载」↻ 完成
