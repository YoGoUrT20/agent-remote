import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { loadSettings } from "../../config.js";
import {
  BOT_COMMANDS_CHANNEL,
  PROVIDERS,
  resolvedProviderEmojiURL,
  type ProviderKey,
} from "../../constants.js";
import { clearGuild, provisionGuild } from "../../provisioner.js";
import { providerKeyFromCategory, replyEphemeralEmbed } from "./utils.js";

/* ── /install command handler ── */

export async function handleInstallCommand(
  client: Client,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = loadSettings();
  const managedGuild = settings.discordGuildId;
  if (managedGuild && String(interaction.guildId) !== managedGuild) {
    await replyEphemeralEmbed(interaction, {
      title: "Wrong server",
      description:
        "This server is not the managed guild configured in `.env`. Run `agent-remote setup` to reconfigure.",
      ok: false,
    });
    return;
  }
  const enabled = settings.enabledProviderKeys().length
    ? settings.enabledProviderKeys()
    : ["claude"];
  const providerList = enabled
    .filter((k) => PROVIDERS[k])
    .map((k) => `**${PROVIDERS[k].displayName}**`)
    .join(", ");
  const embed = new EmbedBuilder()
    .setTitle("⚠️  Server Installation")
    .setColor(0xff0000)
    .setDescription(
      `This will **delete all existing channels and categories** in this server, then create a fresh layout.\n\n**Providers to install:** ${providerList}\n\nEach provider gets:\n• A category (section)\n• A \`#${BOT_COMMANDS_CHANNEL}\` channel (use \`/project open\` to add project chats)\n\nIn a **project** channel, each message runs the IDE/CLI: a thread is created (named from CLI output when possible) and a **live embed** in that thread updates with streamed output. Replies in the thread send further turns to the same session.\n\n**This action is irreversible.** Use a dedicated server.`,
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ar_install_confirm")
      .setLabel("Confirm — clear & provision")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("⚠️"),
    new ButtonBuilder()
      .setCustomId("ar_install_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], components: [row] });
}

/* ── Install confirm/cancel button handlers ── */

export async function handleInstallConfirm(
  client: Client,
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.update({
    content: "**Provisioning in progress…** This may take a moment.",
    embeds: [],
    components: [],
  });
  const guild = interaction.guild;
  if (!guild) return;
  const settings = loadSettings();
  const deleted = await clearGuild(guild);
  console.info(`Cleared ${deleted} channels from guild ${guild.id}`);
  let enabled = settings.enabledProviderKeys();
  if (!enabled.length) enabled = ["claude"];
  const result = await provisionGuild(client, guild, enabled);
  if (result.skipped.length) {
    await interaction.followUp({
      content: `**Skipped:** ${result.skipped.join(", ")}`,
      flags: MessageFlags.Ephemeral,
    });
  }
  // Send a per-provider welcome embed to each bot-commands channel
  await guild.channels.fetch();
  for (const ch of guild.channels.cache.values()) {
    if (ch.type !== ChannelType.GuildText || ch.name !== BOT_COMMANDS_CHANNEL) continue;
    const cat = ch.parent;
    if (!cat || cat.type !== ChannelType.GuildCategory) continue;
    const pk = providerKeyFromCategory(client, cat);
    if (!pk) continue;
    const provider = PROVIDERS[pk];
    const iconURL = resolvedProviderEmojiURL[pk];
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: provider.displayName, ...(iconURL ? { iconURL } : {}) })
      .setDescription(
        `This is the **${provider.displayName}** command channel.\n\n` +
        `Start the bot with \`\`\`bun run bot\`\`\`\nThen open a project using \`/project open <project name>\`.`,
      );
    try {
      await ch.send({ embeds: [embed] });
    } catch {}
  }
  const cb = client.onInstallComplete;
  if (typeof cb === "function") await Promise.resolve(cb());
}

export async function handleInstallCancel(
  _client: Client,
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.update({
    content: "**Installation cancelled.** No changes were made.",
    embeds: [],
    components: [],
  });
}
