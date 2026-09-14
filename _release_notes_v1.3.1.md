# Steam 好友收割机 v1.3.1 · 登录检测修复 + 队列过滤增强

## 摘要

- **修复「一直显示未登录」的 bug**：登录检测用了会被浏览器吞掉重定向的请求方式，导致无论登没登录都误判为未登录。现改为跟随重定向后检查落地页，判断准确。
- **新增登录入口**：弹窗顶部的登录状态徽章现在可点击 —— 未登录时点一下直接打开 Steam 社区登录页；登录完成后回弹窗点徽章即可重检，或等 20 秒自动变绿（弹窗开着就会自动轮询）。
- **队列过滤器增强**：Steam 里已经是好友的、黑名单里的、之前已经处理过的，不再显示在队列里：
  - 打开弹窗时自动清理一次队列（并顺带刷新好友对照表，10 分钟节流），清理了多少会 toast 提示；
  - 渲染层再加一道双保险过滤。
  - 注意：好友对照表来自「快照好友列表」，建议偶尔点一下设置区的快照按钮保持新鲜；加过的人跑批后也会进入历史，不占队列。

## 缺陷修复

- 修复 Service Worker 中 `redirect: 'manual'` 恒返回 `opaqueredirect`（status=0）导致登录态永远误判为「未登录」的问题（`checkLoggedIn` 改为 `redirect: 'follow'` + 落地 URL 判断）。
- 修复桌面更新器 CLI 模式在 GBK 控制台打印「↻」字符崩溃、把「更新成功」误报为「更新失败」的问题（stdout 加 `errors="replace"`）。
- 桌面更新器搬运白名单补上 `update/`（v1.2.0 新增的浏览器内一键更新页此前不会同步到桌面副本）。

## 文件变更

- `background/service-worker.js` — `checkLoggedIn` 重定向修复；新增 `pruneQueue` 与 `SFP_QUEUE_PRUNE` 消息（队列清理 + 可选好友对照表刷新）；新增 `SNAP_TS_KEY` 快照时间戳。
- `popup/popup.js` — 登录徽章可点击（未登录→打开登录页，已登录→重检）+ 20 秒自动轮询；打开时自动清理队列并提示；`SFP_FRIENDS_GET` 填充本地好友对照表；队列渲染层过滤黑名单/好友。
- `popup/popup.css` — `.badge-click` 可点击样式。
- `_auto_update.py` — CLI GBK 编码兜底；白名单补 `update/`。

## 验证情况

- `node --check` 两个改动 JS 通过；`_smoke_friendcode.js`（6+9 组用例）、`_smoke_popup.js`（真实执行 init，无 TDZ/ReferenceError）、`_dryrun_all_features.js` 全部通过。
- 桌面更新器 CLI 实测：v1.2.0 → v1.3.0 更新成功（18 文件，含 `update/`），二次运行为「已是最新」。
