# Multi-IDE Discord Hub — Architecture and Backend Design

This document describes an **open source, self-hostable** system: operators run their own hub and Discord application, choose which coding assistants to expose, and get a **dedicated Discord server layout** where each enabled IDE has its own section. End users start work from a **bot-commands** (or similarly named) channel inside that section. The Discord bot implementation favors **py-cord**.

---

## 1. Goals

- **Self-hosted control**: Source is public; deploy on your hardware or cloud with **your** Discord application, **your** API keys, and **your** data (Postgres/Redis).
- **Guided first-time setup**: The first time an operator runs the app, they walk through steps: pick enabled IDEs, configure Discord manually (developer portal, token, invite URL, intents), wire other settings (database, queue, provider keys), then **provision** the server layout.
- **One Discord server per installation (layout)**: After setup, the bot ensures a **new dedicated server** presents a clean layout: **only** the IDE sections the operator selected exist; anything not selected has **no** category or channels.
- **Per-IDE areas**: Each enabled IDE gets a **category** (Discord “section”) containing a **`bot-commands`** text channel where members run **`/project create`** to add **project** text channels. Provisioned layout does **not** include a dedicated forum; threads are created **on messages inside each project channel**.
- **No cross-talk between sessions**: Each agent session maps to exactly one Discord **thread** (spawned from a message in a project channel), scoped under the correct IDE section. A stable **session id** in the database is recommended for production; the current bot may keep an in-memory map keyed by thread id.
- **Observable outputs**: Model text, tool calls, errors, and artifacts come from **APIs or structured CLI output**—not from scraping proprietary IDE UI.

---

## 2. First-Time Operator Flow

### 2.1 Entry command

The operator starts from documented **CLI entrypoint** (example names only): `agent-remote setup` or `python -m agent_remote setup`.

- **First run** (no valid config / missing encryption key / empty `installations` row): print or open the **setup wizard** (terminal prompts, optional local web UI later).
- **Later runs**: same command can jump to **re-run provisioning** (add an IDE), **rotate secrets**, or **repair** channel layout.

### 2.2 Wizard steps (conceptual)

1. **Welcome**: Explain self-hosting: you will create a Discord application, invite the bot, and keep tokens on this machine.
2. **Select IDEs**: Multi-select which integrations to enable (e.g. Claude Code / Anthropic, Codex / OpenAI, Cursor bridge, Antigravity bridge). This list drives **which server sections** the provisioner creates and which env vars the wizard asks for next.
3. **Discord (manual)**: Link to Discord Developer Portal. Operator creates an application, a bot user, copies **bot token** and **application (client) id**, enables **required intents** (e.g. message content if you read messages in sessions, guild members if you gate roles), generates an **invite URL** with scopes `applications.commands` and `bot`, and picks **Administrator** or a documented minimal permission set for the bot to manage channels.
4. **Discord server creation**: Operator creates a **new empty Discord server** in the client (or uses Discord’s documented API path if you later automate guild creation and your app is eligible). They copy the **guild id** into the wizard. The wizard stores it as the **managed guild** for this installation.
5. **Invite bot**: Operator pastes the invite link, completes OAuth in browser, bot lands in the new guild.
6. **Other settings**: Database URL, Redis URL, optional object storage, encryption secret for stored tokens, per-provider API keys **only for enabled IDEs**.
7. **Write config**: Emit `.env` or `config.yaml` + run database migrations.
8. **Provision layout**: One-shot **guild provisioning** job (see §4) creates categories and channels for **enabled IDEs only**.
9. **Start services**: Operator starts API, worker, and bot (e.g. Docker Compose). Slash commands sync to the guild.

Skipped IDEs never get categories or channels during provisioning.

---

## 3. Reality Check on “Connect to All Apps”

Products differ in what is **publicly supported** for automation:

| Target | Practical integration paths | Getting model/chat output |
|--------|-----------------------------|---------------------------|
| **Claude Code / Anthropic** | **Messages API** (HTTP + SSE streaming) for cloud; optional **CLI** in a sandbox if you standardize on the same product surface | Stream tokens and structured blocks from the API; for CLI, parse **JSON/stream-json** or documented flags if available; avoid brittle TTY scraping |
| **OpenAI Codex** | **Chat Completions / Responses API** where your SKU allows it; optional **official CLI** in an isolated environment | Same as above: prefer HTTP streaming; CLI only with explicit machine-readable output |
| **Cursor** | **Published APIs and terms** change frequently; many features are IDE-bound. A durable design uses: (a) a **thin “runner” service** that Cursor or its documented integration can talk to, or (b) only features Cursor explicitly documents for third parties | Prefer documented webhooks or HTTP APIs from Cursor; if unavailable, treat “Cursor” as a **workspace runner** you own that Cursor edits via git/sync, not as raw UI automation |
| **Antigravity** | Treat as **vendor-specific** until stable public automation exists | Same rule: official API first; else a **hosted dev container** with their CLI if they ship one, with stdout/JSON contracts |

**Product principle**: ship **adapters** behind one interface (`send_prompt`, `stream_events`, `cancel`, `attach_repo`). Some adapters will be “full fidelity” (API streaming); others may be “best effort” (CLI + structured logs) until vendors expose stable hooks.

---

## 4. Discord Server Layout and Provisioning

### 4.1 Managed guild

Each **self-hosted installation** binds to exactly one **managed guild id** (the new server). The database stores:

- `installation_id` (or single-row “site config” for single-tenant OSS)
- `managed_guild_id`
- `enabled_providers` (array or flags)
- Optional: human-readable names for categories

### 4.2 Per-enabled IDE: one category (“section”)

For every provider **enabled** at setup time, the provisioner creates:

- **Category** named consistently, e.g. `Claude Code`, `Codex`, `Cursor`, `Antigravity`.
- **`bot-commands` channel** (text): Slash commands **`/install`** (admin) and **`/project create`** (add a project channel under this category). Project channels are normal **guild text channels** created as siblings under the same category.
- **Project channels** (text): Not created by the base provisioner; operators or users create them via **`/project create`**. In a project channel, **each top-level message** starts a **new** provider session, a **public thread** attached to that message (thread name derived from the message), and routes further user messages in that thread to the **same** agent session.

If an IDE was **not** selected during setup, the provisioner **does not** create that category or any of its channels.

### 4.3 Idempotent provisioning

Re-running provisioning (after enabling a new IDE) should:

- Create **missing** categories/channels for newly enabled providers.
- **Not** remove existing historical threads if you can avoid it; optional `--prune-disabled` flag can archive or delete sections for providers turned off (operator choice).

### 4.4 Permissions (self-hosted default)

- Bot role: **Manage Channels** (and **Manage Roles** if you auto-assign session roles), **Create Public Threads**, **Send Messages**, **Embed Links**, **Attach Files**, **Use Slash Commands**.
- `@everyone` in managed guild: typically **no admin**; read/send only in public session areas as you define.

---

## 5. End-User Session Flow (Inside an IDE Section)

1. User goes to the IDE’s **bot-commands** channel and runs **`/project create name:…`** to add a **project** text channel (if it does not already exist).
2. User switches to that **project** channel and sends a **message**. The bot starts a provider session, sends that message as the first **user turn**, creates a **thread** from that message (public thread on the message), and streams the assistant reply **in the thread**.
3. Optionally persist `session_id` and `provider` in the database **before** the first assistant reply (recommended for multi-process deployments).
4. All further **user** messages **in that thread** are sent as new turns to the **same** provider session; additional top-level messages in the **project** channel start **new** sessions and **new** threads.

**Routing key**: `(managed_guild_id, thread_id)` (with `parent_channel_id` identifying the project channel) must resolve to a single `session_id`. Ensure threads under **`bot-commands`** are not registered as agent sessions.

### 5.1 Supporting many IDEs at once

- **Per-session routing**: The `provider` field selects the adapter; concurrent sessions in different sections do not share queues except through fair worker scheduling.
- **Per-session jobs**: Job identifiers include `session_id`; concurrency limits per session or per guild prevent one power user from starving others on small hardware.

---

## 6. Recommended Backend Stack (Self-Hosted)

| Layer | Suggestion | Why |
|-------|------------|-----|
| **API + orchestration** | **Python 3.12+**, **FastAPI** (or Starlette) | Same ecosystem as py-cord; async-friendly; easy `.env` config |
| **Bot process** | **py-cord** | Application commands, threads, channel/category creation for provisioning |
| **Queue / workers** | **Redis** + **RQ**, **Arq**, or **Celery** | Long-running IDE jobs; Discord interactions must ack quickly |
| **State** | **PostgreSQL** | Installations, enabled providers, sessions, mappings, audit logs |
| **Secrets** | **Env vars** + optional **libsodium/Fernet** field encryption in DB for BYOK keys | No commercial secret manager required for OSS users |
| **Artifacts** | Local disk path or **S3-compatible** bucket | Large logs; link from Discord |
| **Optional compute** | **Docker** per session or shared worker containers | CLI isolation on the same host |

**Typical deployment**: `docker-compose.yml` with services `api`, `worker`, `bot`, `postgres`, `redis`. Document required env vars in one table (bot token, application id, database URL, Redis URL, provider keys for enabled integrations only).

The bot may call the API over **localhost** (`HTTP_BASE_URL`) or a Unix socket; same codebase can split processes for scaling later.

---

## 7. Information Flow: Discord → Hub → Model → Discord

```
Discord (py-cord)
    → HTTP: POST /sessions/{id}/messages  (FastAPI)
        → enqueue RunJob(session_id, payload)
Worker
    → adapter.stream_events(...)
        → persist message parts / artifact refs
        → publisher → Discord (edit or follow-up messages)
```

**Getting content from the model / tool loop**:

1. **Preferred**: Vendor **HTTP streaming** (SSE or WebSockets) with a documented schema.
2. **Secondary**: **CLI** with **non-interactive** flags and **JSON lines** on stdout.
3. **Never rely on**: Parsing proprietary IDE UI.

**Discord delivery**: Short text in-thread; long outputs via link to hub artifact URL or attachment policy you document for self-hosters.

---

## 8. Adapter Interface (Conceptual)

All providers implement the same internal contract:

- `start_session(config) -> session_handle`
- `send_user_turn(text, attachments?) -> None`
- `stream_assistant() -> AsyncIterator[Event]` where `Event` is normalized (text delta, tool_start, tool_result, error, done)
- `cancel()` / `healthcheck()`

Under the hood: HTTP streaming for Anthropic/OpenAI; **bridge runners** for Cursor/Antigravity until stable APIs exist.

---

## 9. Security and Operations (Self-Hosted)

- **Trust boundary**: Anyone with the bot token or DB access controls the guild layout and can read stored keys—document filesystem permissions and backups.
- **Sandbox**: Treat user prompts as hostile; restrict runner network egress on sensitive networks.
- **Guild-scoped config**: One installation, one managed guild, avoids accidental cross-guild sessions.
- **Audit**: Optional log retention policy for compliance; OSS operators choose retention.

---

## 10. What You Should Use Summary

| Concern | Choice |
|---------|--------|
| License / distribution | **Open source**; publish **Docker Compose** and env template |
| Discord SDK | **py-cord** |
| Core backend | **Python + FastAPI** |
| Long jobs | **Redis + worker queue** |
| Install + sessions | **PostgreSQL** |
| First-time UX | **CLI (`setup`) wizard** + manual Discord app + **optional new guild** + **provision layout** |
| Server provisioned per IDE | **One category**; **`bot-commands`** only; **project** text channels added via **`/project create`**; **threads** created per message in project channels |
| Model outputs | **Vendor streaming APIs** first; **structured CLI** second |

---

## 11. Phased Implementation Suggestion

1. **MVP**: Setup wizard + managed guild provisioning (categories/channels for one provider) + py-cord threads + FastAPI + Redis worker + Postgres.
2. **Multi-IDE**: Enable/disable providers in config; provisioner skips unselected sections; shared adapter interface.
3. **Bridges**: Cursor/Antigravity via git-backed or MCP runners; document fidelity limits.

This keeps Discord UX consistent while self-hosters opt in only to the integrations they install and pay for.
