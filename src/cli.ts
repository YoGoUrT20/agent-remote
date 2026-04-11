#!/usr/bin/env bun
import { Command } from "commander";
import Fastify from "fastify";
import { loadSettings } from "./config.js";
import { createClient } from "./bot/client.js";
import { deployGuildCommands } from "./bot/deploy.js";
import { runWizard } from "./setup-wizard.js";
import { logErr, logOut } from "./stdio-log.js";

const program = new Command();

program.name("agent-remote").description("Multi-IDE Discord Hub").version("0.1.0");

program.option("-v, --verbose", "enable verbose logging");

program.hook("preAction", (thisCommand) => {
  if (thisCommand.opts().verbose) {
    process.env.DEBUG = "discord:*";
  }
});

program
  .command("setup")
  .description("Run the interactive first-time setup wizard")
  .action(async () => {
    await runWizard();
  });

program
  .command("bot")
  .description("Start the Discord bot process")
  .action(async () => {
    const settings = loadSettings();
    if (!settings.discordBotToken) {
      logErr("Error: DISCORD_BOT_TOKEN is not set. Run `agent-remote setup` first.");
      process.exit(1);
    }
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
