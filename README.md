# 🎮 Steam 好友收割机 (Steam Friend Picker) v0.2.0

Edge / Chrome 浏览器扩展（Manifest V3）。**多入口**抓取 Steam 好友代码 → 智能去重过滤 → **可配置间隔批量加好友**，自带风控保护（自适应间隔、日配额、时段、限流重试）和完整本地数据管理（黑/白名单、好友对照、JSON 备份）。

> ⚠ **风险提示**：Steam 对加好友频率有反作弊策略。**建议间隔 ≥ 8 秒、单次 ≤ 30 人、日配额 ≤ 50**。频繁操作可能触发 CAPTCHA 或临时封号。本工具仅供学习与个人使用，请勿用于骚扰、营销、刷号等违规用途。

---

## ✨ 功能一览

### 🛰️ 多入口抓取（4 类来源自动分组）

| 来源 | 抓什么 | 自动分组 |
|---|---|---|
| 小黑盒文章/讨论评论区 | 所有人贴的 Steam 链接 / 数字 ID / `[steam]xxx[/steam]` BBCode 签名档 | 小黑盒评论 |
| **Steam 个人主页 /friends/** | 滚到底触发懒加载 + 分页 fetch，自动排除自己 | Steam 好友列表 |
| **Steam 群组成员** `/groups/<name>/members?p=N` | 自动翻页抓全部成员 | Steam 群组 |
| **Steam 搜索结果** `/search/users/` | 自动翻页抓用户卡 | Steam 搜索 |
| 粘贴 / 导入 | 一段文本混合以上格式自动识别 | 导入 |

### 📋 队列管理

- **分组过滤**下拉（按来源 group）
- **实时搜索**（ID 或来源 URL）
- **批量勾选** → 删除 / 加入黑名单 / 重新尝试
- **来源预览**：每项 hover 显示完整来源 URL，**点击复制 ID** / **双击打开 Steam 主页**

### 🚫 黑名单 / 白名单

- 手动添加（粘贴文本自动提取）
- **自动学习**：被 Block 自动进黑名单（可关）
- 入队前自动跳过黑名单 / 白名单
- 「把队列全部加入黑名单」一键操作

### 👥 好友对照

- 一键从你当前 Steam 账号的 `/friends/` 抓全部好友入库
- 入队前自动跳过已知好友（省 quota）

### ⏱️ 智能调度

- **间隔**：min ~ max 秒随机抖动（防风控）
- **单次最多**：达到后自动停
- **日配额**：默认 50/天，达到后自动暂停到次日
- **黄金时段**：可选只在 9~23 点跑
- **自适应间隔**：限流命中自动 ×1.5，连续命中 ×2.0
- **限流自动重试**：遇 `RateLimitExceeded` 等 30 秒重试，最多 N 次
- **完成桌面通知**：跑完一波系统通知

### 📊 统计与历史

- **统计卡片**：总成功 / 总失败 / 今日 / 今日剩余
- **近 7 天趋势图**（canvas 自绘，主题色自适应）
- **历史筛选**：按状态（成功/已是好友/邀请已发/限流/被屏蔽/失败）× 按分组 × 搜索 ID
- 一键清空历史

### 💾 数据备份 / 恢复

- **CSV 导出**（含 BOM，Excel 可直接打开，UTF-8 中文不乱码）
- **JSON 全量备份**：队列 + 历史 + 黑名单 + 白名单 + 好友对照 + 设置 + 每日计数 + 个人资料缓存
- **JSON 恢复**：可合并（默认） / 覆盖
- **所有数据只存 `chrome.storage.local`，绝不上传任何第三方**

### 🎨 UI

- 580px 宽 · 5 Tab（队列 / 历史 / 黑名单 / 设置 / 备份）
- **暗色 / 浅色 双主题**（CSS 变量驱动）
- Toast 通知（成功 / 警告 / 错误三色）
- 响应进度条（运行中状态栏显示 `⚡ 5/30 ×1.5 · ✓3 友1 邀0 限1 败0`）

---

## 📥 加载步骤（Edge / Chrome）

1. 打开扩展管理页
   - Edge：`edge://extensions/`
   - Chrome：`chrome://extensions/`
2. 打开右上角 **「开发人员模式」** 开关
3. 点 **「加载解压缩的扩展」**，选择本仓库的 `steam-friend-picker/` 目录
4. 装好后浏览器工具栏会出现 🎮 图标，**先点一次** 让它激活
5. 打开 `https://steamcommunity.com` 登录你的 Steam 账号
   - ⚠ sessionid cookie 默认约 1 小时有效，长时间挂着会过期，重新登录即可

---

## 🚀 使用流程

### 方式 A：从 Steam 个人主页收割

1. 打开某人主页，例如 `https://steamcommunity.com/id/<vanity>/friends/`
2. 等右上角 **「🎮 收割此页好友」** 按钮出现
3. 点击 → 自动滚到底触发懒加载 + 翻页 → 入队

### 方式 B：从小黑盒评论区收割

1. 打开小黑盒文章页（`https://www.xiaoheihe.cn/article/...`）
2. 等右下角 **「🎮 收割 N 个 Steam ID」** 按钮出现
3. 如果评论很长，多点几次「加载更多评论」让扫描覆盖更全

### 方式 C：从 Steam 群组收割

1. 打开群组成员页 `https://steamcommunity.com/groups/<name>/members`
2. 点右上方 **「🎮 收割群成员」** 按钮，自动翻页到 10 页

### 方式 D：从 Steam 搜索结果收割

1. 打开 `https://steamcommunity.com/search/users/#text=<关键词>`
2. 点右上方 **「🎮 收割搜索结果」**

### 方式 E：手工导入

弹窗「队列」Tab → **📂 导入** → 粘贴一段文本（每行一个，支持纯 17 位数字 / 主页链接 / BBCode），扩展自动正则提取 + 后台解析自定义 URL。

### 方式 F：CSV 导入导出

弹窗「备份」Tab → **💾 导出 CSV / 📂 导入 CSV**。CSV 含 BOM，Excel 直接打开。

---

## ⚙️ 设置详解（弹窗「设置」Tab）

### 调度

| 项 | 默认 | 说明 |
|---|---|---|
| 间隔 | 8~15 秒 | 每次加好友之间随机睡 `rand(min, max)` 毫秒 |
| 单次最多 | 30 人 | 达到后自动停 |
| 日配额 | 50 人 | 0 = 不限，达到后自动暂停到次日 |
| 限流自动重试 | 开 | 遇 `RateLimitExceeded` 等 30s 重试，最多 3 次 |
| 自适应间隔 | 开 | 限流命中 ×1.5，连续命中 ×2.0 |
| 黄金时段 | 关 | 只在 9~23 点运行 |
| 完成桌面通知 | 开 | 跑完一波系统通知 |

### 过滤

| 项 | 默认 | 说明 |
|---|---|---|
| 入队前跳过黑名单 | 开 | 黑名单里的 ID 不会入队，已在队列里的也会移除 |
| 入队前跳过已知好友 | 开 | 入库过的当前账号好友自动跳过 |
| 被 Block 自动进黑名单 | 开 | 对方拒绝/屏蔽时自动入库 |

### 外观

| 项 | 默认 | 说明 |
|---|---|---|
| 主题 | 暗色 | 暗色 / 浅色可切换（CSS 变量驱动） |

---

## 📋 错误状态对照表

| Steam 返回 | 含义 | 扩展标记 |
|---|---|---|
| `success: true` | 邀请已发送 | ✓ 已发送邀请 |
| `error: AlreadyFriends` | 已是好友 | 已是好友 |
| `error: InvitePending` | 已发邀请，等对方接受 | 邀请已发 |
| `error: RateLimitExceeded` | 操作太频繁 | ⚠ 限流（自动 30s 重试） |
| `error: ...Blocked` | 对方把你屏蔽 / 你把对方屏蔽 | 被屏蔽（自动进黑名单） |
| HTTP 状态非 200 | 网络错误或 Steam 改版 | 失败 |

---

## 📁 项目结构

```
steam-friend-picker/
├── manifest.json                # MV3 配置
├── .gitignore                   # 隐私红线：阻止备份/日志/导出文件
├── background/
│   └── service-worker.js        # Steam API 调用、调度、vanity 解析、好友快照
├── content/
│   ├── common.js                # Steam ID 提取正则（3 种格式）
│   ├── xiaoheihe.js             # 小黑盒文章页注入（评论区扫描）
│   ├── steam-profile.js         # Steam 个人主页注入（好友列表懒加载）
│   ├── steam-group.js           # Steam 群组成员注入（自动翻页）
│   └── steam-search.js          # Steam 搜索结果注入
├── popup/
│   ├── popup.html               # 5 Tab 布局
│   ├── popup.css                # 双主题（CSS 变量）
│   └── popup.js                 # 主控
├── icons/
│   ├── 16.png
│   ├── 48.png
│   └── 128.png
└── README.md                    # 本文件
```

---

## 🔑 关键实现细节

### 1. Steam 加好友接口
```
POST https://steamcommunity.com/actions/AddFriendAjax
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Cookie: sessionid=<...>; steamLoginSecure=<...>  （浏览器自动带）

Body:
  sessionid=<...>&steamid=<目标 Steam64>&accept_invite=0
```
- **响应**：`{ "success": true }` 或 `{ "success": false, "error": "RateLimitExceeded" }`
- `Origin: https://steamcommunity.com` 与 `Referer` 必须正确，否则可能被拒

### 2. Vanity URL → Steam64
走 `GET https://steamcommunity.com/id/<vanity>/?xml=1` 拿 `<steamID64>...</steamID64>`。XML 接口相对稳定，跨域允许。

### 3. 好友列表抓取（用于好友对照）
- 优先从 `/my/` 页面解析当前用户的 steamid
- 再翻页 `GET /profiles/<id>/friends/?p=N` 抓全部好友
- 入库到 `sfp_known_friends`，入队时跳过

### 4. 个人主页元数据（用于未来扩展）
`GET /profiles/<id>/?xml=1` 拿 `<steamID>` / `<lastLogoff>` / `<vacBanned>` / `<gameCount>`，缓存 1 小时。可用于「只加最近 30 天登录的」「只加非 VAC 」「只加游戏数 ≥ N 的」等智能筛选（已留 API）。

### 5. Service Worker 限制
MV3 SW 会被频繁休眠，但异步任务里用 `setTimeout` 可在 5 分钟内不被回收。本工具 `runBatch` 跑完就停，无需长心跳。

### 6. 隐私与数据
- 所有数据存 `chrome.storage.local`，**绝不上传任何第三方**
- `chrome.cookies.get` 只读 `sessionid`，不存储
- 仓库 .gitignore 已阻止 CSV 导出 / JSON 备份 / 日志意外提交
- README 不写任何盘符、用户名、绝对路径

---

## 🐛 常见问题

**Q: 抓取按钮没出现？**
A: 等 1~2 秒注入。如果是 Steam 主页，按钮**只在 `/friends/` 路径出现**。群组按钮在 `/groups/<name>/members`，搜索按钮在 `/search/users/`。

**Q: 抓到了 0 个 ID？**
A: 列表里确实没贴 Steam 链接。或 Steam 列表的隐私设置是「仅好友可见」。

**Q: 加好友全部失败，提示「未登录」？**
A: sessionid cookie 过期。重新打开 `https://steamcommunity.com` 登录。

**Q: 大量 `RateLimitExceeded`？**
A: 把间隔调大（15~30 秒），单次最多调到 10~20 人，日配额调到 30。当天被限过流后建议隔天再继续。

**Q: 「抓好友对照」返回 0？**
A: 隐私设置只让好友看到好友列表（最常见的 Steam 默认）。这种情况无法抓取，只能跳过好友对照功能。

**Q: Popup 抓取按钮没反应？**
A: 内容脚本可能没注入。Ctrl+R 刷新目标页面，然后再点扩展按钮。

**Q: 想清空历史重试某个分组？**
A: 历史 Tab 选分组 → 看列表；如要全部清空，点「清空历史」。单条可在队列勾选后点「↻ 重试选中」（实际是清掉历史，下次调度器会重新尝试）。

---

## 🛣️ Roadmap

- [ ] 智能筛选接入个人资料 API（lastlogoff / VAC / gameCount）
- [ ] AES-GCM 加密导出（用户自设密码）
- [ ] 多账号支持（切换 sessionid）
- [ ] GitHub Gist 云同步
- [ ] 群组收割并发翻页优化
- [ ] 加好友前预览（头像 / 昵称 / 当前游戏）

---

## ⚖️ 法律与免责

- 本工具调用的是 Steam 官方公开接口 `AddFriendAjax`，未绕过任何鉴权
- 使用本工具产生的任何后果（账号警告、好友邀请被拒、被屏蔽、临时封号等）由使用者自行承担
- 请遵守 Steam 用户协议，不要用于骚扰、营销、刷号等违规用途
- Steam 与小黑盒均为各自所有方的商标，本项目与它们无任何关联

---

## 📄 License

MIT
