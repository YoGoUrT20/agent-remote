#!/usr/bin/env bun
import { Command } from "commander";
import Fastify from "fastify";
import { loadSettings } from "./config.js";
import { createClient } from "./bot/client.js";
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
