import {
  ActionRowBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { existsSync } from "node:fs";
import { BOT_COMMANDS_CHANNEL, resolvedProviderEmojiURL, type ProviderKey } from "../constants.js";
import { loadSettings } from "../config.js";
import { listWorkspaceSubfolders, workspaceRootPath, WORKSPACE_SELECT_MAX_OPTIONS } from "../workspace-dirs.js";
import { providerKeyFromCategory } from "./handlers/utils.js";

export const CHATLIST_PICK_ID = "ar_chatlist_pick";
export const CHATLIST_NEW_MODAL_ID = "ar_chatlist_modal";
export const CHATLIST_NEW_INPUT_ID = "ar_chatlist_name";
export const NEW_PROJECT_VALUE = "__new__";

const EMBED_MARKER = "\u{1F4CB} Chats"; // 📋

interface ChatEntry {
  threadId: string;
  name: string;
  running: boolean;
  createdTimestamp: number;
}

function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function buildChatListEmbed(entries: ChatEntry[], guildId: string, providerKey: ProviderKey): EmbedBuilder {
  const iconURL = resolvedProviderEmojiURL[providerKey];
  const running = entries.filter((e) => e.running).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  const idle = entries.filter((e) => !e.running).sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  const embed = new EmbedBuilder()
    .setColor(running.length > 0 ? 0x57f287 : 0x5865f2)
    .setAuthor({ name: EMBED_MARKER, ...(iconURL ? { iconURL } : {}) });

  if (entries.length === 0) {
    embed.setDescription(
      "No chats yet.\n\nPick a project below to open one, then send a message to start a session.",
    );
    embed.setFooter({ text: "🟢 running · ⚪ idle" });
    return embed;
  }

  const lines: string[] = [];

  if (running.length > 0) {
    lines.push(`**🟢 Running (${running.length})**`);
    for (const entry of running.slice(0, 10)) {
      const link = `https://discord.com/channels/${guildId}/${entry.threadId}`;
      lines.push(`↳ [${entry.name}](${link}) · ${relativeTime(entry.createdTimestamp)}`);
    }
  }

  if (idle.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`**⚪ Recent (${idle.length})**`);
    for (const entry of idle.slice(0, 15)) {
      const link = `https://discord.com/channels/${guildId}/${entry.threadId}`;
      lines.push(`↳ [${entry.name}](${link}) · ${relativeTime(entry.createdTimestamp)}`);
    }
    if (idle.length > 15) {
      lines.push(`*…and ${idle.length - 15} more*`);
    }
  }

  embed.setDescription(lines.join("\n"));
  embed.setFooter({ text: "🟢 running · ⚪ idle · updates every 30s" });
  embed.setTimestamp();

  return embed;
}

function buildProjectSelectRow(providerKey: ProviderKey): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const settings = loadSettings();
  const root = workspaceRootPath(settings);
  const folders = existsSync(root)
    ? listWorkspaceSubfolders(settings).filter((n) => n.length <= 90)
    : [];

  const options: Array<{ label: string; value: string; description?: string; emoji?: { name: string } }> = [
    { label: "New project…", value: NEW_PROJECT_VALUE, description: "Enter a name to create a new project channel", emoji: { name: "➕" } },
  ];

  const slice = folders.slice(0, WORKSPACE_SELECT_MAX_OPTIONS - 1);
  for (const name of slice) {
    options.push({ label: name, value: name });
  }

  const placeholder = folders.length === 0
    ? "Open a project…"
    : `Open a project from workspace (${folders.length} folder${folders.length === 1 ? "" : "s"})`;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${CHATLIST_PICK_ID}:${providerKey}`)
    .setPlaceholder(placeholder)
    .addOptions(options);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

async function collectChatEntries(client: Client, category: import("discord.js").CategoryChannel): Promise<ChatEntry[]> {
  const entries: ChatEntry[] = [];
  const guild = category.guild;

  const channels = guild.channels.cache.filter(
    (ch) => ch.parentId === category.id && ch.type === ChannelType.GuildText && ch.name !== BOT_COMMANDS_CHANNEL,
  );

  for (const ch of channels.values()) {
    const textCh = ch as TextChannel;
    let threads: ThreadChannel[];
    try {
      const active = await textCh.threads.fetchActive();
      const archived = await textCh.threads.fetchArchived({ limit: 20 });
      threads = [...active.threads.values(), ...archived.threads.values()];
    } catch {
      continue;
    }

    for (const thread of threads) {
      const sess = client.chatRegistry.get(thread.id);
      let running = false;
      if (sess) {
        const sessions = await sess.adapter.listSessions();
        const ps = sessions.find((s) => s.threadId === thread.id);
        running = ps?.status === "running";
      }
      entries.push({
        threadId: thread.id,
        name: thread.name,
        running,
        createdTimestamp: thread.createdTimestamp ?? Date.now(),
      });
    }
  }

  return entries;
}

function findBotCommandsChannel(category: import("discord.js").CategoryChannel): TextChannel | null {
  const guild = category.guild;
  const ch = guild.channels.cache.find(
    (c) => c.parentId === category.id && c.type === ChannelType.GuildText && c.name === BOT_COMMANDS_CHANNEL,
  );
  return (ch as TextChannel) ?? null;
}

async function findExistingListMessage(channel: TextChannel, clientId: string): Promise<Message | null> {
  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    return messages.find(
      (m) => m.author.id === clientId && m.embeds.some((e) => e.author?.name?.includes(EMBED_MARKER)),
    ) ?? null;
  } catch {
    return null;
  }
}

export async function updateChatList(client: Client, guildId: string): Promise<void> {
  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();

  const categories = guild.channels.cache.filter((ch) => ch.type === ChannelType.GuildCategory);

  for (const cat of categories.values()) {
    const pk = providerKeyFromCategory(client, cat as import("discord.js").CategoryChannel);
    if (!pk) continue;

    const botCmdChannel = findBotCommandsChannel(cat as import("discord.js").CategoryChannel);
    if (!botCmdChannel) continue;

    const entries = await collectChatEntries(client, cat as import("discord.js").CategoryChannel);
    const embed = buildChatListEmbed(entries, guildId, pk);
    const pickerRow = buildProjectSelectRow(pk);
    const components = pickerRow ? [pickerRow] : [];

    const existing = await findExistingListMessage(botCmdChannel, client.user!.id);
    if (existing) {
      try {
        await existing.edit({ embeds: [embed], components });
      } catch {
        try {
          await botCmdChannel.send({ embeds: [embed], components });
        } catch {}
      }
    } else {
      try {
        await botCmdChannel.send({ embeds: [embed], components });
      } catch {}
    }
  }
}

let refreshInterval: ReturnType<typeof setInterval> | null = null;
let pendingUpdate: ReturnType<typeof setTimeout> | null = null;

export function startChatListRefresh(client: Client, guildId: string): void {
  updateChatList(client, guildId).catch(() => {});
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    updateChatList(client, guildId).catch(() => {});
  }, 30_000);
}

export function triggerChatListUpdate(client: Client, guildId: string): void {
  if (pendingUpdate) return;
  pendingUpdate = setTimeout(() => {
    pendingUpdate = null;
    updateChatList(client, guildId).catch(() => {});
  }, 3_000);
}
