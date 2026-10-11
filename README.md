# CUHK AI Bridge

把香港中文大学（深圳）AI 网页中的模型接入本地 Codex CLI 和 Claude Code CLI，并让工具调用仍由你电脑上的 CLI 执行。

> An experimental, local bridge from the CUHK-Shenzhen AI website to Codex CLI and Claude Code CLI. The browser stays logged in on your own computer.

本项目是个人社区项目，你需要自行拥有学校 AI 网页的合法访问权限。它不提供学校账号、模型额度。

## 它能做什么

- 从本地控制面板选择网页模型与思考强度，分别启动 Codex CLI 或 Claude Code CLI。
- 通过已登录的 Chrome 和 OpenCLI 使用 `https://ai.cuhk.edu.cn`，无需将学校密码填进本项目。
- 将网页模型生成的工具决策交回本地 CLI 执行；已验证 Codex 的命令与文件补丁，以及 Claude Code 的读、写、编辑和 Bash 工具闭环。
- 将同一个 CLI 会话接回同一个网页对话；后续回合只补发新增内容，在工具目录未变化时使用简短提醒。
- 把 Gateway CLI 的配置与会话放在独立目录，避免覆盖日常 Codex/Claude 配置。

```text
Codex CLI / Claude Code CLI
          │  本地协议
          ▼
  CUHK Gateway（本机）
          │  OpenCLI + Chrome 扩展
          ▼
  你已登录的学校 AI 网页
          │
          └─ 工具决策返回本机 CLI 执行
```

网页端AI须在使用时为登录状态；本地工具仍遵循所用 CLI 的权限设置。Gateway 在本机监听回环地址。

## 真实生成示例

下面的动画 SVG 由 Claude Code 经 Gateway 调用学校网页的 Qwen 模型生成，并通过本地 Write/Read 工具保存与独立读回验证。预览是其中一帧；点击 [原始 SVG](artifacts/pelican-bicycle.svg) 可下载或在浏览器中观看动画，验收方式见 [生成记录](docs/claude-code-gateway.md)。

![Claude Code 经 Gateway 生成的鹈鹕骑自行车 SVG 的静态预览](artifacts/pelican-bicycle-frame-0.png)

## 当前状态（2026-10）

Codex CLI 与 Claude Code CLI 的双入口、Qwen/GLM 工具链和真实网页验收已经完成。离线验收结果为 Provider 172/172、OpenCLI 适配器 45/45、面板 10/10；验收范围与方式见 [Claude Code 验收记录](docs/claude-code-gateway.md)。这些数字说明已测场景通过。

Windows 10/11（x64）用户可从 [GitHub Releases](https://github.com/hfp556/cuhk-ai-codex-bridge/releases/latest) 下载 `CUHK-AI-Bridge-Setup-...-win-x64.exe`，双击并按向导安装。安装包包含运行时与独立控制面板，支持选择安装目录、创建桌面与开始菜单快捷方式，以及从 Windows 卸载。仓库私密期间，下载需要具有仓库访问权限的 GitHub 账号。完整步骤见 [安装指南](docs/install.md)，验证范围见 [发布准备清单](docs/release-readiness.md)。


## 安装与使用

普通 Windows 用户请打开 [GitHub Releases](https://github.com/hfp556/cuhk-ai-codex-bridge/releases)，下载最新版本中名为 `CUHK-AI-Bridge-Setup-...-win-x64.exe` 的文件，双击运行并按照向导选择安装目录。安装完成后会打开首次使用说明。安装包包含 Node、OpenCLI、扩展文件和控制面板；仍需 Chrome、学校网页登录和选用的 Codex/Claude Code CLI。详细图文步骤见 [安装指南](docs/install.md)。

开发者源码安装需准备 Git、Node.js 22+（含 npm）、Python 3（含 Tkinter）、Chrome 和选用的 CLI，然后在仓库根目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

脚本准备本地依赖，不发送模型请求。新用户请按 [完整安装指南](docs/install.md) 加载扩展并检查环境，再启动客户端。

1. 在 Chrome 中安装 OpenCLI 的解压扩展，并自行登录 `https://ai.cuhk.edu.cn`。
2. 双击仓库根目录的 `CUHK-AI-Settings.cmd`，选择工作目录、模型和思考强度。
3. 在面板里选好模型、思考强度与工作目录，点击 **开始新对话（Codex）**、**继续上次对话（Codex）** 或 **改用 Claude Code 对话**。所选文件夹还没有历史对话时，Codex 会自动开始新对话，不会停在空列表上。

也可以在仓库根目录调用现有启动器：

```powershell
.\bin\cuhk-codex-launch.cmd
.\bin\cuhk-claude-launch.cmd
.\bin\cuhk-gateway.cmd status
.\bin\cuhk-gateway.cmd stop
```

控制面板的“工作目录”是 CLI 要处理的项目。Gateway 状态、密钥和 CLI 独立数据在被 Git 忽略的 `gateway/runtime-state/` 中。本地 `config.json` 从安全的 `config.example.json` 初始化，不再提交到 Git；分享截图、日志和配置时请检查路径及私人内容。

## 原理与文档

| 想了解 | 入口 |
| --- | --- |
| 双 CLI 的使用方式、协议范围、真实验收 | [Claude Code Gateway](docs/claude-code-gateway.md) |
| Windows 安装程序、源码安装、扩展权限与更新 | [安装指南](docs/install.md) |
| Gateway 与浏览器适配层的边界 | [Gateway 架构](docs/gateway-architecture.md) |
| OpenCLI 命令、模型别名、网页交互策略 | [OpenCLI 适配器](docs/opencli-adapter.md) |
| 发布前缺口与复现限制 | [发布准备清单](docs/release-readiness.md) |
| 历史实验及研究副本 | [研究说明](research/README.md) |

`research/` 下的第三方研究仓库不包含在本仓库的 Git 内容里。上游依赖的许可与署名见 [第三方说明](THIRD_PARTY_NOTICES.md)。

完整入口与历史记录分类见 [文档导航](docs/README.md)；使用帮助见 [SUPPORT.md](SUPPORT.md)。

## 参与和反馈

欢迎分享真实使用反馈、复现步骤与修复建议，也欢迎给仓库 Star，帮助其他有同样需求的使用者找到它。报错请按 [贡献指南](CONTRIBUTING.md) 提供版本、触发步骤和脱敏日志；安全问题按 [安全说明](SECURITY.md) 私下报告。提交 Issue 不需要提供学校账号、Cookie、完整对话或本地文件。

本项目按个人时间维护，欢迎愿意自行检查代码、理解本地工具权限和协助排障的使用者。

准备分享项目时，可以使用 [项目简介](docs/project-profile.md) 中的短文；请说明这是开发版，并在安装包尚未发布时指向源码安装指南。

## 许可证

本仓库原创代码与文档按 [MIT License](LICENSE) 开放，允许使用、修改、再分发和商业使用，要求保留许可证与版权声明。Star。OpenCLI、Claude Code Router 及其他第三方组件保留各自的许可证和版权；详见 [第三方说明](THIRD_PARTY_NOTICES.md)。软件许可证不授予学校 AI 服务、账号或模型的使用权。
