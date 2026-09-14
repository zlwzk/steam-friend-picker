# Steam 好友收割机 v1.3.2 · 内部维护版（界面数值输入规范）

## 摘要

- **本版没有功能改动**：抓取、去重、过滤、速率、时段、日配额、备份、更新链路全部与 v1.3.1 一致。
- 起因是把「界面数值输入的规矩」固化成了开发规则（仓库里新增
  `.codebuddy/rules/ui-numeric-input/RULE.mdc`），顺手把扩展的界面按这条规矩逐项复核了一遍，
  结论是**本来就全部合规**，因此**没有改动任何界面代码**。
- 版本号 `1.3.1 → 1.3.2`，作用是让版本号与仓库状态保持一致。
  **对使用者来说没有必须升级的理由**，不升级也能继续正常用。

## 复核结论：扩展界面本来就合规

| 位置 | 控件 | 单位写法 | 结论 |
| --- | --- | --- | --- |
| 设置 → 随机间隔 | `<input type="number" min="2" max="120">` / `<input type="number" min="2" max="180">` | 框外文本「~」与「秒」 | 合规：框内只有数字 |
| 设置 → 单次上限 | `<input type="number" min="1" max="200">` | 框外「人」 | 合规 |
| 设置 → 每日配额 | `<input type="number" min="0" max="500">` | 框外「人（0 = 不限）」 | 合规 |
| 设置 → 限流重试次数 | `<input type="number" min="0" max="10">` | 框外「次」 | 合规 |
| 设置 → 时段起止 | `<input type="number" min="0" max="23">` / `min="1" max="24"` | 框外「点运行」 | 合规 |
| 设置 → 检查更新间隔 | `<input type="number" min="1" max="168">` | 框外「小时查一次」 | 合规 |
| 队列/日志搜索、黑名单/白名单粘贴 | `<input type="text">` | — | 合规：本来就是文本输入，不是数值参数 |

- 全部数值参数都带 `min` / `max` 与有效数字默认值（`8`、`15`、`30`、`50`、`3`、`6`），
  没有 `setSuffix` 式的「单位塞进框内」，也没有把说明文案当初始值；
- 复核方式：全局搜索 `<input`、`type="number"`、`placeholder`，逐个确认控件类型、单位位置与默认值。

## 文件变更

- `.codebuddy/rules/ui-numeric-input/RULE.mdc` — 新增开发规则（UI 数值输入规范）。
- `manifest.json` — 版本号 1.3.1 → 1.3.2。
- `README.md` — 标题版本行同步。
- `_release_notes_v1.3.2.md` — 本公告。

扩展的运行代码（`background/`、`content/`、`popup/`、`update/`）**零改动**。
打包白名单不含 `.codebuddy/`，所以规则文件**不会**进入发给用户的 zip。

## 验证情况

- `node --check` 通过；
- `node _package_zip.js`（白名单打包）、`node _smoke_friendcode.js`（好友代码换算用例）、
  `node _smoke_unzip.js`（真实 zip 解压）、`node _smoke_popup.js`（stub DOM 真实执行 popup.js 顶层 + init）
  四个冒烟全部通过；
- `node _dryrun_all_features.js` 全功能干跑通过。
