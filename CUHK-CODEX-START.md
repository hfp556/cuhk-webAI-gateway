# 旧版 Codex 启动说明

本文件是历史入口。当前双 CLI 的功能与发布状态请先读 [项目首页](README.md)，源码安装步骤见 [安装指南](docs/install.md)。

在已配置好的开发环境里，可通过控制面板的 **开始新对话（Codex）** / **继续上次对话（Codex）** 按钮，或从仓库根目录运行：

```powershell
.\bin\cuhk-codex-launch.cmd
```

Gateway CLI 使用独立的 `gateway/runtime-state/codex-home`，不会把学校 Gateway 写入日常 Codex 配置。Claude Code 使用说明见 [Claude Code Gateway](docs/claude-code-gateway.md)。
