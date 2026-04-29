import prompts from "prompts";
import { Client } from "discord.js";
import { existsSync, writeFileSync } from "node:fs";
import { normalize, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import ora from "ora";
import { PROVIDERS, type ProviderKey } from "./constants.js";
import { loadSettings } from "./config.js";
import { createClient } from "./bot/client.js";
import { deployGuildCommands } from "./bot/deploy.js";
import { sanitizeDiscordCredential } from "./discord-input.js";

const cancelOpts = {
  onCancel: () => {
    throw Object.assign(new Error("cancelled"), { name: "AbortError" });
  },
};

function isProviderKey(k: string): k is ProviderKey {
  return k in PROVIDERS;
}

function stripPathNoise(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200d\ufeff]/g, "").trim();
}

function pickCoherentPathInput(s: string): string {
  const cleaned = stripPathNoise(s);
  if (!cleaned) return "";
  const winDriveMatches = [...cleaned.matchAll(/[a-z]:[\\/]/gi)];
  if (winDriveMatches.length > 1) {
    const last = winDriveMatches[winDriveMatches.length - 1];
    return cleaned.slice(last.index!).trim();
  }
  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    const last = lines[lines.length - 1]!;
    if (/^[a-z]:[\\/]/i.test(last) || last.startsWith("/")) return last;
  }
  return cleaned;
}

function normalizeWorkspacePath(raw: string): string {
  const picked = pickCoherentPathInput(raw);
  if (!picked) return "";
  return normalize(resolve(picked));
}

function formatDotenvPathValue(p: string): string {
  if (/[\s#'"]/.test(p)) {
    return `"${p.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  }
  return p;
}

function banner(): void {
  console.log("");
  console.log("  ┌─────────────────────────────────────┐");
  console.log("  │      agent-remote  setup              │");
  console.log("  │   Multi-IDE Discord Hub  v0.1.0     │");
  console.log("  └─────────────────────────────────────┘");
  console.log("");
}

function stepTitle(n: number, title: string): void {
  console.log("");
  console.log(`─── Step ${n} — ${title} ───`);
  console.log("");
}

async function stepWelcome(): Promise<void> {
  banner();
  console.log("Welcome to the agent-remote setup wizard.");
  console.log("");
  console.log("This will walk you through configuring your self-hosted");
  console.log("Discord hub for multi-IDE agent sessions.");
  console.log("");
  console.log("You will need:");
  console.log("  1. A Discord application (bot token + app ID)");
  console.log("  2. A dedicated Discord server (guild ID)");
  console.log("  3. PostgreSQL connection URL");
  console.log("");
}

async function stepSelectProviders(): Promise<ProviderKey[]> {
  stepTitle(1, "Select IDE providers");
  console.log("Space toggles a provider; Enter confirms.");
  console.log("");
  const { enabled } = await prompts<"enabled">(
    {
      type: "multiselect",
      name: "enabled",
      message: "Select providers to enable:",
      hint: "- Space to toggle, Enter to submit",
      choices: Object.values(PROVIDERS).map((p) => ({
        title: `${p.displayName}  (${p.description})`,
        value: p.key,
        selected: p.key === "claude",
      })),
    },
    cancelOpts,
  );
  let selected = (Array.isArray(enabled) ? (enabled as string[]) : []).filter(isProviderKey);
  if (!selected.length) {
    console.log("No providers selected — defaulting to claude.");
    selected = ["claude"];
  }
  const names = selected.map((k) => PROVIDERS[k].displayName);
  console.log(`\nEnabled: ${names.join(", ")}`);
  return selected;
}

async function stepAccessControl(): Promise<{
  ownerUserId: string;
  restrictToWhitelist: boolean;
}> {
  stepTitle(3, "Access control");
  console.log("Restrict the bot to only you (and users you whitelist) if desired.");
  console.log("You can change these later at any time with the /settings command.");
  console.log("");
  const { ownerUserId } = await prompts<"ownerUserId">(
    {
      type: "text",
      name: "ownerUserId",
      message: "Your Discord user ID (numbers only, blank to skip):",
      validate: (v: string) =>
        !v || /^\d{10,25}$/.test(v.trim())
          ? true
          : "Must be a numeric Discord user ID (or blank).",
    },
    cancelOpts,
  );
  const cleanOwner = (ownerUserId ?? "").trim();
  const { restrict } = await prompts<"restrict">(
    {
      type: "confirm",
      name: "restrict",
      message: "Restrict the bot so only whitelisted users can use it?",
      initial: true,
    },
    cancelOpts,
  );
  const restrictToWhitelist = restrict !== false;
  console.log("\nAccess control configured.");
  return { ownerUserId: cleanOwner, restrictToWhitelist };
}

async function stepDiscord(): Promise<{ botToken: string; appId: string; guildId: string }> {
  stepTitle(2, "Discord configuration");
  console.log("Create a Discord application");
  console.log("");
  console.log("  1. Go to https://discord.com/developers/applications");
  console.log("  2. Click New Application and give it a name");
  console.log("  3. Under Bot, click Reset Token and copy it");
  console.log("  4. Enable Message Content Intent under Privileged Intents");
  console.log("  5. Under OAuth2 → URL Generator, select scopes: bot + applications.commands");
  console.log("  6. Select Administrator permissions (or see docs for minimal set)");
  console.log("  7. Copy the generated invite URL and add the bot to your new, empty server");
  console.log("");
  const discord = await prompts<"botToken" | "appId" | "guildId">(
    [
      { type: "text", name: "botToken", message: "Bot token:" },
      { type: "text", name: "appId", message: "Application (client) ID:" },
      {
        type: "text",
        name: "guildId",
        message: "Guild ID (server you invited the bot to):",
      },
    ],
    cancelOpts,
  );
  const botToken = sanitizeDiscordCredential(discord.botToken ?? "");
  const appId = sanitizeDiscordCredential(discord.appId ?? "");
  const guildId = sanitizeDiscordCredential(discord.guildId ?? "");
  console.log("\nDiscord configured.");
  return { botToken, appId, guildId };
}

async function stepInfrastructure(): Promise<{
  dbUrl: string;
  workspaceCwd: string;
}> {
  stepTitle(4, "Infrastructure");
  const defaultWorkspace = normalize(resolve(process.cwd(), ".."));
  const infra = await prompts<"dbUrl" | "workspaceDir">(
    [
      {
        type: "text",
        name: "dbUrl",
        message: "PostgreSQL URL:",
        initial: "postgresql+asyncpg://agent_remote:agent_remote@localhost:5432/agent_remote",
      },
      {
        type: "text",
        name: "workspaceDir",
        message: `Agent work directory (paste a path or leave empty for default: ${defaultWorkspace}):`,
        initial: "",
      },
    ],
    cancelOpts,
  );
  const dbUrl = infra.dbUrl ?? "";
  const workspaceRaw = (infra.workspaceDir ?? "").trim();
  const workspaceCwd = workspaceRaw
    ? normalizeWorkspacePath(workspaceRaw)
    : defaultWorkspace;
  console.log("\nInfrastructure configured.");
  return { dbUrl, workspaceCwd };
}

async function stepWriteEnv(args: {
  botToken: string;
  appId: string;
  guildId: string;
  dbUrl: string;
  workspaceCwd: string;
  enabled: ProviderKey[];
  ownerUserId: string;
  restrictToWhitelist: boolean;
}): Promise<void> {
  const {
    botToken,
    appId,
    guildId,
    dbUrl,
    workspaceCwd,
    enabled,
    ownerUserId,
    restrictToWhitelist,
  } = args;
  stepTitle(5, "Write configuration");
  const encryptionKey = randomBytes(32).toString("base64url");
  const providerEnvKeys: string[] = [];
  for (const key of enabled) {
    const p = PROVIDERS[key];
    if (p) providerEnvKeys.push(...p.envKeys);
  }
  const lines = [
    "# ── agent-remote configuration ──────────────────────────────────",
    "",
    "# Discord",
    `DISCORD_BOT_TOKEN=${botToken}`,
    `DISCORD_APPLICATION_ID=${appId}`,
    `DISCORD_GUILD_ID=${guildId}`,
    "",
    "# Infrastructure",
    `DATABASE_URL=${dbUrl}`,
    "",
    "# Workspace",
    `WORKSPACE_CWD=${formatDotenvPathValue(workspaceCwd)}`,
    "",
    "# Enabled providers (comma-separated)",
    `ENABLED_PROVIDERS=${enabled.join(",")}`,
    "",
    "# Access control — can also be changed at runtime via /settings",
    `BOT_OWNER_ID=${ownerUserId}`,
    "BOT_ALLOWED_USER_IDS=",
    `BOT_RESTRICT_TO_WHITELIST=${restrictToWhitelist ? "true" : "false"}`,
    "",
    "# Encryption",
    `ENCRYPTION_KEY=${encryptionKey}`,
  ];
  if (providerEnvKeys.length) {
    lines.push("");
    lines.push("# Provider API keys (fill these in before starting sessions)");
    for (const k of providerEnvKeys) {
      lines.push(`${k}=`);
    }
  }
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const { overwrite } = await prompts<"overwrite">(
      {
        type: "confirm",
        name: "overwrite",
        message: ".env already exists. Overwrite?",
        initial: false,
      },
      cancelOpts,
    );
    if (!overwrite) {
      console.log("Skipped writing .env");
      return;
    }
  }
  writeFileSync(envPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${envPath}`);
  if (providerEnvKeys.length) {
    console.log("\nRemember to fill in your provider API keys in .env before starting sessions:");
    for (const k of providerEnvKeys) {
      console.log(`  ${k}`);
    }
  }
}

async function stepWaitForInstall(installPromise: Promise<void>): Promise<void> {
  stepTitle(6, "Server provisioning");
  console.log("The bot is online.");
  console.log("");
  console.log("  1. Go to your Discord server");
  console.log("  2. Run /install in any channel");
  console.log("  3. Click the Confirm button to provision the server");
  console.log("");
  console.log("Waiting for you to complete installation in Discord...");
  console.log("");
  console.log("Press Ctrl+C here to cancel setup (the bot will disconnect).");
  console.log("");
  const spin = ora("Bot online — waiting for /install in Discord...").start();
  try {
    await installPromise;
    spin.succeed("Installation complete");
  } finally {
    if (spin.isSpinning) spin.stop();
  }
  console.log("");
  console.log("Your Discord server is provisioned and ready.");
  console.log("");
  console.log("The setup bot has disconnected from Discord.");
  console.log("");
  console.log("To re-run setup:  bun run setup");
  console.log("");
}

export async function runWizard(): Promise<void> {
  let client: Client | null = null;
  let resolveInstall: () => void = () => {};
  let installSettled = false;
  const installPromise = new Promise<void>((r) => {
    resolveInstall = r;
  });
  const shutdown = async (): Promise<void> => {
    if (client) {
      try {
        await client.destroy();
      } catch {
      }
      client = null;
    }
  };
  const onSig = async (): Promise<void> => {
    console.log("\nSetup cancelled.");
    await shutdown();
    process.exit(1);
  };
  process.once("SIGINT", onSig);
  try {
    await stepWelcome();
    const enabled = await stepSelectProviders();
    const { botToken, appId, guildId } = await stepDiscord();
    client = createClient({
      onInstallComplete: async () => {
        if (installSettled) return;
        installSettled = true;
        await shutdown();
        resolveInstall();
      },
    });
    try {
      await client.login(botToken);
    } catch (err) {
      console.error(
        "Discord login failed. On Bun, REST uses Undici instead of native fetch. If this persists, reset the bot token in the Developer Portal and try again.",
      );
      console.error(err instanceof Error ? err.message : err);
      await shutdown();
      process.exit(1);
    }
    console.log("\nBot starting in background...");
    const { ownerUserId, restrictToWhitelist } = await stepAccessControl();
    const { dbUrl, workspaceCwd } = await stepInfrastructure();
    await stepWriteEnv({
      botToken,
      appId,
      guildId,
      dbUrl,
      workspaceCwd,
      enabled,
      ownerUserId,
      restrictToWhitelist,
    });
    loadSettings();
    try {
      await deployGuildCommands(botToken, appId, guildId);
      console.log("Reloaded config and synced slash commands to your server.");
    } catch (exc) {
      console.error(`Could not sync slash commands: ${exc}`);
      console.log("Try running /install again in a minute, or restart setup.");
    }
    await stepWaitForInstall(installPromise);
    await shutdown();
    process.off("SIGINT", onSig);
  } catch (e) {
    await shutdown();
    process.off("SIGINT", onSig);
    if (e && typeof e === "object" && "name" in e && (e as { name: string }).name === "AbortError") {
      console.log("\nSetup cancelled.");
      process.exit(1);
    }
    throw e;
  }
}
