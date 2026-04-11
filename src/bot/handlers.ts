import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CategoryChannel,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  Guild,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  Team,
  ThreadAutoArchiveDuration,
  UserSelectMenuBuilder,
  type APIEmbedField,
  type BaseMessageOptions,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type MessageActionRowComponentBuilder,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
  type ThreadChannel,
} from "discord.js";
import type { BaseAdapter } from "../adapters/base.js";
import type { Settings } from "../config.js";
import { loadSettings } from "../config.js";
import {
  effectiveAccess,
  isUserAllowed,
  type EffectiveAccess,
} from "../access-store.js";
import { runSerial } from "./serial-queue.js";
import { buildChatAdapter } from "../adapters/factory.js";
import {
  BOT_COMMANDS_CHANNEL,
  PROVIDERS,
  resolvedProviderEmojiURL,
  normalizeCategoryChannelName,
  type ProviderKey,
} from "../constants.js";
import { clearGuild, provisionGuild } from "../provisioner.js";
import {
  findExistingWorkspaceFolder,
  listWorkspaceSubfolders,
  projectFolderPath,
  workspaceRootPath,
  WORKSPACE_SELECT_MAX_OPTIONS,
} from "../workspace-dirs.js";

function persistSessionId(client: Client, threadId: string, adapter: BaseAdapter, providerKey: string, cwd?: string): void {
  if ("getSessionId" in adapter && typeof adapter.getSessionId === "function") {
    const sid = adapter.getSessionId(threadId);
    if (sid) {
      client.sessionStore.set(threadId, { sessionId: sid, cwd: cwd ?? "", providerKey });
    }
  }
}

const MAX_EMBED_DESC = 4080;
const PROJECT_OPEN_SELECT_ID = "ar_project_open_pick";
const PROJECT_CREATE_YES = "ar_pc_yes:";
const PROJECT_CREATE_NO = "ar_pc_no:";
const PENDING_PROJECT_TTL_MS = 15 * 60 * 1000;

const SETTINGS_SET_OWNER = "ar_settings_set_owner";
const SETTINGS_ADD_ALLOWED = "ar_settings_add_allowed";
const SETTINGS_REMOVE_ALLOWED = "ar_settings_remove_allowed";
const SETTINGS_TOGGLE_RESTRICT = "ar_settings_toggle_restrict";
const SETTINGS_CLEAR_ALLOWED = "ar_settings_clear_allowed";
const SETTINGS_CLAIM_OWNER = "ar_settings_claim_owner";
const SETTINGS_REFRESH = "ar_settings_refresh";
const SETTINGS_REMOVE_OWNER = "ar_settings_remove_owner";
const SETTINGS_DETECT_OWNER = "ar_settings_detect_owner";

const MAX_WHITELIST_REMOVE_OPTIONS = 25;

function currentAccess(client: Client): EffectiveAccess {
  const settings = loadSettings();
  return effectiveAccess(settings.accessEnvDefaults, client.accessStore.all());
}

function interactionMemberHasAdmin(interaction: Interaction): boolean {
  const member = interaction.member;
  if (!member) return false;
  const perms = (member as { permissions?: unknown }).permissions;
  if (perms && typeof (perms as { has?: unknown }).has === "function") {
    try {
      return (perms as { has: (flag: bigint) => boolean }).has(
        PermissionFlagsBits.Administrator,
      );
    } catch {
      return false;
    }
  }
  return false;
}

function isSettingsAuthorized(
  interaction: Interaction,
  access: EffectiveAccess,
): boolean {
  const userId = interaction.user.id;
  if (access.ownerUserId) return userId === access.ownerUserId;
  return interactionMemberHasAdmin(interaction);
}

async function resolveUserLabel(client: Client, userId: string): Promise<string> {
  try {
    const u = await client.users.fetch(userId);
    return u.tag ?? u.username ?? userId;
  } catch {
    return userId;
  }
}

function bulletedMentionList(userIds: string[]): string {
  if (userIds.length === 0) return "_(empty)_";
  return userIds.map((id) => `• <@${id}>  \`${id}\``).join("\n");
}

async function buildSettingsPanel(
  client: Client,
  access: EffectiveAccess,
): Promise<BaseMessageOptions> {
  const settings = loadSettings();
  const envDefaults = settings.accessEnvDefaults;
  const overrides = client.accessStore.all();

  const ownerLine = access.ownerUserId
    ? `<@${access.ownerUserId}>  \`${access.ownerUserId}\``
    : "_(not set)_";
  const restrictLine = access.restrictToWhitelist
    ? ":lock: **On** — only the owner and whitelisted users may use the bot"
    : ":unlock: **Off** — anyone in the server may use the bot";
  const whitelistLine = bulletedMentionList(access.allowedUserIds);

  const sources: string[] = [];
  sources.push(
    `Owner: ${
      overrides.ownerUserId
        ? "`/settings` override"
        : envDefaults.ownerUserId
          ? "`BOT_OWNER_ID` env"
          : "unset"
    }`,
  );
  sources.push(
    `Whitelist: ${
      overrides.allowedUserIds !== undefined
        ? "`/settings` override"
        : envDefaults.allowedUserIds.length > 0
          ? "`BOT_ALLOWED_USER_IDS` env"
          : "unset"
    }`,
  );
  sources.push(
    `Restrict mode: ${
      overrides.restrictToWhitelist !== undefined
        ? "`/settings` override"
        : process.env.BOT_RESTRICT_TO_WHITELIST
          ? "`BOT_RESTRICT_TO_WHITELIST` env"
          : "default (on)"
    }`,
  );

  const fields: APIEmbedField[] = [
    { name: "Owner", value: ownerLine, inline: false },
    { name: "Restrict to whitelist", value: restrictLine, inline: false },
    { name: `Whitelist (${access.allowedUserIds.length})`, value: whitelistLine, inline: false },
    { name: "Value sources", value: sources.map((s) => `• ${s}`).join("\n"), inline: false },
  ];

  const embed = new EmbedBuilder()
    .setTitle("Access control — /settings")
    .setColor(access.restrictToWhitelist ? 0xfee75c : 0x5865f2)
    .setDescription(
      "Configure who is allowed to use this bot.\n" +
        "Runtime overrides set here win over the values in `.env`. " +
        "The owner is always implicitly allowed.",
    )
    .addFields(fields);

  const setOwnerRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(SETTINGS_SET_OWNER)
      .setPlaceholder("Set bot owner (replaces current owner)")
      .setMinValues(1)
      .setMaxValues(1),
  );

  const addAllowedRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(SETTINGS_ADD_ALLOWED)
      .setPlaceholder("Add users to the whitelist")
      .setMinValues(1)
      .setMaxValues(10),
  );

  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    setOwnerRow as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>,
    addAllowedRow as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>,
  ];

  if (access.allowedUserIds.length > 0) {
    const slice = access.allowedUserIds.slice(0, MAX_WHITELIST_REMOVE_OPTIONS);
    const labels = await Promise.all(slice.map((id) => resolveUserLabel(client, id)));
    const removeMenu = new StringSelectMenuBuilder()
      .setCustomId(SETTINGS_REMOVE_ALLOWED)
      .setPlaceholder("Remove users from the whitelist")
      .setMinValues(1)
      .setMaxValues(slice.length)
      .addOptions(
        slice.map((id, i) => ({
          label: labels[i]!.slice(0, 100),
          description: id.slice(0, 100),
          value: id,
        })),
      );
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        removeMenu,
      ) as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>,
    );
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>();
  buttons.addComponents(
    new ButtonBuilder()
      .setCustomId(SETTINGS_TOGGLE_RESTRICT)
      .setLabel(access.restrictToWhitelist ? "Disable restriction" : "Enable restriction")
      .setStyle(access.restrictToWhitelist ? ButtonStyle.Secondary : ButtonStyle.Primary),
  );
  if (access.allowedUserIds.length > 0) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(SETTINGS_CLEAR_ALLOWED)
        .setLabel("Clear whitelist")
        .setStyle(ButtonStyle.Danger),
    );
  }
  if (!access.ownerUserId) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(SETTINGS_CLAIM_OWNER)
        .setLabel("Claim owner (me)")
        .setStyle(ButtonStyle.Success),
    );
  } else {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(SETTINGS_REMOVE_OWNER)
        .setLabel("Remove owner")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  buttons.addComponents(
    new ButtonBuilder()
      .setCustomId(SETTINGS_DETECT_OWNER)
      .setLabel("Detect from app")
      .setStyle(ButtonStyle.Secondary),
  );
  buttons.addComponents(
    new ButtonBuilder()
      .setCustomId(SETTINGS_REFRESH)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
  );
  rows.push(buttons as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>);

  return { embeds: [embed], components: rows };
}

async function rebuildSettingsPanel(
  client: Client,
  interaction: RepliableInteraction,
): Promise<void> {
  const access = currentAccess(client);
  const panel = await buildSettingsPanel(client, access);
  await interaction.editReply(panel);
}

function isSettingsInteraction(interaction: Interaction): boolean {
  if (interaction.isChatInputCommand() && interaction.commandName === "settings") return true;
  if (
    interaction.isButton() ||
    interaction.isStringSelectMenu() ||
    interaction.isUserSelectMenu()
  ) {
    const id = (interaction as { customId?: string }).customId ?? "";
    return id.startsWith("ar_settings_");
  }
  return false;
}

async function replyBlockedByWhitelist(
  interaction: RepliableInteraction,
  access: EffectiveAccess,
): Promise<void> {
  const contact = access.ownerUserId
    ? ` Ask <@${access.ownerUserId}> to add you via \`/settings\`.`
    : "";
  const embed = new EmbedBuilder()
    .setTitle("Access restricted")
    .setDescription(`This bot is restricted to whitelisted users.${contact}`)
    .setColor(0xed4245);
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [embed], components: [] });
    } else {
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  } catch {}
}

async function replyNotSettingsAuthorized(
  interaction: RepliableInteraction,
  access: EffectiveAccess,
): Promise<void> {
  const desc = access.ownerUserId
    ? `Only the bot owner (<@${access.ownerUserId}>) can modify these settings.`
    : "You need the **Administrator** permission to modify these settings until an owner is set.";
  const embed = new EmbedBuilder()
    .setTitle("Not authorized")
    .setDescription(desc)
    .setColor(0xed4245);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed], components: [] });
  } else {
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

type ProjectOpenValidated = {
  settings: Settings;
  guild: Guild;
  cat: CategoryChannel;
  pk: ProviderKey;
};

function discordErrorCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  
  const maybe = err as { code?: unknown };
  return typeof maybe.code === "number" ? maybe.code : null;
}

function isIgnorableInteractionError(err: unknown): boolean {
  const code = discordErrorCode(err);
  return code === 10062 || code === 40060;
}

function slugifyDiscordSegment(raw: string, maxLen: number): string {
  const s = raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen);
  if (s.length > 0) return s;
  return "agent";
}

function slugifyProjectChannelName(raw: string): string {
  let s = slugifyDiscordSegment(raw.trim(), 90);

  if (s === BOT_COMMANDS_CHANNEL) s = `${s}-work`;
  return s;
}

function slugifyThreadTitle(raw: string): string {
  const first = raw.trim().split(/\r?\n/)[0] ?? "";
  return slugifyDiscordSegment(first || raw, 95);
}

function projectWorkspaceCwd(settings: Settings, projectChannelName: string): string | undefined {
  const sub = join(workspaceRootPath(settings), projectChannelName);
  if (existsSync(sub)) return sub;
  return undefined;
}


async function replyEphemeralEmbed(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction,
  payload: { title: string; description: string; ok?: boolean },
  editExtras?: { components: [] },
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle(payload.title)
    .setDescription(payload.description)
    .setColor(payload.ok === false ? 0xed4245 : payload.ok === true ? 0x57f287 : 0x5865f2);
  await interaction.editReply({
    embeds: [embed],
    ...(editExtras ?? {}),
  });
}

async function validateProjectOpenInteraction(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  errorExtras?: { components: [] },
): Promise<ProjectOpenValidated | null> {
  const settings = loadSettings();
  const managed = settings.discordGuildId;
  if (managed && String(interaction.guildId) !== managed) {
    await replyEphemeralEmbed(
      interaction,
      {
        title: "Wrong server",
        description: "This server is not the managed guild from configuration.",
        ok: false,
      },
      errorExtras,
    );
    return null;
  }
  const ch = interaction.channel;
  if (!ch || ch.type !== ChannelType.GuildText) {
    await replyEphemeralEmbed(
      interaction,
      {
        title: "Wrong channel type",
        description: "Use this command from a text channel.",
        ok: false,
      },
      errorExtras,
    );
    return null;
  }
  if (ch.name !== BOT_COMMANDS_CHANNEL) {
    await replyEphemeralEmbed(
      interaction,
      {
        title: "Wrong channel",
        description: `Run this from \`#${BOT_COMMANDS_CHANNEL}\` inside an IDE category.`,
        ok: false,
      },
      errorExtras,
    );
    return null;
  }
  const cat = ch.parent;
  if (cat?.type !== ChannelType.GuildCategory) {
    await replyEphemeralEmbed(
      interaction,
      {
        title: "Category not found",
        description: "Could not map this channel to an IDE category.",
        ok: false,
      },
      errorExtras,
    );
    return null;
  }
  const pk = providerKeyFromCategory(cat);
  if (!pk) {
    await replyEphemeralEmbed(
      interaction,
      {
        title: "Unknown provider",
        description: "Could not map this category to a provider.",
        ok: false,
      },
      errorExtras,
    );
    return null;
  }
  let enabledList = settings.enabledProviderKeys();
  if (!enabledList.length) enabledList = ["claude"];
  if (!enabledList.includes(pk)) {
    await replyEphemeralEmbed(
      interaction,
      {
        title: "Provider disabled",
        description: `Provider \`${pk}\` is not enabled for this installation.`,
        ok: false,
      },
      errorExtras,
    );
    return null;
  }
  const guild = interaction.guild;
  if (!guild) {
    await replyEphemeralEmbed(
      interaction,
      {
        title: "Guild missing",
        description: "Guild not found.",
        ok: false,
      },
      errorExtras,
    );
    return null;
  }
  return { settings, guild, cat, pk };
}

async function createProjectDiscordChannelOnly(
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
    await createProjectDiscordChannelOnly(interaction, v, channelName, extras);
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

async function streamAssistantRepliesEmbed(
  thread: ThreadChannel,
  adapter: BaseAdapter,
  options: { fallbackThreadTitle: string; providerKey: ProviderKey; skipRename?: boolean },
): Promise<void> {
  const { fallbackThreadTitle, providerKey, skipRename = false } = options;
  let reasoning = "";
  let response = "";
  let lastEdit = 0;
  let named = skipRename;
  let hasError = false;

  const provider = PROVIDERS[providerKey];
  const providerName = provider?.displayName ?? providerKey;


  const formatBody = (): string => {
    let body = "";
    if (reasoning.trim()) {
      const quoted = reasoning.trim().split("\n").map((l) => `> ${l}`).join("\n");
      body += quoted + "\n\n";
    }
    body += response.trim();
    return body.trim();
  };

  const emojiURL = resolvedProviderEmojiURL[providerKey];
  const buildEmbed = (description: string, color: number) => {
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: providerName, ...(emojiURL ? { iconURL: emojiURL } : {}) })
      .setDescription(
        description.length > MAX_EMBED_DESC ? `${description.slice(0, MAX_EMBED_DESC)}…` : description,
      );
    return embed;
  };

  const statusMsg = await thread.send({
    embeds: [buildEmbed(":hourglass_flowing_sand: Thinking...", 0x5865f2)],
  });

  const render = async (throttle: boolean) => {
    const body = formatBody() || "Thinking...";
    const now = performance.now() / 1000;
    if (throttle && now - lastEdit < 0.85) return;
    lastEdit = now;
    try {
      await statusMsg.edit({
        embeds: [buildEmbed(body, 0x5865f2)],
      });
    } catch {
    }
  };

  for await (const event of adapter.streamEvents()) {
    if (event.type === "text_delta") {
      const isReasoning = event.metadata?.streamKind === "reasoning_text";
      if (isReasoning) {
        reasoning += event.data;
      } else {
        response += event.data;
      }
      await render(true);
    } else if (event.type === "error") {
      const err = (event.data || "error").slice(0, MAX_EMBED_DESC);
      try {
        await statusMsg.edit({
          embeds: [buildEmbed(err, 0xed4245)],
        });
      } catch {
        await thread.send({ embeds: [buildEmbed(err, 0xed4245)] });
      }
      hasError = true;
    } else if (event.type === "done") {
      if (!hasError) {
        const body = formatBody();
        try {
          await statusMsg.edit({
            embeds: [buildEmbed(body || "Done.", 0x57f287)],
          });
        } catch {
        }
      }
      break; // Turn complete — return so the next turn can create a new embed
    }
  }

  if (!named) {
    if ("getThreadTitle" in adapter && typeof adapter.getThreadTitle === "function") {
      const cliTitle = adapter.getThreadTitle(thread.id);
      if (cliTitle) {
        try {
          await thread.setName(slugifyThreadTitle(cliTitle));
          named = true;
        } catch {
        }
      }
    }
    if (!named) {
      try {
        await thread.setName(slugifyThreadTitle(fallbackThreadTitle));
      } catch {
      }
    }
  }
}

function providerKeyFromCategory(category: CategoryChannel | null): ProviderKey | null {
  if (!category) return null;
  const normalized = normalizeCategoryChannelName(category.name);
  for (const [, p] of Object.entries(PROVIDERS)) {
    if (p.categoryName === normalized) return p.key as ProviderKey;
  }
  return null;
}

function categoryFromProjectParent(parentChannel: {
  parent: CategoryChannel | null;
}): CategoryChannel | null {
  const p = parentChannel.parent;
  if (!p || p.type !== ChannelType.GuildCategory) return null;
  return p;
}

export function registerHandlers(client: Client): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        if (
          interaction.commandName === "project" &&
          interaction.options.getSubcommand() === "open"
        ) {
          const focused = interaction.options.getFocused(true);
          if (focused.name !== "name") {
            await interaction.respond([]);
            return;
          }
          const settings = loadSettings();
          const root = workspaceRootPath(settings);
          if (!existsSync(root)) {
            await interaction.respond([]);
            return;
          }
          let folders = listWorkspaceSubfolders(settings).filter((n) => n.length <= 100);
          const needle = focused.value.trim().toLowerCase();
          if (needle.length > 0) {
            folders = folders.filter((f) => f.toLowerCase().includes(needle));
          }
          const choices = folders.slice(0, WORKSPACE_SELECT_MAX_OPTIONS).map((name) => ({
            name: name.slice(0, 100),
            value: name.slice(0, 100),
          }));
          await interaction.respond(choices);
          return;
        }
        await interaction.respond([]);
        return;
      }

      /* Whitelist gate — applies to every interaction except /settings (so the
         owner can always manage access). */
      if (!isSettingsInteraction(interaction)) {
        const access = currentAccess(client);
        if (!isUserAllowed(interaction.user.id, access)) {
          if (interaction.isRepliable()) {
            await replyBlockedByWhitelist(interaction as RepliableInteraction, access);
          }
          return;
        }
      }

      if (interaction.isUserSelectMenu()) {
        if (
          interaction.customId === SETTINGS_SET_OWNER ||
          interaction.customId === SETTINGS_ADD_ALLOWED
        ) {
          await interaction.deferUpdate();
          const access = currentAccess(client);
          if (!isSettingsAuthorized(interaction, access)) {
            await replyNotSettingsAuthorized(interaction, access);
            return;
          }
          if (interaction.customId === SETTINGS_SET_OWNER) {
            const picked = interaction.values[0];
            if (picked) {
              client.accessStore.setOwner(picked);
            }
          } else {
            const picked = [...interaction.values];
            if (picked.length > 0) client.accessStore.addAllowed(picked);
          }
          await rebuildSettingsPanel(client, interaction as unknown as RepliableInteraction);
          return;
        }
      }

      if (interaction.isStringSelectMenu() && interaction.customId === SETTINGS_REMOVE_ALLOWED) {
        await interaction.deferUpdate();
        const access = currentAccess(client);
        if (!isSettingsAuthorized(interaction, access)) {
          await replyNotSettingsAuthorized(interaction, access);
          return;
        }
        const picked = [...interaction.values];
        if (picked.length > 0) client.accessStore.removeAllowed(picked);
        await rebuildSettingsPanel(client, interaction as unknown as RepliableInteraction);
        return;
      }

      if (
        interaction.isButton() &&
        (interaction.customId === SETTINGS_TOGGLE_RESTRICT ||
          interaction.customId === SETTINGS_CLEAR_ALLOWED ||
          interaction.customId === SETTINGS_CLAIM_OWNER ||
          interaction.customId === SETTINGS_REMOVE_OWNER ||
          interaction.customId === SETTINGS_DETECT_OWNER ||
          interaction.customId === SETTINGS_REFRESH)
      ) {
        await interaction.deferUpdate();
        const access = currentAccess(client);
        if (!isSettingsAuthorized(interaction, access)) {
          await replyNotSettingsAuthorized(interaction, access);
          return;
        }
        switch (interaction.customId) {
          case SETTINGS_TOGGLE_RESTRICT:
            client.accessStore.setRestrictToWhitelist(!access.restrictToWhitelist);
            break;
          case SETTINGS_CLEAR_ALLOWED:
            client.accessStore.clearAllowed();
            break;
          case SETTINGS_CLAIM_OWNER:
            client.accessStore.setOwner(interaction.user.id);
            break;
          case SETTINGS_REMOVE_OWNER:
            client.accessStore.setOwner(null);
            break;
          case SETTINGS_DETECT_OWNER: {
            try {
              const app = await client.application!.fetch();
              let detected: string | null = null;
              if (app.owner instanceof Team) detected = app.owner.ownerId ?? null;
              else if (app.owner) detected = app.owner.id;
              if (detected) client.accessStore.setOwner(detected);
            } catch (e) {
              console.error(`Detect owner failed: ${String(e)}`);
            }
            break;
          }
          case SETTINGS_REFRESH:
          default:
            break;
        }
        await rebuildSettingsPanel(client, interaction as unknown as RepliableInteraction);
        return;
      }

      if (interaction.isButton()) {
        if (interaction.customId.startsWith(PROJECT_CREATE_YES)) {
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
          const pk = providerKeyFromCategory(cat);
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
          await createProjectDiscordChannelOnly(interaction, v, channelName, { components: [] });
          return;
        }
        if (interaction.customId.startsWith(PROJECT_CREATE_NO)) {
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
          return;
        }
        if (interaction.customId === "ar_install_confirm") {
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
          const result = await provisionGuild(guild, enabled);
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
            const pk = providerKeyFromCategory(cat);
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
          return;
        }
        if (interaction.customId === "ar_install_cancel") {
          await interaction.update({
            content: "**Installation cancelled.** No changes were made.",
            embeds: [],
            components: [],
          });
          return;
        }
      }

      if (interaction.isStringSelectMenu() && interaction.customId === PROJECT_OPEN_SELECT_ID) {
        await interaction.deferUpdate();
        const v = await validateProjectOpenInteraction(interaction, { components: [] });
        if (!v) return;
        const picked = interaction.values[0];
        if (!picked) return;
        await offerOrOpenProject(client, interaction, v, picked, true);
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === "install") {
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
        return;
      }

      if (interaction.commandName === "settings") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const access = currentAccess(client);
        if (!isSettingsAuthorized(interaction, access)) {
          await replyNotSettingsAuthorized(interaction, access);
          return;
        }
        const panel = await buildSettingsPanel(client, access);
        await interaction.editReply(panel);
        return;
      }

      if (interaction.commandName === "project" && interaction.options.getSubcommand() === "open") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const v = await validateProjectOpenInteraction(interaction);
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
        return;
      }

      const fallback = new EmbedBuilder()
        .setTitle("Command")
        .setDescription(
          `No handler for \`/${interaction.commandName}\`. Use \`/install\` to provision the server, \`/project open\` from \`#${BOT_COMMANDS_CHANNEL}\`, then send a message in a project channel.`,
        )
        .setColor(0x5865f2);
      await interaction.reply({ embeds: [fallback], flags: MessageFlags.Ephemeral });
    } catch (e) {
      if (isIgnorableInteractionError(e)) return;
      console.error(e);
      try {
        if (!interaction.isRepliable()) return;
        const errEmb = new EmbedBuilder()
          .setTitle("Error")
          .setDescription(
            "Could not complete this interaction. Check the bot process logs or run `agent-remote setup` again.",
          )
          .setColor(0xed4245);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            embeds: [errEmb],
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.editReply({ embeds: [errEmb] });
        }
      } catch (errReply) {
        if (isIgnorableInteractionError(errReply)) return;
      }
    }
  });

  const threadErrorEmbed = (text: string) =>
    new EmbedBuilder().setTitle("Error").setDescription(text).setColor(0xed4245);

  const processedMessages = new Set<string>();

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (processedMessages.has(message.id)) return;
    processedMessages.add(message.id);
    if (processedMessages.size > 1000) {
      const toDelete = [...processedMessages].slice(0, 500);
      for (const id of toDelete) processedMessages.delete(id);
    }

    /* Whitelist gate — silently skip messages from users who aren't allowed.
       React with a lock so the sender can see why the bot didn't respond. */
    const access = currentAccess(client);
    if (!isUserAllowed(message.author.id, access)) {
      try {
        await message.react("🔒");
      } catch {}
      return;
    }

    const threadCh = message.channel.isThread() ? message.channel : null;
    if (threadCh) {
      const parent = threadCh.parent;
      if (!parent || parent.type !== ChannelType.GuildText) return;
      if (parent.name === BOT_COMMANDS_CHANNEL) return;
      const cat = categoryFromProjectParent(parent);
      const pk = providerKeyFromCategory(cat);
      if (!pk) return;
      const text = (message.content ?? "").trim();
      if (!text) return;
      let sess = client.chatRegistry.get(threadCh.id);

      /* Session missing (e.g. bot restarted) — resume from persisted session */
      if (!sess) {
        const settings = loadSettings();
        let enabledList = settings.enabledProviderKeys();
        if (!enabledList.length) enabledList = ["claude"];
        if (!enabledList.includes(pk)) return;
        try {
          const adapter = buildChatAdapter(pk, settings);
          const cwdOpt = projectWorkspaceCwd(settings, parent.name);
          const persisted = client.sessionStore.get(threadCh.id);
          await adapter.startSession({
            threadId: threadCh.id,
            cwd: cwdOpt,
            resumeCursor: persisted?.sessionId,
          });
          sess = { providerKey: pk, adapter };
          client.chatRegistry.add(threadCh.id, sess);
        } catch (e) {
          console.error(e);
          try {
            await threadCh.send({
              embeds: [
                threadErrorEmbed(
                  `Could not restore session: ${e instanceof Error ? e.message : String(e)}`,
                ),
              ],
            });
          } catch {}
          return;
        }
      }

      const session = sess;
      await runSerial(threadCh.id, async () => {
        try {
          await threadCh.sendTyping();
          await session.adapter.sendTurn({ threadId: threadCh.id, input: text });
          await streamAssistantRepliesEmbed(threadCh, session.adapter, {
            fallbackThreadTitle: threadCh.name,
            providerKey: pk,
            skipRename: true,
          });
          persistSessionId(client, threadCh.id, session.adapter, pk);
        } catch (e) {
          console.error(e);
          try {
            await threadCh.send({
              embeds: [
                threadErrorEmbed(
                  `Something went wrong during this turn: ${e instanceof Error ? e.message : String(e)}`,
                ),
              ],
            });
          } catch {
          }
        }
      });
      return;
    }

    if (message.channel.type !== ChannelType.GuildText) return;
    if (message.channel.name === BOT_COMMANDS_CHANNEL) {
      try {
        const reply = await message.reply({
          embeds: [
            new EmbedBuilder()
              .setDescription("Messages here don't do anything. Use `/project open` to add a project channel.")
              .setColor(0x5865f2),
          ],
        });
        setTimeout(() => { reply.delete().catch(() => {}); }, 8000);
      } catch {}
      return;
    }
    const cat = message.channel.parent;
    if (!cat || cat.type !== ChannelType.GuildCategory) return;
    const pk = providerKeyFromCategory(cat);
    if (!pk) return;
    const settings = loadSettings();
    let enabledList = settings.enabledProviderKeys();
    if (!enabledList.length) enabledList = ["claude"];
    if (!enabledList.includes(pk)) return;
    const text = (message.content ?? "").trim();
    if (!text) return;

    /* Skip if this message already has a thread (duplicate event / race) */
    if (message.hasThread) return;

    const threadName = slugifyThreadTitle(text);
    let thread: ThreadChannel;
    try {
      thread = await message.startThread({
        name: threadName.slice(0, 90) || "cli-session",
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        reason: "agent-remote cli session",
      });
    } catch {
      return;
    }

    let adapter: BaseAdapter | null = null;
    try {
      adapter = buildChatAdapter(pk, settings);
      const cwdOpt = projectWorkspaceCwd(settings, message.channel.name);
      await adapter.startSession({ threadId: thread.id, cwd: cwdOpt });
      await adapter.sendTurn({ threadId: thread.id, input: text });
      const session = { providerKey: pk, adapter };
      client.chatRegistry.add(thread.id, session);
      adapter = null;
      await runSerial(thread.id, async () => {
        await streamAssistantRepliesEmbed(thread, session.adapter, {
          fallbackThreadTitle: text,
          providerKey: pk,
        });
        persistSessionId(client, thread.id, session.adapter, pk);
      });
    } catch (e) {
      if (adapter) {
        try {
          await adapter.cancel();
        } catch {
        }
      }
      const held = client.chatRegistry.get(thread.id);
      if (held) {
        client.chatRegistry.remove(thread.id);
        try {
          await held.adapter.cancel();
        } catch {
        }
      }
      console.error(e);
      try {
        await thread.send({
          embeds: [
            threadErrorEmbed(
              `Could not start CLI session: ${e instanceof Error ? e.message : String(e)}`,
            ),
          ],
        });
      } catch {
      }
    }
  });
}
