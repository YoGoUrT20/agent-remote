import { Client, Events, GatewayIntentBits, Partials, Team } from "discord.js";
import { bunRestOptions } from "./bun-rest.js";
import { registerHandlers } from "./handlers/index.js";
import { ChatRegistry } from "./registry.js";
import type { PendingProjectCreate } from "./pending-project.js";
import { info, error as logError } from "../logger.js";
import { syncProviderEmoji } from "../provisioner.js";
import { loadSettings } from "../config.js";
import { startChatListRefresh } from "./chat-list.js";
import { SessionStore } from "../session-store.js";
import { AccessStore, effectiveAccess } from "../access-store.js";
import { ModelStore } from "../model-store.js";
import { ProjectStore } from "../project-store.js";
import { openDb, defaultDbPath } from "../db.js";

export interface CreateClientOptions {
  onInstallComplete?: (() => void | Promise<void>) | null;
}

export function createClient(options: CreateClientOptions = {}): Client {
  const db = openDb(defaultDbPath());

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.ThreadMember],
    rest: bunRestOptions(),
  });
  client.chatRegistry = new ChatRegistry();
  client.sessionStore = new SessionStore(db);
  client.accessStore = new AccessStore(db);
  client.modelStore = new ModelStore(db);
  client.projectStore = new ProjectStore(db);
  client.pendingProjectCreates = new Map<string, PendingProjectCreate>();
  client.modelOverrides = new Map<string, string>();
  client.pendingRateLimitRetries = new Map();
  client.onInstallComplete = options.onInstallComplete ?? null;
  registerHandlers(client);
  client.once(Events.ClientReady, async (c) => {
    info(`Discord bot ready as ${c.user.tag} (${c.user.id})`);

    /* Auto-detect the application owner and seed the access store if no owner
       is configured yet (env nor runtime). If the app belongs to a Team we use
       the team's owning user. This makes first-run zero-config. */
    try {
      const settings = loadSettings();
      const access = effectiveAccess(settings.accessEnvDefaults, client.accessStore.all());
      if (!access.ownerUserId) {
        const app = await c.application.fetch();
        let detectedId: string | null = null;
        if (app.owner instanceof Team) {
          detectedId = app.owner.ownerId ?? null;
        } else if (app.owner) {
          detectedId = app.owner.id;
        }
        if (detectedId) {
          client.accessStore.setOwner(detectedId);
          info(`Auto-detected bot owner: ${detectedId}`);
        }
      }
    } catch (e) {
      logError(`Could not auto-detect bot owner: ${String(e)}`);
    }

    // Sync provider emoji from guild so embeds can use them without re-install
    const settings = loadSettings();
    const guildId = settings.discordGuildId;
    if (guildId) {
      try {
        const guild = await c.guilds.fetch(guildId);
        await syncProviderEmoji(guild);
      } catch {}
      startChatListRefresh(client, guildId);
    }

    // Pre-load the Whisper model on startup so the first voice message has no delay.
    if (settings.voiceEnabled) {
      void (async () => {
        try {
          const { warmupWhisper } = await import("../voice/index.js");
          await warmupWhisper({
            modelId: settings.voiceWhisperModel,
            dtype: settings.voiceWhisperDtype as never,
            language: settings.voiceLanguage,
          });
          info(`Whisper model warmed up: ${settings.voiceWhisperModel}`);
        } catch (e) {
          logError(`Whisper warmup failed: ${String(e)}`);
        }
      })();
    }
  });
  client.on(Events.ShardError, (err) => {
    logError(`Discord shard error: ${String(err)}`);
  });
  return client;
}
