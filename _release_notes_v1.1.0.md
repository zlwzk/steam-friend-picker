# Steam 好友收割机 v1.1.0 · 可视化更新器

## 新增功能

**🖥️ 桌面可视化更新器（v1.1.0 核心）**

双击桌面 `update.bat` 不再是黑框命令行，而是弹出深色 GUI 更新器：

- **版本对比卡片**：当前版本 → 最新版本，大字高亮（有新版绿色、已是最新打勾）
- **四步进度指示**：检查更新 → 下载更新包 → 解压覆盖 → 完成刷新，逐步打勾变色
- **下载进度条**：实时百分比 + 已下载大小 + 速度（KB/s）
- **彩色日志区**：带时间戳滚动日志，成功绿 / 警告橙 / 错误红
- **🚀 一键更新**：一个按钮跑完整流程，完成后自动打开 Edge 扩展页
- **🔧 强制重装**：桌面副本文件损坏时，无视版本比对直接从最新 release 重装
- **↻ 重新检查**：手动重新拉 GitHub latest
- 无黑框启动（pythonw），tkinter 不可用时自动退回命令行模式

**可靠性升级（更新器内部）**

- **原子替换**：旧目录先改名 `.old` 再覆盖，失败自动回滚——更新中途出错也不会把桌面副本搞坏
- **双下载源**：优先 release asset（白名单打包），失败自动退回 codeload zipball
- **布局自识别**：asset（顶层即 manifest.json）与 API zipball（带 `<repo>-<sha>/` 前缀）都能正确解压

**🪟 Popup 更新面板（扩展内）**

- 更新横幅从一行字升级为**可点击展开的详情面板**：
  - 新版本号 + 发布日期 + 当前版本
  - **更新内容摘要**（来自 release body 前 600 字，Service Worker 检查更新时自动抓取）
  - **三步图文指引**：双击桌面 update.bat → 等进度条走完 → 扩展页点「重新加载」
- 「打开发布页」「忽略」按钮保留在面板底部

## 缺陷修复（承接 v1.0.1 调试结论）

- 修复「Popup 能开但所有按钮无反应」：`init()` 的 `refreshStatus()` 抛错不再阻断事件绑定
- 统一 `sendMsg()` 包裹 `chrome.runtime.sendMessage`，通信失败自动弹 toast 而非静默
- 修复 `state.friends` 永远为空（好友对照 UI 显示无意义）的问题
- Service Worker 新增 `SFP_FRIENDS_GET` 消息分支

## 文件变更

- `manifest.json` — version 1.0.0 → 1.1.0
- `popup/popup.html / .css / .js` — 更新横幅重构为可展开面板（notes + 步骤指引）
- `background/service-worker.js` — `checkForUpdate()` 存 `releaseNotes` 字段
- `README.md` — 自动更新章节改写
- 桌面端 `update.bat` / `_auto_update.py`（不在扩展包内，随仓库分发）完全重写为 GUI 更新器

## 升级步骤

本次升级本身就是新更新器的第一次实战：

1. 双击桌面 `update.bat` → 弹出可视化更新器
2. 看到 `v1.0.0 → v1.1.0`，点「🚀 一键更新」
3. 等四步全部打勾，自动打开扩展页后点「重新加载」↻ 完成
