"""Minimal local settings panel for the CUHK AI agent bridge."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk


def application_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parents[1]
    return Path(__file__).resolve().parents[1]


ROOT = application_root()
CONFIG_PATH = ROOT / "config.json"
OPENCLI = ROOT / "bin" / "opencli.cmd"
CODEX_LAUNCHER = ROOT / "bin" / "cuhk-codex-launch.ps1"
CLAUDE_LAUNCHER = ROOT / "bin" / "cuhk-claude-launch.ps1"
GATEWAY = ROOT / "bin" / "cuhk-gateway.cmd"


def enable_dpi_awareness() -> None:
    """Let Windows scale the panel so text stays sharp on high-DPI displays."""
    if sys.platform != "win32":
        return
    try:
        import ctypes

        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:  # older Windows without per-monitor support
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

# Only models that the school web page actually offers are listed here. Each
# entry below was selected successfully on the live page (verified 2026-10-11);
# models the page does not offer (for example Kimi K3 and the GPT 5.6/6 Sol
# entries at that time) fail with "not found in the model dialog" and surface as
# HTTP 502 in the CLI, so they are not selectable here.
MODELS = {
    "glm5.3flash": {"label": "GLM 5.3 Flash（本地版）", "thinking": ["low", "high", "max"]},
    "glm5.3": {"label": "GLM 5.3", "thinking": []},
    "gpt6luna": {"label": "GPT 6 Luna", "thinking": ["none", "low", "medium", "high", "xhigh", "max"]},
    "deepseek-v4.1-flash": {"label": "DeepSeek V4.1 Flash", "thinking": ["none", "high", "max"]},
    "seed2.1pro": {"label": "豆包 Seed 2.1 Pro", "thinking": ["none", "high"]},
    "gemini3.8flash": {"label": "Gemini 3.8 Flash", "thinking": ["low", "high"]},
    "qwen3.8-27b": {"label": "Qwen3.8 27B（本地版）", "thinking": ["none", "low", "medium", "xhigh"]},
}

THINKING_LABELS = {
    "none": "不思考",
    "low": "低",
    "medium": "中",
    "high": "高",
    "xhigh": "超高",
    "max": "极致",
}


def default_config() -> dict[str, object]:
    return {
        "gatewayEnabled": True,
        "model": "glm5.3flash",
        "thinking": "low",
        "workdir": "",
    }


def normalize_config(value: object) -> dict[str, object]:
    source = value if isinstance(value, dict) else {}
    config = default_config()
    config.update(source)
    legacy_enabled = bool(source.get("enabled", True))
    gateway_enabled = bool(source.get("gatewayEnabled", legacy_enabled))
    model = str(config.get("model", ""))
    if model not in MODELS:
        model = "glm5.3flash"
    levels = MODELS[model]["thinking"]
    thinking = config.get("thinking")
    workdir = str(config.get("workdir") or "").strip()
    if workdir and not Path(workdir).is_dir():
        workdir = ""
    if not levels:
        thinking = None
    elif thinking not in levels:
        thinking = levels[0]
    return {
        "gatewayEnabled": gateway_enabled,
        "model": model,
        "thinking": thinking,
        "workdir": workdir,
    }


def load_config() -> dict[str, object]:
    try:
        return normalize_config(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError):
        return default_config()


def save_config(config: dict[str, object]) -> None:
    normalized = normalize_config(config)
    temporary = CONFIG_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(normalized, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(CONFIG_PATH)


class SettingsApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        # Keep every measurement in 96-DPI design units and scale them once, so
        # the panel looks the same size and stays sharp on a scaled display.
        self.scale = 1.0
        try:
            self.scale = max(1.0, root.winfo_fpixels("1i") / 96.0)
        except Exception:
            pass
        self.root.title("CUHK AI 控制面板")
        self.root.geometry(f"{self.px(700)}x{self.px(800)}")
        self.root.resizable(False, False)

        style = ttk.Style(root)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        style.configure(".", font=("Microsoft YaHei UI", 11))
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 20, "bold"))
        style.configure("Section.TLabel", font=("Microsoft YaHei UI", 12, "bold"))
        style.configure("Hint.TLabel", foreground="#4b5563")
        style.configure("Summary.TLabel", foreground="#1d4ed8", font=("Microsoft YaHei UI", 11, "bold"))
        style.configure("Status.TLabel", foreground="#2563eb")
        style.configure("Launch.TButton", font=("Microsoft YaHei UI", 13, "bold"), padding=(self.px(10), self.px(13)))
        style.configure("Small.TButton", padding=(self.px(8), self.px(6)))

        self.config = load_config()
        self.gateway_enabled = tk.BooleanVar(value=bool(self.config["gatewayEnabled"]))
        self.model_label = tk.StringVar(value=MODELS[str(self.config["model"])]["label"])
        self.thinking_label = tk.StringVar()
        self.status = tk.StringVar(value="配置已加载")

        self.workdir_var = tk.StringVar(value=str(self.config.get("workdir") or ""))
        self.summary = tk.StringVar()
        frame = ttk.Frame(root, padding=self.px(24))
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="CUHK AI 控制面板", style="Title.TLabel").pack(anchor="w")
        ttk.Label(
            frame,
            text="模型、思考强度、工作目录都在这里选；换模型立即生效，不用重启。",
            style="Hint.TLabel",
        ).pack(anchor="w", pady=(self.px(6), self.px(16)))

        ttk.Checkbutton(
            frame,
            text="启用 CUHK Gateway",
            variable=self.gateway_enabled,
            command=self._changed,
        ).pack(anchor="w", pady=(0, self.px(14)))

        ttk.Label(frame, text="第一步：选择设置", style="Section.TLabel").pack(anchor="w", pady=(0, self.px(8)))

        form = ttk.Frame(frame)
        form.pack(fill="x")
        ttk.Label(form, text="模型").grid(row=0, column=0, sticky="w", pady=self.px(8), padx=(0, self.px(12)))
        self.model_box = ttk.Combobox(
            form,
            state="readonly",
            width=30,
            textvariable=self.model_label,
            values=[entry["label"] for entry in MODELS.values()],
        )
        self.model_box.grid(row=0, column=1, sticky="ew", pady=self.px(8))
        self.model_box.bind("<<ComboboxSelected>>", self._model_changed)

        ttk.Label(form, text="思考强度").grid(row=1, column=0, sticky="w", pady=self.px(8), padx=(0, self.px(12)))
        self.thinking_box = ttk.Combobox(form, state="readonly", width=30, textvariable=self.thinking_label)
        self.thinking_box.grid(row=1, column=1, sticky="ew", pady=self.px(8))
        self.thinking_box.bind("<<ComboboxSelected>>", self._changed)
        ttk.Label(form, text="工作目录").grid(row=2, column=0, sticky="w", pady=self.px(8), padx=(0, self.px(12)))
        self.workdir_entry = ttk.Entry(form, textvariable=self.workdir_var, state="readonly", width=30)
        self.workdir_entry.grid(row=2, column=1, sticky="we", pady=self.px(8))
        ttk.Button(form, text="浏览…", command=self.choose_workdir).grid(
            row=2, column=2, sticky="w", padx=(self.px(10), 0)
        )
        form.columnconfigure(1, weight=1)

        ttk.Label(frame, textvariable=self.summary, style="Summary.TLabel", justify="left").pack(
            anchor="w", pady=(self.px(10), self.px(4))
        )

        ttk.Separator(frame).pack(fill="x", pady=self.px(14))
        ttk.Label(frame, text="第二步：开始对话", style="Section.TLabel").pack(anchor="w", pady=(0, self.px(6)))
        ttk.Label(
            frame,
            text="第一次用选「开始新对话」；想接着上次聊选「继续上次对话」（这个文件夹还没有对话时会自动开新的）。",
            style="Hint.TLabel",
            wraplength=self.px(640),
            justify="left",
        ).pack(anchor="w", pady=(0, self.px(10)))
        ttk.Button(
            frame,
            text="开始新对话（Codex）",
            style="Launch.TButton",
            command=self.launch_gateway_codex_new,
        ).pack(fill="x", pady=(0, self.px(10)))
        ttk.Button(
            frame,
            text="继续上次对话（Codex）",
            style="Launch.TButton",
            command=self.launch_gateway_codex,
        ).pack(fill="x", pady=(0, self.px(10)))
        ttk.Button(
            frame,
            text="改用 Claude Code 对话",
            style="Launch.TButton",
            command=self.launch_gateway_claude,
        ).pack(fill="x", pady=(0, self.px(14)))

        ttk.Separator(frame).pack(fill="x", pady=(0, self.px(12)))
        ttk.Label(frame, text="第三步：检查状态（可选）", style="Section.TLabel").pack(anchor="w", pady=(0, self.px(8)))
        tools = ttk.Frame(frame)
        tools.pack(fill="x", pady=(0, self.px(10)))
        ttk.Button(tools, text="检查连接", style="Small.TButton", command=self.check_connection).pack(side="left")
        ttk.Button(tools, text="测试所选模型", style="Small.TButton", command=self.check_selected_model).pack(
            side="left", padx=self.px(8)
        )
        ttk.Button(tools, text="打开工作目录", style="Small.TButton", command=self.open_workdir).pack(side="left")
        ttk.Button(tools, text="停止 Gateway", style="Small.TButton", command=self.stop_gateway).pack(
            side="left", padx=self.px(8)
        )
        ttk.Button(tools, text="关闭", style="Small.TButton", command=root.destroy).pack(side="right")
        ttk.Label(frame, textvariable=self.status, style="Status.TLabel", wraplength=self.px(640), justify="left").pack(
            anchor="w"
        )

        self._refresh_thinking()
        self._refresh_enabled_state()
        self._refresh_summary()

    def px(self, value: int) -> int:
        """Scale a 96-DPI design measurement to this display."""
        return int(round(value * self.scale))

    def _selected_model(self) -> str:
        selected = self.model_label.get()
        return next((key for key, value in MODELS.items() if value["label"] == selected), "glm5.3flash")

    def _refresh_thinking(self) -> None:
        model = self._selected_model()
        levels = MODELS[model]["thinking"]
        if not levels:
            self.thinking_box.configure(values=["/"], state="disabled")
            self.thinking_label.set("/")
            return
        labels = [THINKING_LABELS[level] for level in levels]
        self.thinking_box.configure(values=labels, state="readonly" if self.gateway_enabled.get() else "disabled")
        current = self.config.get("thinking") if self.config.get("model") == model else None
        self.thinking_label.set(THINKING_LABELS.get(str(current), labels[0]))

    def _refresh_enabled_state(self) -> None:
        state = "readonly" if self.gateway_enabled.get() else "disabled"
        self.model_box.configure(state=state)
        if MODELS[self._selected_model()]["thinking"]:
            self.thinking_box.configure(state=state)

    def _refresh_summary(self) -> None:
        model = self._selected_model()
        label = MODELS[model]["label"]
        levels = MODELS[model]["thinking"]
        thinking = self.thinking_label.get() if levels else "固定"
        directory = self.workdir_var.get().strip() or f"未选择（默认使用 {ROOT}）"
        self.summary.set(f"当前：{label} · 思考 {thinking}\n目录：{directory}")

    def _model_changed(self, _event: object = None) -> None:
        self.config["model"] = self._selected_model()
        self.config["thinking"] = None
        self._refresh_thinking()
        self._changed()

    def _changed(self, _event: object = None) -> None:
        self._refresh_enabled_state()
        self._refresh_summary()
        self.save()

    def _current_config(self) -> dict[str, object]:
        model = self._selected_model()
        reverse = {label: key for key, label in THINKING_LABELS.items()}
        thinking = reverse.get(self.thinking_label.get()) if MODELS[model]["thinking"] else None
        return {
            "gatewayEnabled": self.gateway_enabled.get(),
            "model": model,
            "thinking": thinking,
            "workdir": self.workdir_var.get().strip(),
        }

    def save(self) -> None:
        try:
            self.config = normalize_config(self._current_config())
            save_config(self.config)
            gateway = "开启" if self.config["gatewayEnabled"] else "关闭"
            self.status.set(f"已保存 · Gateway {gateway}")
        except OSError as error:
            messagebox.showerror("保存失败", str(error))

    def choose_workdir(self) -> None:
        initial = self.workdir_var.get().strip()
        if not initial or not Path(initial).is_dir():
            initial = str(ROOT)
        chosen = filedialog.askdirectory(title="选择工作目录", initialdir=initial, parent=self.root)
        if chosen:
            self.workdir_var.set(str(Path(chosen)))
            self.save()
            self.status.set("工作目录已保存")


    def _run(self, arguments: list[str], timeout: int = 30) -> subprocess.CompletedProcess:
        return subprocess.run(
            [str(OPENCLI), *arguments],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )

    @staticmethod
    def _error_message(result: subprocess.CompletedProcess) -> str:
        for line in (result.stderr or result.stdout or "").splitlines():
            if "message:" in line:
                return line.split("message:", 1)[1].strip()
        return ""

    def check_connection(self) -> None:
        self.status.set("正在检查连接……")
        self.root.update_idletasks()
        try:
            doctor = self._run(["doctor"], timeout=25)
            if "[OK] Extension: connected" not in doctor.stdout or "[OK] Connectivity" not in doctor.stdout:
                self.status.set("❌ 没有连上浏览器：请打开 Chrome，并确认 OpenCLI 扩展已启用。")
                return
            page = self._run(["cuhk-ai", "status", "--format", "json"])
            entries = json.loads(page.stdout or "[]")
            entry = entries[0] if entries else {}
            if entry.get("login") == "Yes":
                self.status.set(f"✅ 已连接学校网页（已登录）· 网页当前模型：{entry.get('model') or '未知'}")
            else:
                self.status.set("⚠️ 浏览器已连接，但学校网页还没登录：请在 Chrome 打开 https://ai.cuhk.edu.cn 登录。")
        except json.JSONDecodeError:
            self.status.set("⚠️ 浏览器已连接，但读不到学校网页状态，请在 Chrome 里刷新一次页面。")
        except (OSError, subprocess.TimeoutExpired) as error:
            self.status.set(f"❌ 检查失败：{error}")

    def check_selected_model(self) -> None:
        """Select the chosen model on the live page, so an unavailable model is
        reported here instead of surfacing later as an HTTP 502 in the CLI."""
        label = str(MODELS[self._selected_model()]["label"])
        self.status.set(f"正在网页上检查「{label}」是否可用……")
        self.root.update_idletasks()
        try:
            result = self._run(["cuhk-ai", "model", label], timeout=90)
            if result.returncode == 0:
                self.status.set(f"✅ 模型「{label}」可用，已在网页上为你选中。")
            else:
                detail = self._error_message(result) or "网页的模型列表里没有它"
                self.status.set(f"❌ 模型「{label}」当前不可用（{detail}）。请换一个模型再试。")
        except (OSError, subprocess.TimeoutExpired) as error:
            self.status.set(f"❌ 检查失败：{error}")

    def open_workdir(self) -> None:
        target = self.workdir_var.get().strip() or str(ROOT)
        if not Path(target).is_dir():
            messagebox.showerror("打开失败", f"目录不存在：\n{target}")
            return
        try:
            os.startfile(target)
            self.status.set(f"已在文件资源管理器中打开：{target}")
        except OSError as error:
            messagebox.showerror("打开失败", str(error))

    def launch_gateway_codex_new(self) -> None:
        self._launch_gateway(CODEX_LAUNCHER, "Codex", "-New")

    def launch_gateway_codex(self) -> None:
        self._launch_gateway(CODEX_LAUNCHER, "Codex")

    def launch_gateway_claude(self) -> None:
        self._launch_gateway(CLAUDE_LAUNCHER, "Claude Code")

    def stop_gateway(self) -> None:
        self.status.set("正在停止 Gateway……")
        self.root.update_idletasks()
        try:
            result = subprocess.run(
                [str(GATEWAY), "stop"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
            )
            if result.returncode == 0:
                self.status.set("Gateway 已停止。下次点上面的按钮会自动重新启动。")
            else:
                self.status.set(f"停止失败：{(result.stderr or result.stdout).strip()[:120]}")
        except (OSError, subprocess.TimeoutExpired) as error:
            self.status.set(f"停止失败：{error}")

    def _launch_gateway(self, launcher: Path, client: str, *extra_args: str) -> None:
        try:
            self.gateway_enabled.set(True)
            self.save()
            workdir = str(self.config.get("workdir") or ROOT)
            subprocess.Popen(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(launcher),
                    *extra_args,
                ],
                cwd=workdir,
                creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
            )
            self.status.set(f"已打开 {client} 窗口 · {workdir}")
        except OSError as error:
            messagebox.showerror("启动失败", str(error))


def main() -> None:
    if "--print-config" in sys.argv:
        print(json.dumps(load_config(), ensure_ascii=False, indent=2))
        return
    enable_dpi_awareness()
    root = tk.Tk()
    SettingsApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
