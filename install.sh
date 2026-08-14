#!/bin/sh
set -eu

if ! command -v dsh >/dev/null 2>&1; then
  echo "Install the official CLI first: npm install -g @deepseek-ai/dsh" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Install pnpm first: npm install -g pnpm" >&2
  exit 1
fi

dsh plugin --profile chat-cli add dsh-chat-cli
echo "Installed. Start it with: dsh --profile chat-cli"
