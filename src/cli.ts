#!/usr/bin/env bun
import { Command } from "commander";
import Fastify from "fastify";
import { mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSettings } from "./config.js";
import { createClient } from "./bot/client.js";
import { deployGuildCommands } from "./bot/deploy.js";
import { runWizard } from "./setup-wizard.js";
import { logErr, logOut } from "./stdio-log.js";

const DATA_DIR = join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".agent-remote");
const PID_FILE = join(DATA_DIR, "bot.pid");

function writePidFile(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid), "utf-8");
}

function removePidFile(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {}
}

function readPidFile(): number | null {
  try {
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const program = new Command();

program.name("agent-remote").description("Multi-IDE Discord Hub").version("0.1.0");

program.option("-v, --verbose", "enable verbose logging");

program.hook("preAction", (thisCommand) => {
  if (thisCommand.opts().verbose) {
    process.env.DEBUG = "discord:*";
  }
});

async function startBot(): Promise<void> {
  const settings = loadSettings();
  if (!settings.discordBotToken) {
    logErr("Error: DISCORD_BOT_TOKEN is not set. Run `agent-remote setup` first.");
    process.exit(1);
  }

  const existingPid = readPidFile();
  if (existingPid !== null && isProcessRunning(existingPid)) {
    logErr(`Bot is already running (PID ${existingPid}). Use "agent-remote stop" to stop it first.`);
    process.exit(1);
  }

  writePidFile();
  const cleanup = () => removePidFile();
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  process.on("unhandledRejection", (reason) => {
    logErr(`Unhandled rejection: ${String(reason)}`);
  });
  /* Sync slash commands on every boot so new/updated commands show up
     without re-running `setup`. Cheap, idempotent PUT to the guild. */
  if (settings.discordApplicationId && settings.discordGuildId) {
    try {
      await deployGuildCommands(
        settings.discordBotToken,
        settings.discordApplicationId,
        settings.discordGuildId,
      );
      logOut("Slash commands synced to guild.");
    } catch (e) {
      logErr(`Could not sync slash commands: ${String(e)}`);
    }
  } else {
    logErr(
      "Skipping slash-command sync: DISCORD_APPLICATION_ID or DISCORD_GUILD_ID missing from .env.",
    );
  }

  const client = createClient();
  logOut("Connecting to Discord…");
  try {
    await client.login(settings.discordBotToken);
  } catch (e) {
    logErr(`Discord login failed: ${String(e)}`);
    process.exit(1);
  }
}

program
  .command("setup")
  .description("Run the interactive first-time setup wizard")
  .action(async () => {
    await runWizard();
    logOut("Starting the bot...");
    await startBot();
  });

program
  .command("bot")
  .description("Start the Discord bot process")
  .option("-d, --detach", "run the bot in the background (detached)")
  .action(async (opts: { detach?: boolean }) => {
    if (opts.detach) {
      const { spawn } = await import("node:child_process");
      const args = process.argv.slice(1).filter((a) => a !== "--detach" && a !== "-d");
      const logFile = join(DATA_DIR, "bot.log");
      mkdirSync(DATA_DIR, { recursive: true });
      const out = openSync(logFile, "a");
      const child = spawn(process.argv[0], args, {
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
      logOut(`Bot started in background (PID ${child.pid}). Logs: ${logFile}`);
      logOut('Run "agent-remote stop" to stop the bot.');
      process.exit(0);
    }
    await startBot();
  });

program
  .command("stop")
  .description("Stop the detached bot process")
  .action(() => {
    const pid = readPidFile();
    if (pid === null) {
      logErr("No PID file found. The bot may not be running.");
      process.exit(1);
    }
    if (!isProcessRunning(pid)) {
      logOut(`Bot process (PID ${pid}) is not running. Cleaning up stale PID file.`);
      removePidFile();
      process.exit(0);
    }
    try {
      process.kill(pid, "SIGTERM");
      logOut(`Sent SIGTERM to bot process (PID ${pid}).`);
    } catch (e) {
      logErr(`Failed to stop bot (PID ${pid}): ${String(e)}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Check whether the bot is running")
  .action(() => {
    const pid = readPidFile();
    if (pid === null) {
      logOut("Bot is not running (no PID file).");
      process.exit(1);
    }
    if (isProcessRunning(pid)) {
      logOut(`Bot is running (PID ${pid}).`);
    } else {
      logOut(`Bot is not running (stale PID ${pid}). Cleaning up.`);
      removePidFile();
      process.exit(1);
    }
  });

program
  .command("migrate")
  .description("Run database migrations")
  .action(() => {
    console.log("No Node migration runner is configured yet. Add SQL migrations if needed.");
  });

program
  .command("api")
  .description("Start the HTTP API process")
  .action(async () => {
    const settings = loadSettings();
    const app = Fastify({ logger: false });
    app.get("/health", async () => ({ ok: true }));
    await app.listen({ port: settings.apiPort, host: settings.apiHost });
    console.log(`API listening on ${settings.apiHost}:${settings.apiPort}`);
  });

await program.parseAsync(process.argv);
