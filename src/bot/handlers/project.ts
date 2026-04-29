import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CategoryChannel,
  ChannelType,
  Client,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { loadSettings } from "../../config.js";
import {
  BOT_COMMANDS_CHANNEL,
  PROVIDERS,
  resolvedProviderEmojiURL,
  type ProviderKey,
} from "../../constants.js";
import {
  findExistingWorkspaceFolder,
  listWorkspaceSubfolders,
  projectFolderPath,
  workspaceRootPath,
  WORKSPACE_SELECT_MAX_OPTIONS,
} from "../../workspace-dirs.js";
import {
  PENDING_PROJECT_TTL_MS,
  PROJECT_CREATE_NO,
  PROJECT_CREATE_YES,
  PROJECT_OPEN_SELECT_ID,
  providerKeyFromCategory,
  replyEphemeralEmbed,
  slugifyProjectChannelName,
  validateProjectOpenInteraction,
  type ProjectOpenValidated,
} from "./utils.js";

/* ── Create project channel ── */

async function createProjectDiscordChannelOnly(
  client: Client,
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction,
  v: ProjectOpenValidated,
  channelName: string,
  editExtras?: { components: [] },
): Promise<void> {
  try {
    const created = await v.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: v.cat.id,
      topic: `Project for ${PROVIDERS[v.pk].displayName}. Post a message to run the CLI and open a live-updating thread.`,
    });

    client.projectStore.set(created.id, {
      channelId: created.id,
      createdAt: Date.now(),
    });

    // Send welcome embed to the new project channel
    const providerName = PROVIDERS[v.pk].displayName;
    const emojiIconURL = resolvedProviderEmojiURL[v.pk as ProviderKey];
    const welcomeEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: `Welcome to ${channelName}!`, ...(emojiIconURL ? { iconURL: emojiIconURL } : {}) })
      .setDescription(
        `Send a message here to start a new **${providerName}** session. ` +
        `Each message creates a thread with a live-updating response.\n\n` +
        `Reply inside a thread to continue the conversation in the same session.`,
      );
    try {
      await created.send({ embeds: [welcomeEmbed] });
    } catch { }

    const openedEmbed = new EmbedBuilder()
      .setTitle("Project opened")
      .setDescription(`Created ${created.toString()}. Send a message there to start a **${providerName}** session.`)
      .setColor(0x57f287)
      .setAuthor({ name: providerName, ...(emojiIconURL ? { iconURL: emojiIconURL } : {}) });
    await interaction.editReply({
      embeds: [openedEmbed],
      ...(editExtras ?? {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await replyEphemeralEmbed(
      interaction,
      {
        title: "Could not create channel",
        description: msg,
        ok: false,
      },
      editExtras,
    );
  }
}

/* ── Offer or open project ── */

async function offerOrOpenProject(
  client: Client,
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  v: ProjectOpenValidated,
  rawName: string,
  dismissPicker: boolean,
): Promise<void> {
  const extras = dismissPicker ? { components: [] as [] } : undefined;
  const channelName = slugifyProjectChannelName(rawName);
  const taken = v.cat.children.cache.some((c) => c.name === channelName);
  if (taken) {
    await replyEphemeralEmbed(
      interaction,
      {
        title: "Project already open",
        description: `A project chat \`#${channelName}\` already exists in **${v.cat.name}**. Open that channel instead.`,
        ok: false,
      },
      extras,
    );
    return;
  }
  const root = workspaceRootPath(v.settings);
  if (!existsSync(root)) {
    await replyEphemeralEmbed(
      interaction,
      {
        title: "Workspace not found",
        description: `Workspace path does not exist: \`${root}\`. Set \`WORKSPACE_CWD\` in \`.env\` to the correct path.`,
        ok: false,
      },
      extras,
    );
    return;
  }
  if (findExistingWorkspaceFolder(v.settings, channelName, rawName)) {
    await createProjectDiscordChannelOnly(client, interaction, v, channelName, extras);
    return;
  }
  const nonce = randomBytes(8).toString("hex");
  client.pendingProjectCreates.set(nonce, {
    userId: interaction.user.id,
    rawName,
    guildId: v.guild.id,
    categoryId: v.cat.id,
    expiresAt: Date.now() + PENDING_PROJECT_TTL_MS,
  });
  const embed = new EmbedBuilder()
    .setTitle("No matching folder in workspace")
    .setColor(0xfee75c)
    .setDescription(
      `There is no folder for **${rawName}** under \`${root}\` (channel would be \`#${channelName}\`).\n\nCreate the Discord project channel and a matching folder **${channelName}** on disk?`,
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PROJECT_CREATE_YES}${nonce}`)
      .setLabel("Create project")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${PROJECT_CREATE_NO}${nonce}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], components: [row] });
}

/* ── Interaction handlers ── */

export async function handleProjectOpenCommand(
  client: Client,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const v = await validateProjectOpenInteraction(client, interaction);
  if (!v) return;
  const rawName = (interaction.options.getString("name") ?? "").trim();
  if (!rawName) {
    const root = workspaceRootPath(v.settings);
    if (!existsSync(root)) {
      await replyEphemeralEmbed(interaction, {
        title: "Workspace not found",
        description: `Workspace path does not exist: \`${root}\`. Local: fix \`WORKSPACE_CWD\` or create that folder. Docker: ensure \`/workspace\` is mounted (compose bot service).`,
        ok: false,
      });
      return;
    }
    const folders = listWorkspaceSubfolders(v.settings).filter((n) => n.length <= 100);
    if (!folders.length) {
      const all = listWorkspaceSubfolders(v.settings);
      await replyEphemeralEmbed(interaction, {
        title: "No folders to pick",
        description: all.length
          ? `Subfolders in \`${root}\` are too long for the menu (max 100 characters) or only ignored dirs exist. Use \`/project open name:\` with a name.`
          : `No subfolders found in \`${root}\`. Add project directories there or use \`/project open name:\`.`,
        ok: false,
      });
      return;
    }
    const slice = folders.slice(0, WORKSPACE_SELECT_MAX_OPTIONS);
    const more = folders.length > WORKSPACE_SELECT_MAX_OPTIONS;
    const embed = new EmbedBuilder()
      .setTitle("Open project from workspace")
      .setColor(0x5865f2)
      .setDescription(
        `Pick a folder under \`${root}\` (from \`WORKSPACE_CWD\`).${more ? ` Showing **${slice.length}** of **${folders.length}** (alphabetical). Use \`/project open name:\` for any other name.` : ""}`,
      );
    const menu = new StringSelectMenuBuilder()
      .setCustomId(PROJECT_OPEN_SELECT_ID)
      .setPlaceholder("Select a workspace folder…")
      .addOptions(
        slice.map((name) => ({
          label: name,
          value: name,
        })),
      );
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }
  await offerOrOpenProject(client, interaction, v, rawName, false);
}

export async function handleProjectOpenSelect(
  client: Client,
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  await interaction.deferUpdate();
  const v = await validateProjectOpenInteraction(client, interaction, { components: [] });
  if (!v) return;
  const picked = interaction.values[0];
  if (!picked) return;
  await offerOrOpenProject(client, interaction, v, picked, true);
}

export async function handleProjectCreateConfirm(
  client: Client,
  interaction: ButtonInteraction,
): Promise<void> {
  const nonce = interaction.customId.slice(PROJECT_CREATE_YES.length);
  const pending = client.pendingProjectCreates.get(nonce);
  if (!pending || pending.expiresAt < Date.now()) {
    client.pendingProjectCreates.delete(nonce);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Confirmation expired")
          .setDescription("Run `/project open` again.")
          .setColor(0xed4245),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== pending.userId) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Not your confirmation")
          .setDescription("Only the member who ran the command can confirm.")
          .setColor(0xed4245),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferUpdate();
  client.pendingProjectCreates.delete(nonce);
  const settings = loadSettings();
  const guild = await client.guilds.fetch(pending.guildId).catch(() => null);
  if (!guild) {
    await replyEphemeralEmbed(interaction, {
      title: "Guild unavailable",
      description: "Could not load the server. Try again from `/project open`.",
      ok: false,
    }, { components: [] });
    return;
  }
  const catCh = await guild.channels.fetch(pending.categoryId).catch(() => null);
  if (!catCh || catCh.type !== ChannelType.GuildCategory) {
    await replyEphemeralEmbed(interaction, {
      title: "Category missing",
      description: "IDE category no longer exists. Run `/project open` again.",
      ok: false,
    }, { components: [] });
    return;
  }
  const cat = catCh as CategoryChannel;
  const pk = providerKeyFromCategory(client, cat);
  if (!pk) {
    await replyEphemeralEmbed(interaction, {
      title: "Unknown provider",
      description: "Could not map this category. Run `/project open` again.",
      ok: false,
    }, { components: [] });
    return;
  }
  const v: ProjectOpenValidated = { settings, guild, cat, pk };
  const channelName = slugifyProjectChannelName(pending.rawName);
  if (v.cat.children.cache.some((c) => c.name === channelName)) {
    await replyEphemeralEmbed(interaction, {
      title: "Project already open",
      description: `A project chat \`#${channelName}\` already exists in **${v.cat.name}**.`,
      ok: false,
    }, { components: [] });
    return;
  }
  const root = workspaceRootPath(settings);
  if (!existsSync(root)) {
    await replyEphemeralEmbed(interaction, {
      title: "Workspace not found",
      description: `Workspace path does not exist: \`${root}\`. Docker: mount host workspace at \`/workspace\` (see compose bot service).`,
      ok: false,
    }, { components: [] });
    return;
  }
  if (!findExistingWorkspaceFolder(settings, channelName, pending.rawName)) {
    try {
      mkdirSync(projectFolderPath(settings, channelName), { recursive: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await replyEphemeralEmbed(interaction, {
        title: "Could not create folder",
        description: msg,
        ok: false,
      }, { components: [] });
      return;
    }
  }
  await createProjectDiscordChannelOnly(client, interaction, v, channelName, { components: [] });
}

export async function handleProjectCreateCancel(
  client: Client,
  interaction: ButtonInteraction,
): Promise<void> {
  const nonce = interaction.customId.slice(PROJECT_CREATE_NO.length);
  const pending = client.pendingProjectCreates.get(nonce);
  if (!pending || pending.expiresAt < Date.now()) {
    client.pendingProjectCreates.delete(nonce);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Confirmation expired")
          .setDescription("Run `/project open` again.")
          .setColor(0xed4245),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== pending.userId) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Not your confirmation")
          .setDescription("Only the member who ran the command can cancel.")
          .setColor(0xed4245),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  client.pendingProjectCreates.delete(nonce);
  await interaction.deferUpdate();
  await replyEphemeralEmbed(
    interaction,
    {
      title: "Cancelled",
      description: "No project channel or folder was created.",
      ok: false,
    },
    { components: [] },
  );
}
