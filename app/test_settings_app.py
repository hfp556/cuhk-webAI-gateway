from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import settings_app


class FakeVar:
    def __init__(self, value: object) -> None:
        self.value = value

    def get(self) -> object:
        return self.value

    def set(self, value: object) -> None:
        self.value = value


class SettingsConfigTests(unittest.TestCase):
    def test_frozen_panel_uses_installed_application_root(self) -> None:
        with mock.patch.object(settings_app.sys, "frozen", True, create=True), \
             mock.patch.object(settings_app.sys, "executable", r"C:\Users\Example\AppData\Local\Programs\CUHK AI Bridge\app\CUHK-AI-Settings.exe"):
            self.assertEqual(settings_app.application_root(), Path(r"C:\Users\Example\AppData\Local\Programs\CUHK AI Bridge"))

    def test_qwen_local_model_preserves_its_verified_thinking_levels(self) -> None:
        for thinking in ("none", "low", "medium", "xhigh"):
            config = settings_app.normalize_config({"model": "qwen3.8-27b", "thinking": thinking})
            self.assertEqual(config["model"], "qwen3.8-27b")
            self.assertEqual(config["thinking"], thinking)

    def test_normalize_config_preserves_an_existing_workdir(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = settings_app.normalize_config({"workdir": directory})

        self.assertEqual(config["workdir"], directory)

    def test_normalize_config_clears_a_missing_workdir(self) -> None:
        missing = Path(tempfile.gettempdir()) / "cuhk-settings-missing-workdir"
        config = settings_app.normalize_config({"workdir": str(missing)})

        self.assertEqual(config["workdir"], "")

    def test_current_config_includes_the_selected_workdir(self) -> None:
        app = settings_app.SettingsApp.__new__(settings_app.SettingsApp)
        app.gateway_enabled = FakeVar(True)
        app.model_label = FakeVar(settings_app.MODELS["glm5.3flash"]["label"])
        app.thinking_label = FakeVar(settings_app.THINKING_LABELS["high"])
        app.workdir_var = FakeVar(r"D:\Projects\example")

        self.assertEqual(app._current_config()["workdir"], r"D:\Projects\example")

    def test_normalize_config_omits_unknown_settings(self) -> None:
        config = settings_app.normalize_config({"obsoleteSetting": True})

        self.assertNotIn("obsoleteSetting", config)


class SettingsLaunchTests(unittest.TestCase):
    @mock.patch.object(settings_app.subprocess, "Popen")
    def test_claude_button_launches_its_own_cli_in_selected_folder(self, popen: mock.Mock) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app = self.make_app(directory)
            app.launch_gateway_claude()
        self.assertTrue(app.gateway_enabled.value)
        app.save.assert_called_once_with()
        self.assertEqual(popen.call_args.kwargs["cwd"], directory)
        self.assertIn(str(settings_app.CLAUDE_LAUNCHER), popen.call_args.args[0])
        self.assertNotIn(str(settings_app.CODEX_LAUNCHER), popen.call_args.args[0])

    def test_new_conversation_button_asks_for_a_new_session(self) -> None:
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(settings_app.subprocess, "Popen") as popen:
            app = self.make_app(directory)
            app.launch_gateway_codex_new()

        command = popen.call_args.args[0]
        self.assertIn(str(settings_app.CODEX_LAUNCHER), command)
        self.assertEqual(command[-1], "-New")
        self.assertEqual(popen.call_args.kwargs["cwd"], directory)

    @mock.patch.object(settings_app.subprocess, "run")
    def test_stop_button_stops_the_gateway(self, run: mock.Mock) -> None:
        run.return_value = mock.Mock(returncode=0, stdout="", stderr="")
        app = settings_app.SettingsApp.__new__(settings_app.SettingsApp)
        app.status = FakeVar("")
        app.root = mock.Mock()

        app.stop_gateway()

        self.assertEqual(run.call_args.args[0], [str(settings_app.GATEWAY), "stop"])
        self.assertIn("已停止", app.status.value)

    def test_layout_measurements_follow_the_display_scale(self) -> None:
        app = settings_app.SettingsApp.__new__(settings_app.SettingsApp)
        app.scale = 1.5

        self.assertEqual(app.px(100), 150)

    def test_model_check_reports_an_unavailable_model(self) -> None:
        app = settings_app.SettingsApp.__new__(settings_app.SettingsApp)
        app.model_label = FakeVar(settings_app.MODELS["glm5.3flash"]["label"])
        app.status = FakeVar("")
        app.root = mock.Mock()
        failure = mock.Mock(
            returncode=1,
            stdout="",
            stderr="error:\n  message: GLM 5.3 Flash was not found in the model dialog.\n",
        )
        with mock.patch.object(settings_app.SettingsApp, "_run", return_value=failure):
            app.check_selected_model()

        self.assertIn("不可用", app.status.value)
        self.assertIn("not found", app.status.value)

    def test_model_check_reports_an_available_model(self) -> None:
        app = settings_app.SettingsApp.__new__(settings_app.SettingsApp)
        app.model_label = FakeVar(settings_app.MODELS["glm5.3flash"]["label"])
        app.status = FakeVar("")
        app.root = mock.Mock()
        success = mock.Mock(returncode=0, stdout="ok: true", stderr="")
        with mock.patch.object(settings_app.SettingsApp, "_run", return_value=success):
            app.check_selected_model()

        self.assertIn("可用", app.status.value)

    def test_all_launch_buttons_fit_the_panel(self) -> None:
        root = settings_app.tk.Tk()
        self.addCleanup(root.destroy)
        with mock.patch.object(settings_app, "load_config", return_value=settings_app.default_config()):
            settings_app.SettingsApp(root)
        root.update_idletasks()
        buttons = []
        def visit(widget):
            if isinstance(widget, settings_app.ttk.Button):
                buttons.append(widget)
            for child in widget.winfo_children():
                visit(child)
        visit(root)
        labels = {"开始新对话（Codex）", "继续上次对话（Codex）", "改用 Claude Code 对话"}
        launches = [b for b in buttons if b.cget("text") in labels]
        self.assertEqual(len(launches), 3)
        bottom = root.winfo_rooty() + root.winfo_height()
        for button in launches:
            self.assertLessEqual(button.winfo_rooty() + button.winfo_height(), bottom)

    def test_launcher_uses_native_current_directory_session_filter(self) -> None:
        launcher = settings_app.CODEX_LAUNCHER.read_text(encoding="utf-8")

        self.assertIn("& $codexCommand resume", launcher)
        self.assertNotIn("resume --all", launcher)

    def make_app(self, workdir: str) -> settings_app.SettingsApp:
        app = settings_app.SettingsApp.__new__(settings_app.SettingsApp)
        app.gateway_enabled = FakeVar(False)
        app.config = {"workdir": workdir}
        app.status = FakeVar("")
        app.save = mock.Mock()
        return app

    @mock.patch.object(settings_app.subprocess, "Popen")
    def test_launch_uses_the_selected_workdir(self, popen: mock.Mock) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app = self.make_app(directory)
            app.launch_gateway_codex()

        self.assertTrue(app.gateway_enabled.value)
        app.save.assert_called_once_with()
        self.assertEqual(popen.call_args.kwargs["cwd"], directory)

    @mock.patch.object(settings_app.subprocess, "Popen")
    def test_launch_without_a_selection_uses_the_bridge_root(self, popen: mock.Mock) -> None:
        app = self.make_app("")
        app.launch_gateway_codex()

        self.assertEqual(popen.call_args.kwargs["cwd"], str(settings_app.ROOT))


if __name__ == "__main__":
    unittest.main()
