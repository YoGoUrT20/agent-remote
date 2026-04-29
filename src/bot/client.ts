import { join } from "node:path";
import { Client, Events, GatewayIntentBits, Partials, Team } from "discord.js";
import { bunRestOptions } from "./bun-rest.js";
import { registerHandlers } from "./handlers/index.js";
import { ChatRegistry } from "./registry.js";
import type { PendingProjectCreate } from "./pending-project.js";
import { logErr, logOut } from "../stdio-log.js";
import { syncProviderEmoji } from "../provisioner.js";
import { loadSettings } from "../config.js";
import { SessionStore } from "../session-store.js";
import {
  AccessStore,
  defaultAccessStorePath,
  effectiveAccess,
} from "../access-store.js";
import { ModelStore, defaultModelStorePath } from "../model-store.js";
import { ProjectStore } from "../project-store.js";

export interface CreateClientOptions {
  onInstallComplete?: (() => void | Promise<void>) | null;
}

export function createClient(options: CreateClientOptions = {}): Client {
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
  client.sessionStore = new SessionStore(
    join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".agent-remote", "sessions.json"),
  );
  client.accessStore = new AccessStore(defaultAccessStorePath());
  client.modelStore = new ModelStore(defaultModelStorePath());
  client.projectStore = new ProjectStore(
    join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".agent-remote", "projects.json"),
  );
  client.pendingProjectCreates = new Map<string, PendingProjectCreate>();
  client.modelOverrides = new Map<string, string>();
  client.onInstallComplete = options.onInstallComplete ?? null;
  registerHandlers(client);
  client.once(Events.ClientReady, async (c) => {
    logOut(`Discord bot ready as ${c.user.tag} (${c.user.id})`);

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
          logOut(`Auto-detected bot owner: ${detectedId}`);
        }
      }
    } catch (e) {
      logErr(`Could not auto-detect bot owner: ${String(e)}`);
    }

    // Sync provider emoji from guild so embeds can use them without re-install
    const settings = loadSettings();
    const guildId = settings.discordGuildId;
    if (guildId) {
      try {
        const guild = await c.guilds.fetch(guildId);
        await syncProviderEmoji(guild);
      } catch {}
    }
  });
  client.on(Events.ShardError, (err) => {
    logErr(`Discord shard error: ${String(err)}`);
  });
  return client;
}
