# Steam 好友收割机 v1.0.0 · 自动检查更新

## 新增功能

**🔄 自动更新链路（v1.0.0 核心）**
- **扩展内半自动**：Service Worker 后台定时（默认 6h）调 `api.github.com/repos/zlwzk/steam-friend-picker/releases/latest`，比对 semver
- **桌面通知**：发现新版本弹 `chrome.notifications`，点通知打开 release 页
- **Popup 横幅 + 版本徽章高亮**：顶部橙色横条 + 版本号闪烁，点击徽章立即检查
- **设置可配**：开关 / 频率（1~168h）/ 通知开关 / 立即检查按钮
- **桌面端全自动**：双击桌面根目录 `update.bat` → 拉新版 → 覆盖桌面副本 → 引导 Edge 扩展页 Reload

## 兼容性

manifest 升到 1.0.0，新增 `alarms` 权限 + `api.github.com / codeload.github.com / github.com` host 白名单 + `update_url` 字段（unpacked 加载时被忽略，保留兼容）。

## 文件变更

- `manifest.json` — version 0.2.0 → 1.0.0，加 3 项权限、3 项 host
- `background/service-worker.js` — 加 `checkForUpdate()` / `setupUpdateAlarm()` / `notifyUpdateAvailable()` + 3 个消息路由分支
- `popup/popup.html / .css / .js` — 顶部版本徽章 + 更新横幅 + 设置页「自动更新」小节 + 3 个新控件
- `README.md` — 加「自动更新」章节、设置详解、FAQ

## 升级步骤

扩展已经会在启动后 1 分钟内自动检查更新。或者：

1. 打开弹窗 → 顶栏版本号点击 → 检查更新
2. 设置 → 自动更新 → 「立即检查更新」

## 首次发版

这是首次在 GitHub Releases 上发布。之前版本（0.2.0 及以前）没有 release，所以本次检查会显示「已是最新」。