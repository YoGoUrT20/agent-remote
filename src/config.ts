import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeDiscordCredential } from "./discord-input.js";
import { resolveWorkspaceRootForRuntime } from "./workspace-root-resolve.js";
import type { AccessEnvDefaults } from "./access-store.js";

function tryLoadEnvFile(): void {
  const p = resolve(process.cwd(), ".env");
  if (existsSync(p)) {
    loadEnv({ path: p, override: true });
  }
}

tryLoadEnvFile();

export interface Settings {
  discordBotToken: string;
  discordApplicationId: string;
  discordGuildId: string;
  databaseUrl: string;
  redisUrl: string;
  enabledProviders: string;
  anthropicApiKey: string;
  claudeModel: string;
  claudeCodeBinaryPath: string;
  claudeWorkspaceCwd: string;
  claudeEffort: string;
  claudeThinking: boolean;
  claudeFastMode: boolean;
  openaiApiKey: string;
  codexModel: string;
  codexBinaryPath: string;
  codexHomePath: string;
  encryptionKey: string;
  apiHost: string;
  apiPort: number;
  accessEnvDefaults: AccessEnvDefaults;
  enabledProviderKeys(): string[];
}

function parseCsvIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^\d+$/.test(s));
}

function parseBoolEnv(raw: string | undefined, defaultValue = false): boolean {
  if (raw === undefined) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "") return defaultValue;
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

export function loadSettings(): Settings {
  tryLoadEnvFile();
  const enabledProviders = process.env.ENABLED_PROVIDERS ?? "";
  return {
    discordBotToken: sanitizeDiscordCredential(process.env.DISCORD_BOT_TOKEN ?? ""),
    discordApplicationId: sanitizeDiscordCredential(process.env.DISCORD_APPLICATION_ID ?? ""),
    discordGuildId: sanitizeDiscordCredential(process.env.DISCORD_GUILD_ID ?? ""),
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgresql+asyncpg://agent_remote:agent_remote@localhost:5432/agent_remote",
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379/0",
    enabledProviders,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    claudeModel: process.env.CLAUDE_MODEL ?? "sonnet",
    claudeCodeBinaryPath: process.env.CLAUDE_CODE_BINARY_PATH ?? "",
    claudeWorkspaceCwd: resolveWorkspaceRootForRuntime(process.env.WORKSPACE_CWD ?? ""),
    claudeEffort: process.env.CLAUDE_EFFORT ?? "",
    claudeThinking: process.env.CLAUDE_THINKING === "true" || process.env.CLAUDE_THINKING === "1",
    claudeFastMode:
      process.env.CLAUDE_FAST_MODE === "true" || process.env.CLAUDE_FAST_MODE === "1",
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    codexModel: process.env.CODEX_MODEL ?? "gpt-5.4",
    codexBinaryPath: process.env.CODEX_BINARY_PATH ?? "",
    codexHomePath: process.env.CODEX_HOME ?? "",
    encryptionKey: process.env.ENCRYPTION_KEY ?? "",
    apiHost: process.env.API_HOST ?? "0.0.0.0",
    apiPort: Number(process.env.API_PORT ?? "8000") || 8000,
    accessEnvDefaults: {
      ownerUserId: (process.env.BOT_OWNER_ID ?? "").trim(),
      allowedUserIds: parseCsvIds(process.env.BOT_ALLOWED_USER_IDS),
      restrictToWhitelist: parseBoolEnv(process.env.BOT_RESTRICT_TO_WHITELIST, true),
    },
    enabledProviderKeys() {
      if (!enabledProviders) return [];
      return enabledProviders.split(",").map((k) => k.trim()).filter(Boolean);
    },
  };
}
