# 🤖 agent-remote

Self-hosted Discord hub for multi-IDE agent sessions. Run your own Discord bot that provisions a server with dedicated sections per coding assistant. You create **project** text channels from `#bot-commands`; each message in a project channel starts a new provider session and a **Discord thread** (named from your message), and further messages in that thread continue the paired agent chat.

## Provider support

| Status | Assistants |
| --- | --- |
| **Implemented** | Claude Code |
| **Coming soon** | Antigravity, Kiro, Codex, Opencode, Cursor |

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-runtime-black?logo=bun&logoColor=white)](https://bun.sh/)

## Quick start

```bash
# 1. Install dependencies (Bun)
bun install

# 2. Install bridge deps (Claude Code path)
bun install --cwd claude_agent_bridge

# 3. Run the setup wizard (creates .env)
bun src/cli.ts setup

# 4. Start infrastructure + bot
bun run bot
```

Equivalent to `bun src/cli.ts bot`. You can also use the `agent-remote` bin from `package.json` after a local `bun link`.

## How it works

1. **Setup wizard** (`bun src/cli.ts setup`) walks you through creating a Discord application, selecting providers, and writing your `.env` config.
2. **Bot joins your server** — invite it using the OAuth2 URL from the Discord Developer Portal.
3. **`/install`** — run this in Discord to provision the server layout. It creates categories and channels for each enabled provider.
4. **Projects and threads** — in `#bot-commands`, run `/project create` with a name to add a project text channel. Post any message in that channel to start a new agent session and a thread; reply inside the thread to continue the same session.

