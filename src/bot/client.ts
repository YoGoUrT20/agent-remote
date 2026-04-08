import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { bunRestOptions } from "./bun-rest.js";
import { registerHandlers } from "./handlers.js";
import { ChatRegistry } from "./registry.js";
import type { PendingProjectCreate } from "./pending-project.js";
import { logErr, logOut } from "../stdio-log.js";
import { syncProviderEmoji } from "../provisioner.js";
import { loadSettings } from "../config.js";

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
  client.pendingProjectCreates = new Map<string, PendingProjectCreate>();
  client.onInstallComplete = options.onInstallComplete ?? null;
  registerHandlers(client);
  client.once(Events.ClientReady, async (c) => {
    logOut(`Discord bot ready as ${c.user.tag} (${c.user.id})`);
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
