import { existsSync } from "node:fs";
import {
  ChannelType,
  Client,
  type AutocompleteInteraction,
} from "discord.js";
import { loadSettings } from "../../config.js";
import {
  PROVIDER_MODELS,
  type ProviderKey,
} from "../../constants.js";
import {
  listWorkspaceSubfolders,
  workspaceRootPath,
  WORKSPACE_SELECT_MAX_OPTIONS,
} from "../../workspace-dirs.js";
import {
  categoryFromProjectParent,
  providerKeyFromCategory,
} from "./utils.js";

/* ── Autocomplete handlers ── */

export async function handleProjectOpenAutocomplete(
  _client: Client,
  interaction: AutocompleteInteraction,
): Promise<void> {
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
}

export async function handleModelAutocomplete(
  client: Client,
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "name") {
    await interaction.respond([]);
    return;
  }
  /* Determine provider from the channel context */
  const ch = interaction.channel;
  let pk: ProviderKey | null = null;
  if (ch?.isThread()) {
    const parent = ch.parent;
    if (parent && parent.type === ChannelType.GuildText) {
      const cat = categoryFromProjectParent(parent);
      pk = providerKeyFromCategory(client, cat);
    }
  } else if (ch && ch.type === ChannelType.GuildText) {
    const cat = ch.parent;
    if (cat && cat.type === ChannelType.GuildCategory) {
      pk = providerKeyFromCategory(client, cat);
    }
  }
  const models = pk ? (PROVIDER_MODELS[pk] ?? []) : [];
  const needle = focused.value.trim().toLowerCase();
  const filtered = needle.length > 0
    ? models.filter((m) => m.label.toLowerCase().includes(needle) || m.value.toLowerCase().includes(needle))
    : models;
  await interaction.respond(
    filtered.slice(0, 25).map((m) => ({
      name: m.label,
      value: m.value,
    })),
  );
}
