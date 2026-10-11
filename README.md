<div align="center">

# <picture><source media="(prefers-color-scheme: dark)" srcset=".github/assets/umbreon-dark.png"><img src=".github/assets/umbreon.png" alt="" height="48" align="center"></picture> Umbreon

### Prove every change works before you merge it.

A self-hosted software factory. Coding agents say a change works. Umbreon checks. It starts your app in a sandbox, clicks through it like a user, and posts screenshots, a video, and a pass or fail on the pull request. Free, open source, and it runs on your own machine.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Built on eve](https://img.shields.io/badge/built%20on-eve-000000)](https://github.com/vercel/eve)
[![Self-hosted](https://img.shields.io/badge/self--hosted-Docker-2496ED)](#quick-start)

**[Features ↓](#features)** · **[Quick start ↓](#quick-start)** · **[How it works ↓](#how-it-works)**

</div>

## Features

- Proves any pull request, whether a person, Claude Code, Codex, or Cursor wrote it.
- Builds changes from a task and proves them before opening a pull request.
- Checks side effects too: database rows, sent emails, and logs.
- Passes a change only when lint, types, tests, coded checks, and an AI reviewer all agree.
- Blocks merging on GitHub until the change is proven.
- Runs in Docker with your own OpenRouter, OpenAI, or Anthropic key.

## Quick start

Requires Node.js 24 and Docker.

```bash
npx umbreon init           # set up Docker, your model key, and integrations
umbreon verify --pr 42     # prove a pull request
```

## How it works

1. Umbreon learns how to run your app and saves the steps in `.umbreon/` in your repo.
2. For each change, it starts the app in a sandbox and drives it with Playwright.
3. It checks the results against what the change claims.
4. It posts the verdict on the pull request. It never merges or deploys.

GitHub, Linear, Slack, and MCP integrations are optional.

## Development

```bash
npm install
echo "OPENROUTER_API_KEY=your-key" > .env.local
npm run dev
```

## License

[Apache 2.0](LICENSE). Built on [eve](https://github.com/vercel/eve).
