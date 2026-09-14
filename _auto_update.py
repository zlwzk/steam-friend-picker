#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Steam 好友收割机 — 桌面更新器（可视化 GUI + CLI 双模式）

用法：
  双击桌面 update.bat            -> GUI 模式（pythonw 启动，无黑框）
  python _auto_update.py         -> 自动选择（有桌面环境走 GUI）
  python _auto_update.py --cli   -> 命令行模式
  python _auto_update.py --force -> 即使已是最新也强制重装（修复损坏）

流程（GUI 中可视化展示为四步）：
  1) 检查更新   拉 GitHub API latest release，比对桌面副本 manifest version
  2) 下载更新包 优先 release asset（api.github.com -> objects.githubusercontent.com），
                失败退回 codeload zipball；分块下载显示百分比
  3) 解压覆盖   白名单 7 项；先解压验证再原子替换（旧目录 rename .old，失败可回滚）
  4) 完成刷新   自动打开 edge://extensions，用户点一下「重新加载」即完成

隐私：不写死盘符 / 用户名，用 USERPROFILE 环境变量定位桌面。
"""

import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

REPO = "zlwzk/steam-friend-picker"
API_LATEST = f"https://api.github.com/repos/{REPO}/releases/latest"
UA = "steam-friend-picker-updater/1.1"

# 同步到桌面副本时只搬运这些（与 _sync_to_desktop.py / asset 打包白名单一致）
INCLUDE = [
    "manifest.json",
    ".gitignore",
    "README.md",
    "background",
    "content",
    "popup",
    "icons",
    "update",
]

STEPS = ["check", "download", "apply", "done"]
STEP_NAMES = {"check": "检查更新", "download": "下载更新包", "apply": "解压覆盖", "done": "完成刷新"}


# ==================== 工具 ====================

def desktop_root() -> Path:
    if os.name == "nt":
        base = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    else:
        base = os.environ.get("HOME") or os.path.expanduser("~")
    return Path(base) / "Desktop"


def desktop_copy() -> Path:
    return desktop_root() / "steam-friend-picker"


def get_local_version() -> str | None:
    mf = desktop_copy() / "manifest.json"
    if not mf.exists():
        return None
    try:
        return json.loads(mf.read_text(encoding="utf-8")).get("version")
    except Exception:
        return None


def cmp_ver(a: str, b: str) -> int:
    """semver 比较；返回 -1 / 0 / 1。"""
    def to_tuple(v: str):
        return tuple(int(x) for x in str(v).lstrip("v").split("."))
    ta, tb = to_tuple(a), to_tuple(b)
    return (ta > tb) - (ta < tb)


def http_get_json(url: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def human_size(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / 1024 / 1024:.1f} MB"
    return f"{n / 1024:.1f} KB"


# ==================== 更新流程（UI 无关） ====================

class Updater:
    """执行更新流程，通过回调上报进度。回调在 worker 线程触发，UI 侧自行调度。

    回调签名：
      on_log(msg, level)        level ∈ info / ok / warn / err
      on_step(name, state)      name 见 STEPS；state ∈ pending / active / done / error
      on_progress(pct, text)    pct 0~100，text 如 "1.2 MB / 72.9 KB/s"
      on_check_done(info)       info: dict(tag, latest, current, has_update, date, notes, release_url)
    """

    def __init__(self, on_log=None, on_step=None, on_progress=None, on_check_done=None):
        self.on_log = on_log or (lambda m, l="info": None)
        self.on_step = on_step or (lambda n, s: None)
        self.on_progress = on_progress or (lambda p, t: None)
        self.on_check_done = on_check_done or (lambda i: None)

    # ---------- 1) 检查 ----------

    def check(self) -> dict:
        self.on_step("check", "active")
        cur = get_local_version()
        self.on_log(f"当前桌面副本版本：{cur or '(未安装/无 manifest)'}", "info")
        self.on_log(f"正在查询 GitHub 最新 release …", "info")
        try:
            latest = http_get_json(API_LATEST)
        except Exception as e:
            self.on_step("check", "error")
            self.on_log(f"检查失败：{e}", "err")
            raise

        tag = latest.get("tag_name", "?")
        latest_ver = tag.lstrip("v")
        published = latest.get("published_at", "")
        date = published[:10] if published else ""
        notes = (latest.get("body") or "").strip()
        release_url = latest.get("html_url") or ""

        # 下载源：优先 asset（干净布局 + 白名单打包），退回 zipball
        asset = None
        for a in latest.get("assets", []) or []:
            name = a.get("name", "")
            if name.endswith(".zip") and "steam-friend-picker" in name:
                asset = {"id": a.get("id"), "name": name, "url": a.get("browser_download_url")}
                break

        info = {
            "tag": tag,
            "latest": latest_ver,
            "current": cur,
            "has_update": bool(cur and cmp_ver(latest_ver, cur) > 0) or not cur,
            "date": date,
            "notes": notes,
            "release_url": release_url,
            "asset": asset,
            "zipball_api": latest.get("zipball_url"),
        }
        if not cur:
            self.on_log(f"最新 release：v{latest_ver}（本地未检测到副本，将完整安装）", "ok")
        elif info["has_update"]:
            self.on_log(f"发现新版本：v{cur} → v{latest_ver}（{date} 发布）", "ok")
        else:
            self.on_log(f"已是最新版本 v{cur}", "ok")
        self.on_step("check", "done")
        self.on_check_done(info)
        return info

    # ---------- 2) 下载 ----------

    def download(self, info: dict) -> Path:
        self.on_step("download", "active")
        self.on_progress(0, "准备下载…")

        candidates = []
        if info.get("asset"):
            # asset 走 api.github.com（Accept octet-stream 会 302 到 objects.githubusercontent.com）
            candidates.append((
                f"https://api.github.com/repos/{REPO}/releases/assets/{info['asset']['id']}",
                info["asset"]["name"],
                {"Accept": "application/octet-stream"},
            ))
        if info.get("zipball_api"):
            candidates.append((info["zipball_api"], "zipball.zip", {}))

        last_err = None
        for url, name, extra_headers in candidates:
            try:
                return self._download_one(url, name, extra_headers)
            except Exception as e:
                last_err = e
                self.on_log(f"下载源失败（{name}）：{e}", "warn")
                self.on_progress(0, "换下一个下载源…")

        self.on_step("download", "error")
        self.on_log(f"所有下载源均失败：{last_err}", "err")
        raise RuntimeError(f"下载失败：{last_err}")

    def _download_one(self, url: str, name: str, extra_headers: dict) -> Path:
        headers = {"User-Agent": UA}
        headers.update(extra_headers)
        req = urllib.request.Request(url, headers=headers)
        self.on_log(f"开始下载：{name}", "info")

        with urllib.request.urlopen(req, timeout=60) as r:
            total = int(r.headers.get("Content-Length") or 0)
            path = Path(tempfile.gettempdir()) / f"sfp_update_{int(time.time())}.zip"
            done = 0
            t0 = time.time()
            with open(path, "wb") as f:
                while True:
                    chunk = r.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if total:
                        pct = min(99, done * 100 // total)
                        speed = done / max(time.time() - t0, 0.001)
                        self.on_progress(pct, f"{human_size(done)} / {human_size(total)} · {human_size(int(speed))}/s")
                    else:
                        self.on_progress(50, f"{human_size(done)}（大小未知）")

        self.on_progress(100, f"下载完成 · {human_size(done)}")
        self.on_log(f"下载完成：{human_size(done)}", "ok")
        self.on_step("download", "done")
        return path

    # ---------- 3) 解压 + 原子替换 ----------

    def apply(self, zip_path: Path, target: Path | None = None) -> None:
        """解压白名单覆盖桌面副本。target 仅测试用（默认真实桌面副本）。"""
        self.on_step("apply", "active")
        dst = target or desktop_copy()

        tmp = Path(tempfile.mkdtemp(prefix="sfp_extract_"))
        try:
            self.on_log("解压更新包…", "info")
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(tmp)

            # 布局识别：asset zip 顶层即 manifest.json；API zipball 顶层是 <repo>-<sha>/
            src = tmp
            if not (src / "manifest.json").exists():
                dirs = [p for p in src.iterdir() if p.is_dir()]
                if len(dirs) == 1 and (dirs[0] / "manifest.json").exists():
                    src = dirs[0]
                else:
                    raise RuntimeError("更新包布局无法识别（缺 manifest.json）")

            new_ver = json.loads((src / "manifest.json").read_text(encoding="utf-8")).get("version", "?")

            # 原子替换：旧目录 → .old；成功删 .old，失败回滚
            backup = dst.with_name(dst.name + ".old")
            if backup.exists():
                shutil.rmtree(backup, ignore_errors=True)
            if dst.exists():
                dst.rename(backup)

            try:
                dst.mkdir(parents=True)
                copied = 0
                for name in INCLUDE:
                    sp, dp = src / name, dst / name
                    if not sp.exists():
                        self.on_log(f"  ! 更新包缺项，跳过：{name}", "warn")
                        continue
                    if sp.is_dir():
                        shutil.copytree(sp, dp)
                        copied += sum(len(fs) for _, _, fs in os.walk(dp))
                    else:
                        shutil.copy2(sp, dp)
                        copied += 1
            except Exception:
                if dst.exists():
                    shutil.rmtree(dst, ignore_errors=True)
                if backup.exists():
                    backup.rename(dst)
                raise

            if backup.exists():
                shutil.rmtree(backup, ignore_errors=True)
            self.on_log(f"已覆盖桌面副本（{copied} 个文件）· v{new_ver}", "ok")
            self.on_step("apply", "done")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            try:
                zip_path.unlink(missing_ok=True)
            except Exception:
                pass

    # ---------- 完整流程 ----------

    def run(self, force: bool = False, target: Path | None = None) -> bool:
        """跑完整流程。返回是否执行了更新。"""
        info = self.check()
        if not info["has_update"] and not force:
            self.on_step("done", "done")
            return False
        if not info["has_update"] and force:
            self.on_log("强制重装模式：忽略版本比对，直接下载最新 release", "warn")
        zip_path = self.download(info)
        self.apply(zip_path, target=target)

        self.on_step("done", "active")
        self.on_log("更新完成！接下来请在 Edge 扩展页点一下「重新加载」↻", "ok")
        self.on_step("done", "done")
        return True


def open_edge_extensions() -> None:
    """拉起 Edge 扩展页。失败静默（用户可手动打开）。"""
    try:
        if os.name == "nt":
            os.startfile("microsoft-edge:edge://extensions")  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            os.system('open "microsoft-edge:edge://extensions"')
        else:
            subprocess.Popen(["xdg-open", "https://extensions"])
    except Exception:
        pass


# ==================== CLI 模式 ====================

def run_cli(force: bool) -> int:
    # Windows 控制台默认 GBK，遇 ↻ 等字符会 print 崩溃（曾把更新成功误报为失败）
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass

    def log(msg, level="info"):
        prefix = {"ok": "[OK]", "warn": "[!]", "err": "[X]", "info": "   "}
        print(f"  {prefix.get(level, '   ')} {msg}", flush=True)

    def step(name, state):
        pass

    def progress(pct, text):
        print(f"\r  -> {pct:3d}%  {text}          ", end="", flush=True)
        if pct >= 100:
            print()

    def check_done(info):
        pass

    print("=== Steam 好友收割机 · 桌面更新（CLI）===")
    print(f"  target: {desktop_copy()}")
    up = Updater(on_log=log, on_step=step, on_progress=progress, on_check_done=check_done)
    try:
        updated = up.run(force=force)
    except Exception as e:
        print(f"\n  更新失败：{e}")
        return 3

    if updated:
        print()
        print("  Next: 打开 edge://extensions 点一下「重新加载」。")
        open_edge_extensions()
    return 0


# ==================== GUI 模式 ====================

# 深色配色（与扩展 popup 暗色主题一致）
C_BG = "#1e1f24"
C_CARD = "#26272e"
C_CARD2 = "#2c2d35"
C_FG = "#e8e8ea"
C_FG2 = "#9a9ba3"
C_ACCENT = "#4f8cff"
C_OK = "#3fb96f"
C_WARN = "#f0a24b"
C_ERR = "#e05555"
C_BORDER = "#3a3b44"


def run_gui(force: bool = False) -> int:
    import tkinter as tk
    from tkinter import ttk

    root = tk.Tk()
    root.title("Steam 好友收割机 · 更新器")
    root.configure(bg=C_BG)
    root.geometry("480x600")
    root.minsize(480, 560)

    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except Exception:
        pass
    style.configure("TProgressbar", troughcolor=C_CARD2, background=C_ACCENT,
                    bordercolor=C_BORDER, lightcolor=C_ACCENT, darkcolor=C_ACCENT, thickness=10)
    style.configure("TCheckbutton", background=C_BG, foreground=C_FG, focusmap={},
                    font=("Microsoft YaHei UI", 10))
    style.map("TCheckbutton", background=[("active", C_BG)])

    # ---------- 事件队列（worker -> UI） ----------
    ui_q: "queue.Queue[tuple]" = queue.Queue()

    def poll():
        try:
            while True:
                item = ui_q.get_nowait()
                kind = item[0]
                if kind == "log":
                    append_log(item[1], item[2])
                elif kind == "step":
                    set_step(item[1], item[2])
                elif kind == "progress":
                    set_progress(item[1], item[2])
                elif kind == "check_done":
                    on_check_done_ui(item[1])
                elif kind == "flow_done":
                    on_flow_done_ui(item[1], item[2])
        except queue.Empty:
            pass
        root.after(80, poll)

    # ---------- 布局 ----------

    # 头部
    header = tk.Frame(root, bg=C_BG)
    header.pack(fill="x", padx=18, pady=(16, 6))
    tk.Label(header, text="🎮 Steam 好友收割机", bg=C_BG, fg=C_FG,
             font=("Microsoft YaHei UI", 15, "bold")).pack(side="left")
    tk.Label(header, text="更新器", bg=C_BG, fg=C_FG2,
             font=("Microsoft YaHei UI", 11)).pack(side="left", padx=(8, 0), pady=(5, 0))

    # 版本卡片
    card = tk.Frame(root, bg=C_CARD, highlightthickness=1, highlightbackground=C_BORDER)
    card.pack(fill="x", padx=18, pady=(8, 10))

    ver_row = tk.Frame(card, bg=C_CARD)
    ver_row.pack(pady=(14, 4))
    lbl_cur = tk.Label(ver_row, text="v?", bg=C_CARD, fg=C_FG2, font=("Microsoft YaHei UI", 18, "bold"))
    lbl_cur.pack(side="left")
    lbl_arrow = tk.Label(ver_row, text="  →  ", bg=C_CARD, fg=C_FG2, font=("Microsoft YaHei UI", 15))
    lbl_arrow.pack(side="left")
    lbl_latest = tk.Label(ver_row, text="…", bg=C_CARD, fg=C_ACCENT, font=("Microsoft YaHei UI", 18, "bold"))
    lbl_latest.pack(side="left")

    lbl_sub = tk.Label(card, text="正在检查更新…", bg=C_CARD, fg=C_FG2, font=("Microsoft YaHei UI", 10))
    lbl_sub.pack(pady=(0, 12))

    # 步骤区
    steps_card = tk.Frame(root, bg=C_CARD, highlightthickness=1, highlightbackground=C_BORDER)
    steps_card.pack(fill="x", padx=18, pady=(0, 10))

    step_widgets = {}
    for i, name in enumerate(STEPS):
        row = tk.Frame(steps_card, bg=C_CARD)
        row.pack(fill="x", padx=14, pady=5)
        icon = tk.Label(row, text="○", bg=C_CARD, fg=C_FG2, font=("Microsoft YaHei UI", 12), width=2)
        icon.pack(side="left")
        text = tk.Label(row, text=STEP_NAMES[name], bg=C_CARD, fg=C_FG2,
                        font=("Microsoft YaHei UI", 11))
        text.pack(side="left")
        extra = tk.Label(row, text="", bg=C_CARD, fg=C_FG2, font=("Microsoft YaHei UI", 9))
        extra.pack(side="right")
        step_widgets[name] = (icon, text, extra)

    # 下载进度条
    prog_frame = tk.Frame(root, bg=C_BG)
    prog_frame.pack(fill="x", padx=18, pady=(0, 4))
    prog = ttk.Progressbar(prog_frame, mode="determinate", maximum=100)
    prog.pack(fill="x")
    prog_text = tk.Label(root, text="", bg=C_BG, fg=C_FG2, font=("Microsoft YaHei UI", 9))
    prog_text.pack(anchor="w", padx=18)

    # 按钮区
    btn_frame = tk.Frame(root, bg=C_BG)
    btn_frame.pack(fill="x", padx=18, pady=(10, 4))

    def make_btn(text, bg, fg, cmd):
        b = tk.Label(btn_frame, text=text, bg=bg, fg=fg, cursor="hand2",
                     font=("Microsoft YaHei UI", 11, "bold"), padx=12, pady=6)
        b.bind("<Button-1>", lambda e: cmd())
        b.bind("<Enter>", lambda e: b.configure(bg=C_CARD2 if bg == C_CARD else bg))
        b.bind("<Leave>", lambda e: b.configure(bg=bg))
        return b

    btn_state = {"running": False, "has_update": False, "checked": False}

    def refresh_buttons():
        if btn_state["running"]:
            btn_update.configure(text="⏳ 更新中…", bg=C_CARD, fg=C_FG2)
            btn_recheck.configure(text="⏳ 请稍候", bg=C_CARD, fg=C_FG2)
            btn_force.configure(bg=C_CARD, fg=C_FG2)
        else:
            btn_recheck.configure(text="↻ 重新检查", bg=C_CARD, fg=C_FG)
            btn_force.configure(bg=C_CARD, fg=C_FG)
            if btn_state["has_update"]:
                btn_update.configure(text=f"🚀 一键更新到 v{latest_info['latest']}", bg=C_ACCENT, fg="#ffffff")
            elif btn_state["checked"]:
                btn_update.configure(text="✓ 已是最新", bg=C_CARD, fg=C_FG2)
            else:
                btn_update.configure(text="🚀 一键更新", bg=C_CARD, fg=C_FG2)

    btn_update = make_btn("🚀 一键更新", C_ACCENT, "#ffffff", lambda: None)
    btn_update.pack(side="left")
    btn_recheck = make_btn("↻ 重新检查", C_CARD, C_FG, lambda: None)
    btn_recheck.pack(side="left", padx=(8, 0))
    btn_force = make_btn("🔧 强制重装", C_CARD, C_FG, lambda: None)
    btn_force.pack(side="right")

    # 自动打开扩展页开关
    chk_var = tk.BooleanVar(value=True)
    chk = tk.Checkbutton(root, text="更新完自动打开 Edge 扩展页（还需手动点一下「重新加载」↻）",
                         variable=chk_var, bg=C_BG, fg=C_FG2,
                         activebackground=C_BG, activeforeground=C_FG,
                         selectcolor=C_CARD2, font=("Microsoft YaHei UI", 9))
    chk.pack(anchor="w", padx=18, pady=(2, 4))

    # 日志区
    log_card = tk.Frame(root, bg=C_CARD, highlightthickness=1, highlightbackground=C_BORDER)
    log_card.pack(fill="both", expand=True, padx=18, pady=(6, 14))
    log_text = tk.Text(log_card, bg=C_CARD, fg=C_FG2, insertbackground=C_FG,
                       font=("Consolas", 9), relief="flat", state="disabled",
                       wrap="word", height=9)
    log_text.pack(fill="both", expand=True, padx=8, pady=8)
    for tag, color in (("ok", C_OK), ("warn", C_WARN), ("err", C_ERR), ("info", C_FG2)):
        log_text.tag_configure(tag, foreground=color)

    def append_log(msg, level="info"):
        ts = time.strftime("%H:%M:%S")
        log_text.configure(state="normal")
        log_text.insert("end", f"[{ts}] {msg}\n", level)
        log_text.see("end")
        log_text.configure(state="disabled")

    def set_step(name, state):
        icon, text, extra = step_widgets[name]
        icons = {"pending": ("○", C_FG2), "active": ("◐", C_ACCENT),
                 "done": ("✓", C_OK), "error": ("✗", C_ERR)}
        ch, color = icons.get(state, ("○", C_FG2))
        icon.configure(text=ch, fg=color)
        text.configure(fg=C_FG if state in ("active", "done") else C_FG2)

    def set_progress(pct, text):
        prog["value"] = pct
        prog_text.configure(text=text)

    latest_info = {}

    def on_check_done_ui(info):
        nonlocal latest_info
        latest_info = info
        btn_state["checked"] = True
        btn_state["has_update"] = info["has_update"]
        lbl_cur.configure(text=f"v{info['current'] or '?'}")
        if info["has_update"]:
            lbl_arrow.configure(fg=C_WARN)
            lbl_latest.configure(text=f"v{info['latest']}", fg=C_OK)
            lbl_sub.configure(text=f"🆕 有新版本 · {info['date'] or '最新'} 发布", fg=C_WARN)
        else:
            lbl_arrow.configure(fg=C_FG2)
            lbl_latest.configure(text=f"v{info['latest']}", fg=C_OK)
            lbl_sub.configure(text="✓ 已是最新版本 · 可用「强制重装」修复损坏", fg=C_FG2)
        refresh_buttons()

    def on_flow_done_ui(updated, ok):
        btn_state["running"] = False
        refresh_buttons()
        if updated and ok and chk_var.get():
            open_edge_extensions()
        if not ok:
            root.bell()

    # ---------- worker ----------

    def make_updater():
        return Updater(
            on_log=lambda m, l="info": ui_q.put(("log", m, l)),
            on_step=lambda n, s: ui_q.put(("step", n, s)),
            on_progress=lambda p, t: ui_q.put(("progress", p, t)),
            on_check_done=lambda i: ui_q.put(("check_done", i)),
        )

    def run_flow(kind: str):
        """kind ∈ check / update / force"""
        if btn_state["running"]:
            return
        btn_state["running"] = True
        refresh_buttons()
        # 重置步骤显示
        for name in STEPS:
            set_step(name, "pending")
        set_progress(0, "")
        if kind == "check":
            append_log("手动重新检查…", "info")

        def worker():
            up = make_updater()
            try:
                if kind == "check":
                    up.check()
                    updated, ok = False, True
                else:
                    updated = up.run(force=(kind == "force"))
                    ok = True
            except Exception as e:
                updated, ok = False, False
                ui_q.put(("log", f"失败：{e}", "err"))
            ui_q.put(("flow_done", updated, ok))

        threading.Thread(target=worker, daemon=True).start()

    def on_update_click():
        if btn_state["running"] or not btn_state["has_update"]:
            return
        run_flow("update")

    def on_force_click():
        if btn_state["running"]:
            return
        run_flow("force")

    # 重新绑定按钮命令（make_btn 创建时是占位）
    btn_update.unbind("<Button-1>"), btn_update.bind("<Button-1>", lambda e: on_update_click())
    btn_recheck.unbind("<Button-1>"), btn_recheck.bind("<Button-1>", lambda e: run_flow("check"))
    btn_force.unbind("<Button-1>"), btn_force.bind("<Button-1>", lambda e: on_force_click())

    # 启动：自动检查
    root.after(120, lambda: run_flow("check"))
    root.after(80, poll)
    root.protocol("WM_DELETE_WINDOW", root.destroy)

    refresh_buttons()
    root.mainloop()
    return 0


# ==================== 入口 ====================

def main() -> int:
    ap = argparse.ArgumentParser(description="Steam 好友收割机 · 桌面更新器")
    ap.add_argument("--cli", action="store_true", help="命令行模式（无 GUI）")
    ap.add_argument("--gui", action="store_true", help="强制 GUI 模式")
    ap.add_argument("--force", action="store_true", help="已是最新也强制重装（修复损坏）")
    args = ap.parse_args()

    if args.cli:
        return run_cli(args.force)

    # 默认 GUI；tkinter 不可用时回 CLI
    try:
        import tkinter  # noqa: F401
    except Exception:
        if args.gui:
            try:
                import ctypes
                ctypes.windll.user32.MessageBoxW(
                    0, "当前 Python 缺少 tkinter，无法启动图形界面。\n请用命令行模式：python _auto_update.py --cli",
                    "Steam 好友收割机 · 更新器", 0x10)
            except Exception:
                pass
            return 1
        print("[!] 当前 Python 缺少 tkinter，回退命令行模式")
        return run_cli(args.force)

    return run_gui(args.force)


if __name__ == "__main__":
    sys.exit(main())
