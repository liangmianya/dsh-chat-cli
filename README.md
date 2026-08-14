# dsh-chat-cli

[中文](README.zh.md) | English

A standalone, multi-turn command-line chat plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

`dsh-chat-cli` turns the official one-shot `dsh` runtime into a persistent conversation in your terminal. It keeps the Harness Agent, session, tool, and approval capabilities intact, without modifying the official CLI and without providing a TUI.

## Requirements

- Node.js 22.13 or later
- A DeepSeek API key
- The official `dsh` CLI

## Install

> **Release status:** The first npm release is pending. The commands below are the installation path once `dsh-chat-cli` is published; use the local-package instructions in [Development](#development) until then.

Install the official CLI, then add this plugin to a dedicated profile:

```sh
npm install -g @deepseek-ai/dsh
dsh plugin --profile chat-cli add dsh-chat-cli
```

Configure your API key before starting a conversation:

```sh
# macOS / Linux
export DEEPSEEK_API_KEY="your-api-key"

# PowerShell
$env:DEEPSEEK_API_KEY = "your-api-key"
```

## Start Chatting

Open the directory you want the Agent to work in, then run:

```sh
dsh --profile chat-cli
```

Every line you enter is sent as the next turn in the same persisted Agent session. Assistant output streams directly to the terminal.

## Useful Commands

```sh
# Resume an existing session
dsh --profile chat-cli --resume <session-id>

# Include model reasoning in the output
dsh --profile chat-cli --show-reasoning
```

Inside a conversation:

- `/help` shows available commands.
- `/session` prints the current session ID.
- `/exit` or `/quit` closes the chat.
- `Ctrl+C` cancels the active turn; when idle, it exits the CLI.

Tool calls, approval requests, and interactive questions continue to use the standard DeepSeek Harness services.

## What This Is

This is a line-oriented CLI plugin. It does not include a TUI, browser client, web server, or full-screen terminal interface.

## Development

```sh
pnpm install
pnpm run build
pnpm pack
```

To test a local package, add the generated `.tgz` file instead of the package name:

```sh
dsh plugin --profile chat-cli add ./dsh-chat-cli-0.1.0.tgz
```

## License

MIT
