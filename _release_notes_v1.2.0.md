# Steam 好友收割机 v1.2.0 · 浏览器内一键更新 + 重大修复

## 🚨 重要修复（v1.1.1 及之前版本受影响）

- **popup 全部按钮无反应 + 版本号不显示（两大根因）**：
  1. `popup.js` 顶层 `state` 在 `DEFAULT_SETTINGS_SHAPE` 声明之前就引用它（TDZ），整个脚本第一行就崩 → 所有按钮没有事件绑定、版本徽章停在占位符
  2. `sendMsg()` 通信函数定义丢失，被调用 27 处 → 即使绕过问题 1，所有按钮点击后依然报 `ReferenceError`
- 本次新增**真实加载 popup.js 的冒烟测试**（stub DOM/chrome 环境执行顶层 + init），防止此类问题再次漏网

## 🆕 新功能

**🖥️ 浏览器内一键更新（核心，无需任何桌面脚本）**
- popup 更新横幅 / 设置页新增「🚀 一键更新」按钮 → 打开扩展内更新页
- 全自动三步带进度条：下载 release zip（实时百分比）→ 解压（内置 zip 解析 + DecompressionStream）→ 写入扩展文件夹
- 首次需选择扩展所在文件夹（`showDirectoryPicker`），之后授权存 IndexedDB，一键更新全自动
- 所选文件夹校验 `manifest.json`，选错会提醒；完成后一键打开扩展管理页引导重新加载
- 兼容 PowerShell 打包 zip 的反斜杠路径分隔符（实测修复）
- 下载源：release asset 优先，自动回退 codeload zipball（自动剥前缀）

**📊 跑批百分比进度条**
- 批量添加好友时 popup 顶栏出现绿色进度条，实时显示 `42%（5/12）`

## 文件变更

- `popup/popup.js` — 修 TDZ + 补 `sendMsg`；进度条驱动；一键更新入口
- `popup/popup.html` — 顶部进度条；横幅「一键更新」按钮与两步指引；设置页入口
- `popup/popup.css` — 进度条样式
- `update/` — 新增浏览器内更新页（update.html/css/js）
- `manifest.json` — version 1.2.0；host_permissions 加 `objects.githubusercontent.com`
- `README.md` — 更新章节重写（桌面脚本方式退役）

## 升级步骤（最后一次用桌面方式）

1. 双击桌面 `update.bat` → 一键更新到 v1.2.0 → 扩展页「重新加载」↻
2. 之后所有更新都在浏览器内完成：更新横幅点「🚀 一键更新」即可，桌面脚本和副本可以删了
