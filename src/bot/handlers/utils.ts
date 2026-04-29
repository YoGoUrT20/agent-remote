import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CategoryChannel,
  ChannelType,
  Client,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SeparatorBuilder,
  SeparatorSpacingSize,
  Team,
  TextDisplayBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { BaseAdapter } from "../../adapters/base.js";
import type { Settings } from "../../config.js";
import { loadSettings } from "../../config.js";
import {
  effectiveAccess,
  isUserAllowed,
  type EffectiveAccess,
} from "../../access-store.js";
import {
  BOT_COMMANDS_CHANNEL,
  PROVIDERS,
  PROVIDER_MODELS,
  normalizeCategoryChannelName,
  type ProviderKey,
} from "../../constants.js";
import {
  findExistingWorkspaceFolder,
  workspaceRootPath,
} from "../../workspace-dirs.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

/* ── Constants ── */

export const MAX_EMBED_DESC = 4080;
export const PROJECT_OPEN_SELECT_ID = "ar_project_open_pick";
export const PROJECT_CREATE_YES = "ar_pc_yes:";
export const PROJECT_CREATE_NO = "ar_pc_no:";
export const PENDING_PROJECT_TTL_MS = 15 * 60 * 1000;

export const MODEL_SELECT_ID = "ar_model_pick";

export const SETTINGS_SET_OWNER = "ar_settings_set_owner";
export const SETTINGS_ADD_ALLOWED = "ar_settings_add_allowed";
export const SETTINGS_REMOVE_ALLOWED = "ar_settings_remove_allowed";
export const SETTINGS_TOGGLE_RESTRICT = "ar_settings_toggle_restrict";
export const SETTINGS_CLEAR_ALLOWED = "ar_settings_clear_allowed";
export const SETTINGS_CLAIM_OWNER = "ar_settings_claim_owner";
export const SETTINGS_REFRESH = "ar_settings_refresh";
export const SETTINGS_REMOVE_OWNER = "ar_settings_remove_owner";
export const SETTINGS_DETECT_OWNER = "ar_settings_detect_owner";

export const SETTINGS_TAB_ACCESS = "ar_settings_tab_access";
export const SETTINGS_TAB_MODELS = "ar_settings_tab_models";
export const SETTINGS_MODEL_SELECT = "ar_settings_model_select:";
export const SETTINGS_MODEL_RESET = "ar_settings_model_reset:";

export type SettingsTab = "access" | "models";

export const MAX_WHITELIST_REMOVE_OPTIONS = 25;
export const SETTINGS_PANEL_ACCENT = 0x5865f2;
export const SETTINGS_PANEL_RESTRICT_ACCENT = 0xfee75c;

/* ── Types ── */

export type ProjectOpenValidated = {
  settings: Settings;
  guild: import("discord.js").Guild;
  cat: CategoryChannel;
  pk: ProviderKey;
};

/* ── Utility functions ── */

export function persistSessionId(client: Client, threadId: string, adapter: BaseAdapter, providerKey: string, cwd?: string): void {
  if ("getSessionId" in adapter && typeof adapter.getSessionId === "function") {
    const sid = adapter.getSessionId(threadId);
    if (sid) {
      const model = adapter.getSessionModel(threadId) ?? client.modelOverrides.get(threadId);
      client.sessionStore.set(threadId, { sessionId: sid, cwd: cwd ?? "", providerKey, model: model ?? undefined });
    }
  }
}

export function resolveModelLabel(pk: ProviderKey, modelValue: string | null | undefined): string {
  if (!modelValue) return "";
  const models = PROVIDER_MODELS[pk] ?? [];
  const def = models.find((m) => m.value === modelValue);
  return def ? def.label : modelValue;
}

export function currentAccess(client: Client): EffectiveAccess {
  const settings = loadSettings();
  return effectiveAccess(settings.accessEnvDefaults, client.accessStore.all());
}

export function interactionMemberHasAdmin(interaction: Interaction): boolean {
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

export function isSettingsAuthorized(
  interaction: Interaction,
  access: EffectiveAccess,
): boolean {
  const userId = interaction.user.id;
  if (access.ownerUserId) return userId === access.ownerUserId;
  return interactionMemberHasAdmin(interaction);
}

export async function resolveUserLabel(client: Client, userId: string): Promise<string> {
  try {
    const u = await client.users.fetch(userId);
    return u.tag ?? u.username ?? userId;
  } catch {
    return userId;
  }
}

export function bulletedMentionList(userIds: string[]): string {
  if (userIds.length === 0) return "_(empty)_";
  return userIds.map((id) => `• <@${id}>  \`${id}\``).join("\n");
}

export function discordErrorCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  
  const maybe = err as { code?: unknown };
  return typeof maybe.code === "number" ? maybe.code : null;
}

export function isIgnorableInteractionError(err: unknown): boolean {
  const code = discordErrorCode(err);
  return code === 10062 || code === 40060;
}

export function slugifyDiscordSegment(raw: string, maxLen: number): string {
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

export function slugifyProjectChannelName(raw: string): string {
  let s = slugifyDiscordSegment(raw.trim(), 90);

  if (s === BOT_COMMANDS_CHANNEL) s = `${s}-work`;
  return s;
}

export function slugifyThreadTitle(raw: string): string {
  const first = raw.trim().split(/\r?\n/)[0] ?? "";
  return slugifyDiscordSegment(first || raw, 95);
}

export function projectWorkspaceCwd(settings: Settings, projectChannelName: string): string | undefined {
  const sub = join(workspaceRootPath(settings), projectChannelName);
  if (existsSync(sub)) return sub;
  return undefined;
}

export async function replyEphemeralEmbed(
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

export async function replyBlockedByWhitelist(
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

export async function replyNotSettingsAuthorized(
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

export function providerKeyFromCategory(client: Client, category: CategoryChannel | null): ProviderKey | null {
  if (!category) return null;
  if (!client.projectStore.has(category.id)) return null;
  const normalized = normalizeCategoryChannelName(category.name);
  for (const [, p] of Object.entries(PROVIDERS)) {
    if (p.categoryName === normalized) return p.key as ProviderKey;
  }
  return null;
}

export function categoryFromProjectParent(parentChannel: {
  parent: CategoryChannel | null;
}): CategoryChannel | null {
  const p = parentChannel.parent;
  if (!p || p.type !== ChannelType.GuildCategory) return null;
  return p;
}

export function isSettingsInteraction(interaction: Interaction): boolean {
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

export function buildHeaderComponents(activeTab: SettingsTab): Array<TextDisplayBuilder | ActionRowBuilder<ButtonBuilder> | SeparatorBuilder> {
  const tabs = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(SETTINGS_TAB_ACCESS)
      .setLabel("Access")
      .setEmoji("🔐")
      .setStyle(activeTab === "access" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(activeTab === "access"),
    new ButtonBuilder()
      .setCustomId(SETTINGS_TAB_MODELS)
      .setLabel("Models")
      .setEmoji("🧠")
      .setStyle(activeTab === "models" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(activeTab === "models"),
  );
  const sep = new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
  return [tabs, sep];
}

export async function validateProjectOpenInteraction(
  client: Client,
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
  const pk = providerKeyFromCategory(client, cat);
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
