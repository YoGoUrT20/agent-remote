import {
  ActionRowBuilder,
  ChannelType,
  Client,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  PROVIDERS,
  PROVIDER_MODELS,
  resolvedProviderEmoji,
  type ProviderKey,
} from "../../constants.js";
import {
  categoryFromProjectParent,
  MODEL_SELECT_ID,
  providerKeyFromCategory,
  replyEphemeralEmbed,
  SETTINGS_PANEL_ACCENT,
} from "./utils.js";
import { loadSettings } from "../../config.js";

/* ── /model command handler ── */

export async function handleModelCommand(
  client: Client,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  /* Determine provider from channel context */
  const ch = interaction.channel;
  let pk: ProviderKey | null = null;
  let threadId: string | null = null;

  if (ch?.isThread()) {
    threadId = ch.id;
    const parent = ch.parent;
    if (parent && parent.type === ChannelType.GuildText) {
      const cat = categoryFromProjectParent(parent);
      pk = providerKeyFromCategory(client, cat);
    }
  } else if (ch && ch.type === ChannelType.GuildText) {
    const cat = ch.parent;
    if (cat && cat.type === ChannelType.GuildCategory) pk = providerKeyFromCategory(client, cat);
  }

  if (!pk) {
    await replyEphemeralEmbed(interaction, {
      title: "Not in a provider channel",
      description: "Use `/model` from a project channel or session thread under a provider category.",
      ok: false,
    });
    return;
  }

  /* targetId = thread ID (if in thread) or channel ID (if in project channel) */
  const targetId = threadId ?? ch?.id ?? null;
  const isThread = !!threadId;

  const models = PROVIDER_MODELS[pk] ?? [];
  const pickedModel = (interaction.options.getString("name") ?? "").trim();

  if (!pickedModel) {
    /* No argument — show current model + dropdown */
    const sess = isThread ? client.chatRegistry.get(threadId!) : null;
    const override = targetId ? client.modelOverrides.get(targetId) : null;
    const settings = loadSettings();
    const envDefault = pk === "claude" ? settings.claudeModel : settings.codexModel;
    const storeDefault = client.modelStore.getDefaultModel(pk);
    const currentModel =
      override ??
      (sess ? sess.adapter.getSessionModel(threadId!) : null) ??
      storeDefault ??
      envDefault;

    const currentDef = models.find((m) => m.value === currentModel);
    const currentLabel = currentDef ? `**${currentDef.label}**  ·  \`${currentModel}\`` : `\`${currentModel}\``;

    const providerName = PROVIDERS[pk]?.displayName ?? pk;
    const emoji = resolvedProviderEmoji[pk as ProviderKey];
    const heading = emoji ? `${emoji} **${providerName}**` : `**${providerName}**`;

    const source = override ? "channel/thread override" : (sess ? "active session" : (storeDefault ? "settings override" : "env / default"));

    const contextHint = isThread
      ? "Takes effect on your next message in this thread."
      : "Will apply to the next new session you start in this channel.";

    if (models.length === 0) {
      const container = new ContainerBuilder()
        .setAccentColor(SETTINGS_PANEL_ACCENT)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### ${heading}\n${currentLabel}\n\n_No predefined models for this provider. Use \`/model name:<model>\` to set one manually._`
          )
        );
      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [container as any],
        content: ""
      });
      return;
    }

    const headerText = `### ${heading}\n${currentLabel}\n-# Source: ${source}`;

    const menu = new StringSelectMenuBuilder()
      .setCustomId(MODEL_SELECT_ID)
      .setPlaceholder("Select a model…")
      .addOptions(
        models.map((m) => ({
          label: m.label.slice(0, 100),
          value: m.value,
          description: m.value.slice(0, 100),
          default: m.value === currentModel,
        })),
      );

    const container = new ContainerBuilder()
      .setAccentColor(SETTINGS_PANEL_ACCENT)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(headerText),
        new TextDisplayBuilder().setContent(`Select a different model below.\n-# ${contextHint}`)
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
      )
      .addActionRowComponents(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)
      );

    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container as any],
      content: ""
    });
    return;
  }

  /* Direct argument — set the model */
  if (!targetId) {
    await replyEphemeralEmbed(interaction, {
      title: "Could not determine channel",
      description: "Unable to resolve channel context. Try again from a project channel or thread.",
      ok: false,
    });
    return;
  }

  const modelDef = models.find((m) => m.value === pickedModel);
  const label = modelDef?.label ?? pickedModel;

  client.modelOverrides.set(targetId, pickedModel);

  /* If in a thread with an active session whose model differs, stop it */
  if (isThread) {
    const sess = client.chatRegistry.get(threadId!);
    if (sess) {
      const currentModel = sess.adapter.getSessionModel(threadId!);
      if (currentModel && currentModel !== pickedModel) {
        try {
          await sess.adapter.stopSession(threadId!);
        } catch {}
        client.chatRegistry.remove(threadId!);
      }
    }
  }

  const contextHint = isThread
    ? "Takes effect on your next message."
    : "Will apply to the next new session you start in this channel.";
  await replyEphemeralEmbed(interaction, {
    title: "Model updated",
    description: `Switched to **${label}** (\`${pickedModel}\`). ${contextHint}`,
    ok: true,
  });
}

/* ── Model select menu handler ── */

export async function handleModelSelectMenu(
  client: Client,
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  await interaction.deferUpdate();
  const picked = interaction.values[0];
  if (!picked) return;

  /* Determine provider from channel context */
  const ch = interaction.channel;
  let pk: ProviderKey | null = null;
  const isThread = !!ch?.isThread();
  if (isThread) {
    const parent = ch!.parent;
    if (parent && parent.type === ChannelType.GuildText) {
      const cat = categoryFromProjectParent(parent);
      pk = providerKeyFromCategory(client, cat);
    }
  } else if (ch && ch.type === ChannelType.GuildText) {
    const cat = ch.parent;
    if (cat && cat.type === ChannelType.GuildCategory) pk = providerKeyFromCategory(client, cat);
  }
  const models = pk ? (PROVIDER_MODELS[pk] ?? []) : [];
  const modelDef = models.find((m) => m.value === picked);

  const targetId = isThread ? ch!.id : ch?.id ?? null;
  if (!targetId) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Could not determine channel")
          .setDescription("Unable to resolve channel context. Try again.")
          .setColor(0xed4245),
      ],
      components: [],
    });
    return;
  }

  client.modelOverrides.set(targetId, picked);

  /* If in a thread with an active session whose model differs, stop it */
  if (isThread) {
    const sess = client.chatRegistry.get(targetId);
    if (sess) {
      const currentModel = sess.adapter.getSessionModel(targetId);
      if (currentModel && currentModel !== picked) {
        try {
          await sess.adapter.stopSession(targetId);
        } catch {}
        client.chatRegistry.remove(targetId);
      }
    }
  }

  const contextHint = isThread
    ? "Takes effect on your next message in this thread."
    : "Will apply to the next new session you start in this channel.";

  const currentLabel = modelDef ? `**${modelDef.label}**  ·  \`${picked}\`` : `\`${picked}\``;
  const providerName = pk ? (PROVIDERS[pk]?.displayName ?? pk) : "Unknown";
  const emoji = pk ? resolvedProviderEmoji[pk as ProviderKey] : null;
  const heading = emoji ? `${emoji} **${providerName}**` : `**${providerName}**`;
  const headerText = `### ${heading}\n${currentLabel}\n-# Source: channel/thread override`;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(MODEL_SELECT_ID)
    .setPlaceholder("Select a model…")
    .addOptions(
      models.map((m) => ({
        label: m.label.slice(0, 100),
        value: m.value,
        description: m.value.slice(0, 100),
        default: m.value === picked,
      })),
    );

  const container = new ContainerBuilder()
    .setAccentColor(SETTINGS_PANEL_ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(headerText),
      new TextDisplayBuilder().setContent(`Select a different model below.\n-# ${contextHint}`)
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    )
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)
    );

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container as any],
    embeds: [],
    content: ""
  });
}
