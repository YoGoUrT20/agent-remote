import {
  ActionRowBuilder,
  ChannelType,
  Client,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { existsSync } from "node:fs";
import { loadSettings } from "../../config.js";
import { workspaceRootPath } from "../../workspace-dirs.js";
import {
  CHATLIST_NEW_INPUT_ID,
  CHATLIST_NEW_MODAL_ID,
  NEW_PROJECT_VALUE,
  triggerChatListUpdate,
} from "../chat-list.js";
import {
  providerKeyFromCategory,
  replyEphemeralEmbed,
  type ProjectOpenValidated,
} from "./utils.js";
import { offerOrOpenProject } from "./project.js";

/* ── Select menu: pick workspace folder or trigger "new project" modal ── */

export async function handleChatlistPick(
  client: Client,
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const picked = interaction.values[0];
  if (!picked) return;

  if (picked === NEW_PROJECT_VALUE) {
    const modal = new ModalBuilder()
      .setCustomId(CHATLIST_NEW_MODAL_ID)
      .setTitle("New project");

    const input = new TextInputBuilder()
      .setCustomId(CHATLIST_NEW_INPUT_ID)
      .setLabel("Project name or folder")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("my-app")
      .setMinLength(1)
      .setMaxLength(80)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  /* Open the project ephemerally so the chat list message is never touched */
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const settings = loadSettings();
  const managed = settings.discordGuildId;
  if (managed && String(interaction.guildId) !== managed) {
    await replyEphemeralEmbed(interaction, { title: "Wrong server", description: "This server is not the managed guild from configuration.", ok: false });
    return;
  }

  const ch = interaction.channel;
  if (!ch || ch.type !== ChannelType.GuildText) {
    await replyEphemeralEmbed(interaction, { title: "Wrong channel type", description: "Use this from a text channel.", ok: false });
    return;
  }

  const cat = ch.parent;
  if (!cat || cat.type !== ChannelType.GuildCategory) {
    await replyEphemeralEmbed(interaction, { title: "Category not found", description: "Could not map this channel to an IDE category.", ok: false });
    return;
  }

  const pk = providerKeyFromCategory(client, cat);
  if (!pk) {
    await replyEphemeralEmbed(interaction, { title: "Unknown provider", description: "Could not identify provider from this category.", ok: false });
    return;
  }

  const guild = interaction.guild;
  if (!guild) return;

  const v: ProjectOpenValidated = { settings, guild, cat, pk };
  await offerOrOpenProject(client, interaction, v, picked, false);
  if (interaction.guildId) triggerChatListUpdate(client, interaction.guildId);
}

/* ── Modal submit: user entered a name for the new project ── */

export async function handleChatlistModal(
  client: Client,
  interaction: ModalSubmitInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rawName = interaction.fields.getTextInputValue(CHATLIST_NEW_INPUT_ID).trim();
  if (!rawName) {
    await replyEphemeralEmbed(interaction, { title: "Name required", description: "Please enter a project name.", ok: false });
    return;
  }

  /* Resolve channel → category → provider */
  const settings = loadSettings();
  const managed = settings.discordGuildId;
  if (managed && String(interaction.guildId) !== managed) {
    await replyEphemeralEmbed(interaction, { title: "Wrong server", description: "This server is not the managed guild from configuration.", ok: false });
    return;
  }

  const ch = interaction.channel;
  if (!ch || ch.type !== ChannelType.GuildText) {
    await replyEphemeralEmbed(interaction, { title: "Wrong channel type", description: "Use this from a text channel.", ok: false });
    return;
  }

  const cat = ch.parent;
  if (!cat || cat.type !== ChannelType.GuildCategory) {
    await replyEphemeralEmbed(interaction, { title: "Category not found", description: "Could not map this channel to an IDE category.", ok: false });
    return;
  }

  const pk = providerKeyFromCategory(client, cat);
  if (!pk) {
    await replyEphemeralEmbed(interaction, { title: "Unknown provider", description: "Could not identify provider from this category.", ok: false });
    return;
  }

  const guild = interaction.guild;
  if (!guild) return;

  const root = workspaceRootPath(settings);
  if (!existsSync(root)) {
    await replyEphemeralEmbed(interaction, {
      title: "Workspace not found",
      description: `Workspace path does not exist: \`${root}\`. Set \`WORKSPACE_CWD\` in \`.env\`.`,
      ok: false,
    });
    return;
  }

  const v: ProjectOpenValidated = { settings, guild, cat, pk };
  await offerOrOpenProject(client, interaction, v, rawName, false);
  if (interaction.guildId) triggerChatListUpdate(client, interaction.guildId);
}
