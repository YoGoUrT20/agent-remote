# agent-remote

Self-hosted Discord hub for AI coding agents. Run a single Discord bot that provisions your server with dedicated categories per coding assistant — then chat with any of them through Discord threads.

Each message in a project channel starts a new agent session and a live-updating **Discord thread**. Reply inside the thread to continue the conversation. The bot handles session lifecycle, streaming responses, and workspace mapping automatically.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-runtime-black?logo=bun&logoColor=white)](https://bun.sh/)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org/)

## Provider support

| Status | Provider |
| --- | --- |
| **Supported** | Claude Code, Codex, OpenCode |
| **Planned** | Antigravity, Cursor, Kiro |

Adding a new provider means implementing a single adapter against the `BaseAdapter` interface — the bot, provisioner, and thread system work the same regardless of backend.

## Quick start

```bash
# 1. Install dependencies
bun install

# 2. Install bridge deps (Claude Code path)
bun install --cwd claude_agent_bridge

# 3. Run the setup wizard — creates .env, selects providers
bun run setup

# 4. Start the bot
bun run bot
```

After `bun run bot`, open Discord and run `/install` to provision the server layout.

## How it works

1. **Setup wizard** (`bun run setup`) walks you through creating a Discord application, choosing providers, and writing `.env`.
2. **Bot joins your server** — invite it with the OAuth2 URL from the Discord Developer Portal.
3. **`/install`** provisions the server: creates a category + `#bot-commands` channel for each enabled provider, and uploads provider emoji.
4. **`/project open <name>`** in `#bot-commands` creates a project text channel under that provider's category.
5. **Post a message** in the project channel — the bot starts an agent session, creates a thread (auto-named from the agent's response), and streams the reply as a live-updating embed.
6. **Reply in the thread** to continue the same session. The bot reconnects sessions across restarts automatically.

## Architecture

```
src/
├── cli.ts                  # Entry point (setup / bot / migrate / api)
├── config.ts               # Loads settings from .env
├── constants.ts            # Provider definitions, emoji maps
├── provisioner.ts          # Guild layout creation, emoji upload
├── workspace-dirs.ts       # Maps project channels to local folders
├── adapters/
│   ├── base.ts             # BaseAdapter interface & event types
│   ├── claude.ts           # Claude Code — Anthropic Agent SDK
│   ├── codex.ts            # Codex — JSON-RPC over subprocess
│   ├── opencode.ts         # OpenCode — `opencode run` JSON events per turn
│   └── factory.ts          # Routes provider key → adapter
└── bot/
    ├── client.ts           # Discord client bootstrap
    ├── handlers.ts         # Slash commands + message handlers
    ├── deploy.ts           # Register commands with Discord API
    ├── registry.ts         # In-memory thread → session map
    └── serial-queue.ts     # Per-thread operation queue
```

**Key design decisions:**
- **Adapter pattern** — every provider implements the same streaming event interface (`text_delta`, `tool_start`, `tool_result`, `error`, `done`, `thread_title`), so the Discord layer is provider-agnostic.
- **In-memory registry** — thread IDs map to live adapter sessions; sessions are lazily restored on bot restart.
- **Serial queue** — per-thread locking prevents concurrent Discord edits from racing.
- **Idempotent provisioning** — `/install` can run repeatedly; it skips what already exists.

## Commands

| Command | Where | Description |
| --- | --- | --- |
| `/install` | Any channel | Provision server layout (admin only) |
| `/project open <name>` | `#bot-commands` | Create a project channel for the category's provider |

## Roadmap

### In progress
- [ ] **Cursor adapter** — bridge integration for Cursor agent sessions
- [ ] **Antigravity adapter** — vendor-specific bridge for Antigravity

### Planned
- [ ] **Attachments & images** — forward Discord file uploads to agent sessions as context
- [ ] **Multi-turn tool approval** — interactive buttons to approve/deny tool calls from the agent before execution
- [ ] **Session history** — persist conversation history so threads survive beyond the in-memory registry
- [ ] **Per-project config** — allow different model settings, system prompts, or workspace paths per project channel
- [ ] **`/session` command** — inspect, interrupt, or restart the current agent session from Discord
- [ ] **Cost tracking** — surface token usage and estimated cost per session in the thread
- [x] **Voice messages support** — Discord voice messages are transcribed locally with Whisper (auto-detects english for now.). Bot posts the transcription in-thread before forwarding it to the agent so you can verify what was heard.
- [ ] **Ping/Notify** — A setting which will ping the user once the task is completed.
- [ ] **Bot look and feel** — Automatically assgin the bot name and avatar.

