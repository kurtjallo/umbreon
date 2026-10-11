# Umbreon

Umbreon is a self-hosted software factory built on eve. It proves every change by running the real app. These rules apply to any coding agent working in this repo.

## Commands

```sh
fnm use 24          # Node.js 24 is required
npm install
npm run dev         # starts eve dev and reads .env.local
npm run typecheck
```

## Rules

- Enforce step order and checks in code. Prompts guide the work inside a step. They never decide whether a step runs.
- Never add code that merges or deploys. Umbreon stops at a pull request.
- Never commit `.env.local` or any key.
- Pin the exact eve version and upgrade on purpose.
- Prove a change by running it. Run the narrowest real check and report its output.
- Write docs, comments, and PR text in plain English. Comment only to explain why.

## Working with eve

An agent is a directory of files under `agent/`, and eve compiles and runs it.

For a content-only change to the agent's identity, purpose, tone, or response guidelines, edit `agent/instructions.md`. The selected model lives in `agent/agent.ts`. Preserve that file unless asked to change the model.

### Read the docs before writing code

```sh
ls node_modules/eve/docs
```

Start with `docs/README.md`. It maps each task to the page that covers it. Read that page before authoring tools, connections, channels, skills, subagents, schedules, or deployment. If the package docs are missing, use https://eve.dev/docs.

Use a bounded authoring loop:

1. Read the relevant page and inspect only the files you will modify or need to imitate.
2. Stop discovery once the file location, imports, and definition shape are clear. Implement the smallest complete behavior.
3. Run one narrow verification. Expand the investigation only when it fails.

Do not recursively glob `node_modules` or enumerate the whole docs tree when the direct path is known.

### Prefer an existing integration

When a task names an external product or service, search the registry before writing the integration. For a generic capability, write a tool instead.

```sh
eve registry search <query> --json
eve registry view <item>
eve add <item> --non-interactive
```

Prefer items whose `implementation` is `native`. Exit code 0 means setup completed, 1 means it failed, and 2 means it needs an answer or a prerequisite. On exit 2, run the `next.command` from the final NDJSON event. Never pass a secret in `--answer`. See `docs/install-integrations.mdx` for prerequisites.
