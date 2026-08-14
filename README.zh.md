# dsh-chat-cli

中文 | [English](README.md)

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立多轮命令行对话插件。

`dsh-chat-cli` 将官方 `dsh` 的单次任务运行方式扩展为终端中的持续对话。它沿用 Harness 的 Agent、会话、工具和审批能力，不修改官方 CLI，也不提供 TUI。

## 环境要求

- Node.js 22.13 或更高版本
- DeepSeek API Key
- 官方 `dsh` CLI

## 安装

> **发布状态：** `dsh-chat-cli` 的首个 npm 版本尚待发布。发布后可直接使用下方命令安装；当前请使用[本地开发](#本地开发)中的本地包安装方式。

先安装官方 CLI，再将本插件添加到独立 profile：

```sh
npm install -g @deepseek-ai/dsh
dsh plugin --profile chat-cli add dsh-chat-cli
```

启动前配置 API Key：

```sh
# macOS / Linux
export DEEPSEEK_API_KEY="your-api-key"

# PowerShell
$env:DEEPSEEK_API_KEY = "your-api-key"
```

## 开始对话

进入希望让 Agent 操作的项目目录，执行：

```sh
dsh --profile chat-cli
```

之后输入的每一行都会作为同一持久 Agent 会话的下一轮消息，助手回复会直接流式输出到终端。

## 常用命令

```sh
# 恢复已有会话
dsh --profile chat-cli --resume <session-id>

# 在输出中显示模型推理内容
dsh --profile chat-cli --show-reasoning
```

对话中可使用：

- `/help` 查看可用命令。
- `/session` 查看当前会话 ID。
- `/exit` 或 `/quit` 退出对话。
- `Ctrl+C` 取消当前轮次；空闲时按 `Ctrl+C` 退出 CLI。

工具调用、审批请求和交互式提问仍使用 DeepSeek Harness 的标准服务。

## 项目边界

这是一个行式 CLI 插件，不包含 TUI、浏览器客户端、Web 服务或全屏终端界面。

## 本地开发

```sh
pnpm install
pnpm run build
pnpm pack
```

本地测试时，可以将生成的 `.tgz` 文件替代包名安装：

```sh
dsh plugin --profile chat-cli add ./dsh-chat-cli-0.1.0.tgz
```

## 许可证

MIT
