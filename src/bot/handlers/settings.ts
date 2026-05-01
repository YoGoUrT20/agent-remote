import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  Team,
  TextDisplayBuilder,
  UserSelectMenuBuilder,
  type InteractionEditReplyOptions,
  type RepliableInteraction,
} from "discord.js";
import { warn as logWarn } from "../../logger.js";
import { loadSettings } from "../../config.js";
import {
  PROVIDERS,
  PROVIDER_MODELS,
  resolvedProviderEmoji,
  type ProviderKey,
  type ProviderModelDef,
} from "../../constants.js";
import {
  bulletedMentionList,
  buildHeaderComponents,
  currentAccess,
  isSettingsAuthorized,
  MAX_WHITELIST_REMOVE_OPTIONS,
  replyNotSettingsAuthorized,
  resolveUserLabel,
  SETTINGS_ADD_ALLOWED,
  SETTINGS_CLAIM_OWNER,
  SETTINGS_CLEAR_ALLOWED,
  SETTINGS_DETECT_OWNER,
  SETTINGS_MODEL_RESET,
  SETTINGS_MODEL_SELECT,
  SETTINGS_PANEL_ACCENT,
  SETTINGS_PANEL_RESTRICT_ACCENT,
  SETTINGS_REFRESH,
  SETTINGS_REMOVE_ALLOWED,
  SETTINGS_REMOVE_OWNER,
  SETTINGS_SET_OWNER,
  SETTINGS_TAB_ACCESS,
  SETTINGS_TAB_GENERAL,
  SETTINGS_TAB_MODELS,
  SETTINGS_TOGGLE_PING,
  SETTINGS_TOGGLE_RESTRICT,
  type SettingsTab,
} from "./utils.js";
import type { EffectiveAccess } from "../../access-store.js";

/* ── Access tab ── */

async function buildAccessPanel(
  client: Client,
  access: EffectiveAccess,
): Promise<{ components: ContainerBuilder[] | (TextDisplayBuilder | ActionRowBuilder<ButtonBuilder> | SeparatorBuilder | ContainerBuilder)[] }> {
  const settings = loadSettings();
  const envDefaults = settings.accessEnvDefaults;
  const overrides = client.accessStore.all();

  const ownerText = access.ownerUserId
    ? `### 👑 Owner\n<@${access.ownerUserId}>  ·  \`${access.ownerUserId}\``
    : `### 👑 Owner\n_Not set._ The first admin who claims ownership becomes the bot owner.`;

  const restrictText = access.restrictToWhitelist
    ? `### 🔒 Whitelist Restriction\n**On** — only the owner and whitelisted users may use the bot.`
    : `### 🔓 Whitelist Restriction\n**Off** — anyone in the server may use the bot.`;

  const whitelistHeader = `### 📋 Whitelist (${access.allowedUserIds.length})`;
  const whitelistText =
    access.allowedUserIds.length === 0
      ? `${whitelistHeader}\n_(empty)_`
      : `${whitelistHeader}\n${bulletedMentionList(access.allowedUserIds)}`;

  const intro = new TextDisplayBuilder().setContent(
    "Configure who is allowed to use this bot. Runtime overrides set here win over `.env` values; the owner is always implicitly allowed.",
  );

  /* Owner section */
  const ownerSection = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(ownerText),
  );
  ownerSection.setButtonAccessory(
    !access.ownerUserId
      ? new ButtonBuilder()
          .setCustomId(SETTINGS_CLAIM_OWNER)
          .setLabel("Claim (me)")
          .setStyle(ButtonStyle.Success)
      : new ButtonBuilder()
          .setCustomId(SETTINGS_REMOVE_OWNER)
          .setLabel("Remove")
          .setStyle(ButtonStyle.Secondary),
  );

  /* Restriction toggle section */
  const restrictSection = new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(restrictText))
    .setButtonAccessory(
      new ButtonBuilder()
        .setCustomId(SETTINGS_TOGGLE_RESTRICT)
        .setLabel(access.restrictToWhitelist ? "Disable" : "Enable")
        .setStyle(access.restrictToWhitelist ? ButtonStyle.Secondary : ButtonStyle.Primary),
    );

  /* Whitelist members display */
  const whitelistDisplay = new TextDisplayBuilder().setContent(whitelistText);

  /* Action rows for managing access */
  const setOwnerRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(SETTINGS_SET_OWNER)
      .setPlaceholder("Set bot owner (replaces current)")
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

  let removeRow: ActionRowBuilder<StringSelectMenuBuilder> | null = null;
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
    removeRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(removeMenu);
  }

  const utilButtons = new ActionRowBuilder<ButtonBuilder>();
  if (access.allowedUserIds.length > 0) {
    utilButtons.addComponents(
      new ButtonBuilder()
        .setCustomId(SETTINGS_CLEAR_ALLOWED)
        .setLabel("Clear whitelist")
        .setStyle(ButtonStyle.Danger),
    );
  }
  utilButtons.addComponents(
    new ButtonBuilder()
      .setCustomId(SETTINGS_DETECT_OWNER)
      .setLabel("Detect from app")
      .setEmoji("🔎")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(SETTINGS_REFRESH)
      .setLabel("Refresh")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
  );

  const sep = (): SeparatorBuilder =>
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

  const mainContainer = new ContainerBuilder()
    .setAccentColor(access.restrictToWhitelist ? SETTINGS_PANEL_RESTRICT_ACCENT : SETTINGS_PANEL_ACCENT)
    .addTextDisplayComponents(intro)
    .addSeparatorComponents(sep())
    .addSectionComponents(ownerSection)
    .addActionRowComponents(setOwnerRow)
    .addSeparatorComponents(sep())
    .addSectionComponents(restrictSection)
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(whitelistDisplay)
    .addActionRowComponents(addAllowedRow);

  if (removeRow) {
    mainContainer.addActionRowComponents(removeRow);
  }
  mainContainer.addSeparatorComponents(sep()).addActionRowComponents(utilButtons);

  return {
    components: [...buildHeaderComponents("access"), mainContainer],
  };
}

/* ── Models tab (Components V2 — model selection is fully V2) ── */

function buildModelsPanel(
  client: Client,
): { components: (TextDisplayBuilder | ActionRowBuilder<ButtonBuilder> | SeparatorBuilder | ContainerBuilder)[] } {
  const settings = loadSettings();
  const enabledKeys = settings.enabledProviderKeys().length
    ? settings.enabledProviderKeys()
    : ["claude"];

  const intro = new TextDisplayBuilder().setContent(
    "Set the default AI model for each provider. Defaults apply to all new sessions.\n-# Per-session overrides: `/model` in a project channel or thread.",
  );

  const mainContainer = new ContainerBuilder()
    .setAccentColor(SETTINGS_PANEL_ACCENT)
    .addTextDisplayComponents(intro);

  const sep = (): SeparatorBuilder =>
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

  let addedProvider = false;

  for (const pk of enabledKeys) {
    const provider = PROVIDERS[pk];
    if (!provider) continue;
    const models: ProviderModelDef[] = PROVIDER_MODELS[pk] ?? [];
    if (models.length === 0) continue;

    addedProvider = true;

    const envDefault = pk === "claude" ? settings.claudeModel : settings.codexModel;
    const storeOverride = client.modelStore.getDefaultModel(pk);
    const effective = storeOverride ?? envDefault;
    const effectiveDef = models.find((m) => m.value === effective);
    const effectiveLabel = effectiveDef
      ? `**${effectiveDef.label}**  ·  \`${effective}\``
      : `\`${effective}\``;
    const source = storeOverride ? "`/settings` override" : "env / default";
    const emoji = resolvedProviderEmoji[pk as ProviderKey];
    const heading = emoji ? `${emoji} **${provider.displayName}**` : `**${provider.displayName}**`;

    const headerText = `### ${heading}\n${effectiveLabel}\n-# Source: ${source}`;

    const headerSection = new SectionBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(headerText),
    );
    if (storeOverride) {
      headerSection.setButtonAccessory(
        new ButtonBuilder()
          .setCustomId(`${SETTINGS_MODEL_RESET}${pk}`)
          .setLabel("Reset")
          .setStyle(ButtonStyle.Secondary),
      );
    } else {
      headerSection.setButtonAccessory(
        new ButtonBuilder()
          .setCustomId(`${SETTINGS_MODEL_RESET}${pk}__noop`)
          .setLabel("Default")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      );
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${SETTINGS_MODEL_SELECT}${pk}`)
      .setPlaceholder(`Choose default model for ${provider.displayName}`)
      .addOptions(
        models.map((m) => ({
          label: m.label.slice(0, 100),
          value: m.value,
          description: m.value.slice(0, 100),
          default: m.value === effective,
        })),
      );

    mainContainer
      .addSeparatorComponents(sep())
      .addSectionComponents(headerSection)
      .addActionRowComponents(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      );
  }

  const components: (TextDisplayBuilder | ActionRowBuilder<ButtonBuilder> | SeparatorBuilder | ContainerBuilder)[] = [
    ...buildHeaderComponents("models"),
  ];

  if (!addedProvider) {
    components.push(
      new ContainerBuilder()
        .setAccentColor(0x4f545c)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "_No providers with configurable models are currently enabled._",
          ),
        ),
    );
  } else {
    components.push(mainContainer);
  }

  return { components };
}

/* ── General tab ── */

function buildGeneralPanel(
  client: Client,
  access: EffectiveAccess,
): { components: (TextDisplayBuilder | ActionRowBuilder<ButtonBuilder> | SeparatorBuilder | ContainerBuilder)[] } {
  const pingText = access.pingOnResponse
    ? `### 🔔 Ping on Response\n**On** — the bot will mention the user when the model finishes answering.`
    : `### 🔕 Ping on Response\n**Off** — no mention is sent when the model finishes answering.`;

  const intro = new TextDisplayBuilder().setContent(
    "General bot behavior settings.",
  );

  const pingSection = new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(pingText))
    .setButtonAccessory(
      new ButtonBuilder()
        .setCustomId(SETTINGS_TOGGLE_PING)
        .setLabel(access.pingOnResponse ? "Disable" : "Enable")
        .setStyle(access.pingOnResponse ? ButtonStyle.Secondary : ButtonStyle.Primary),
    );

  const sep = (): SeparatorBuilder =>
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

  const mainContainer = new ContainerBuilder()
    .setAccentColor(SETTINGS_PANEL_ACCENT)
    .addTextDisplayComponents(intro)
    .addSeparatorComponents(sep())
    .addSectionComponents(pingSection);

  return {
    components: [...buildHeaderComponents("general"), mainContainer],
  };
}

/* ── Build settings panel (dispatches to active tab) ── */

type SettingsPanelPayload = InteractionEditReplyOptions;

export async function buildSettingsPanel(
  client: Client,
  access: EffectiveAccess,
  tab: SettingsTab = "access",
): Promise<SettingsPanelPayload> {
  const built =
    tab === "models"
      ? buildModelsPanel(client)
      : tab === "general"
        ? buildGeneralPanel(client, access)
        : await buildAccessPanel(client, access);
  return {
    flags: MessageFlags.IsComponentsV2,
    components: built.components as InteractionEditReplyOptions["components"],
    content: "",
  };
}

export async function rebuildSettingsPanel(
  client: Client,
  interaction: RepliableInteraction,
  tab: SettingsTab = "access",
): Promise<void> {
  const access = currentAccess(client);
  const panel = await buildSettingsPanel(client, access, tab);
  await interaction.editReply(panel);
}

/* ── Settings interaction handlers ── */

export async function handleSettingsCommand(
  client: Client,
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const access = currentAccess(client);
  if (!isSettingsAuthorized(interaction, access)) {
    await replyNotSettingsAuthorized(interaction, access);
    return;
  }
  const panel = await buildSettingsPanel(client, access);
  await interaction.editReply(panel);
}

export async function handleSettingsUserSelect(
  client: Client,
  interaction: import("discord.js").UserSelectMenuInteraction,
): Promise<void> {
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
}

export async function handleSettingsRemoveAllowed(
  client: Client,
  interaction: import("discord.js").StringSelectMenuInteraction,
): Promise<void> {
  await interaction.deferUpdate();
  const access = currentAccess(client);
  if (!isSettingsAuthorized(interaction, access)) {
    await replyNotSettingsAuthorized(interaction, access);
    return;
  }
  const picked = [...interaction.values];
  if (picked.length > 0) client.accessStore.removeAllowed(picked);
  await rebuildSettingsPanel(client, interaction as unknown as RepliableInteraction);
}

export async function handleSettingsButtons(
  client: Client,
  interaction: import("discord.js").ButtonInteraction,
): Promise<void> {
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
        logWarn(`[settings] detect owner failed: ${String(e)}`);
      }
      break;
    }
    case SETTINGS_REFRESH:
    default:
      break;
  }
  await rebuildSettingsPanel(client, interaction as unknown as RepliableInteraction, "access");
}

export async function handleSettingsGeneralButtons(
  client: Client,
  interaction: import("discord.js").ButtonInteraction,
): Promise<void> {
  await interaction.deferUpdate();
  const access = currentAccess(client);
  if (!isSettingsAuthorized(interaction, access)) {
    await replyNotSettingsAuthorized(interaction, access);
    return;
  }
  if (interaction.customId === SETTINGS_TOGGLE_PING) {
    client.accessStore.setPingOnResponse(!access.pingOnResponse);
  }
  await rebuildSettingsPanel(client, interaction as unknown as RepliableInteraction, "general");
}

export async function handleSettingsTabNavigation(
  client: Client,
  interaction: import("discord.js").ButtonInteraction,
): Promise<void> {
  await interaction.deferUpdate();
  const access = currentAccess(client);
  if (!isSettingsAuthorized(interaction, access)) {
    await replyNotSettingsAuthorized(interaction, access);
    return;
  }
  const tab: SettingsTab =
    interaction.customId === SETTINGS_TAB_MODELS
      ? "models"
      : interaction.customId === SETTINGS_TAB_GENERAL
        ? "general"
        : "access";
  await rebuildSettingsPanel(client, interaction as unknown as RepliableInteraction, tab);
}

export async function handleSettingsModelReset(
  client: Client,
  interaction: import("discord.js").ButtonInteraction,
): Promise<void> {
  await interaction.deferUpdate();
  const access = currentAccess(client);
  if (!isSettingsAuthorized(interaction, access)) {
    await replyNotSettingsAuthorized(interaction, access);
    return;
  }
  const pk = interaction.customId.slice(SETTINGS_MODEL_RESET.length);
  client.modelStore.setDefaultModel(pk, null);
  await rebuildSettingsPanel(client, interaction as unknown as RepliableInteraction, "models");
}

export async function handleSettingsModelSelect(
  client: Client,
  interaction: import("discord.js").StringSelectMenuInteraction,
): Promise<void> {
  await interaction.deferUpdate();
  const access = currentAccess(client);
  if (!isSettingsAuthorized(interaction, access)) {
    await replyNotSettingsAuthorized(interaction, access);
    return;
  }
  const pk = interaction.customId.slice(SETTINGS_MODEL_SELECT.length);
  const picked = interaction.values[0];
  if (picked) client.modelStore.setDefaultModel(pk, picked);
  await rebuildSettingsPanel(client, interaction as unknown as RepliableInteraction, "models");
}
