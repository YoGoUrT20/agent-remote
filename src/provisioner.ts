import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { debug, info as logInfo, warn as logWarn } from "./logger.js";
import { ChannelType, type CategoryChannel, type Guild } from "discord.js";
import {
  BOT_COMMANDS_CHANNEL,
  PROVIDERS,
  PROVIDER_EMOJI_NAMES,
  PROVIDER_EMOJI_FILES,
  resolvedProviderEmoji,
  resolvedProviderEmojiURL,
  normalizeCategoryChannelName,
  providerCategoryChannelName,
  type ProviderKey,
} from "./constants.js";
import type { Client } from "discord.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ProvisionResult {
  categoriesCreated: string[];
  channelsCreated: string[];
  skipped: string[];
}

function findProviderCategory(
  existingCategories: Map<string, CategoryChannel>,
  provider: (typeof PROVIDERS)[string],
): CategoryChannel | undefined {
  const decorated = providerCategoryChannelName(provider);
  const byDecorated = existingCategories.get(decorated);
  if (byDecorated) return byDecorated;
  const byPlain = existingCategories.get(provider.categoryName);
  if (byPlain) return byPlain;
  for (const ch of existingCategories.values()) {
    if (normalizeCategoryChannelName(ch.name) === provider.categoryName) return ch;
  }
  return undefined;
}

/**
 * Upload provider emoji to the guild (or reuse existing ones).
 * Populates resolvedProviderEmoji so embeds can reference them.
 */
export async function uploadProviderEmoji(guild: Guild, keys: string[]): Promise<void> {
  const existing = await guild.emojis.fetch();

  for (const key of keys) {
    const emojiName = PROVIDER_EMOJI_NAMES[key as ProviderKey];
    const emojiFile = PROVIDER_EMOJI_FILES[key as ProviderKey];
    if (!emojiName || !emojiFile) continue;

    // Check if already uploaded
    const found = existing.find((e) => e.name === emojiName);
    if (found) {
      resolvedProviderEmoji[key as ProviderKey] = `<:${found.name}:${found.id}>`;
      resolvedProviderEmojiURL[key as ProviderKey] = `https://cdn.discordapp.com/emojis/${found.id}.png`;
      debug(`[provisioner] emoji ${emojiName} already exists: ${found.id}`);
      continue;
    }

    // Upload from src/public/
    const filePath = join(__dirname, "public", emojiFile);
    try {
      const data = readFileSync(filePath);
      const base64 = `data:image/png;base64,${data.toString("base64")}`;
      const created = await guild.emojis.create({
        attachment: base64,
        name: emojiName,
        reason: "agent-remote provider emoji",
      });
      resolvedProviderEmoji[key as ProviderKey] = `<:${created.name}:${created.id}>`;
      resolvedProviderEmojiURL[key as ProviderKey] = `https://cdn.discordapp.com/emojis/${created.id}.png`;
      logInfo(`[provisioner] uploaded emoji ${emojiName}: ${created.id}`);
    } catch (e) {
      logWarn(`[provisioner] failed to upload emoji ${emojiName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Sync resolvedProviderEmoji from existing guild emoji (for bot restarts without re-install).
 */
export async function syncProviderEmoji(guild: Guild): Promise<void> {
  try {
    const existing = await guild.emojis.fetch();
    for (const [key, emojiName] of Object.entries(PROVIDER_EMOJI_NAMES)) {
      const found = existing.find((e) => e.name === emojiName);
      if (found) {
        resolvedProviderEmoji[key as ProviderKey] = `<:${found.name}:${found.id}>`;
        resolvedProviderEmojiURL[key as ProviderKey] = `https://cdn.discordapp.com/emojis/${found.id}.png`;
      }
    }
  } catch { }
}


export async function provisionGuild(
  client: Client,
  guild: Guild,
  enabledKeys: string[],
  { pruneDisabled = false }: { pruneDisabled?: boolean } = {},
): Promise<ProvisionResult> {
  const result: ProvisionResult = { categoriesCreated: [], channelsCreated: [], skipped: [] };

  // Upload emoji first
  await uploadProviderEmoji(guild, enabledKeys);

  const existingCategories = new Map<string, CategoryChannel>();
  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildCategory) {
      existingCategories.set(ch.name, ch);
    }
  }

  for (const key of enabledKeys) {
    const provider = PROVIDERS[key];
    if (!provider) {
      result.skipped.push(key);
      continue;
    }
    const decorated = providerCategoryChannelName(provider);
    let category = findProviderCategory(existingCategories, provider);
    if (!category) {
      const created = await guild.channels.create({
        name: decorated,
        type: ChannelType.GuildCategory,
      });
      category = created;
      existingCategories.set(created.name, created);
      result.categoriesCreated.push(created.name);
    } else if (category.name !== decorated) {
      const prev = category.name;
      await category.setName(decorated);
      existingCategories.delete(prev);
      existingCategories.set(decorated, category);
    }

    client.projectStore.set(category.id, {
      channelId: category.id,
      createdAt: Date.now(),
    });

    const existingUnder = new Set(category.children.cache.map((c) => c.name));

    if (!existingUnder.has(BOT_COMMANDS_CHANNEL)) {
      await guild.channels.create({
        name: BOT_COMMANDS_CHANNEL,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `Run /project open to add project chats. Messages in a project channel start a CLI session, a thread (named from CLI output), and a live embed.`,
      });
      result.channelsCreated.push(`${category.name}/${BOT_COMMANDS_CHANNEL}`);
    }
  }

  if (pruneDisabled) {
    const knownBases = new Set(Object.values(PROVIDERS).map((p) => p.categoryName));
    for (const [, cat] of existingCategories) {
      const base = normalizeCategoryChannelName(cat.name);
      if (!knownBases.has(base)) continue;
      const shouldKeep = enabledKeys.some((k) => PROVIDERS[k]?.categoryName === base);
      if (!shouldKeep) {
        await cat.delete("Provider disabled — pruned by provisioner");
      }
    }
  }

  return result;
}

export async function clearGuild(guild: Guild): Promise<number> {
  let deleted = 0;
  const list = [...guild.channels.cache.values()].sort((a, b) => {
    const ra = "rawPosition" in a ? a.rawPosition : 0;
    const rb = "rawPosition" in b ? b.rawPosition : 0;
    return rb - ra;
  });
  for (const ch of list) {
    try {
      await ch.delete("Server clear requested via /install");
      deleted += 1;
    } catch {
    }
  }
  return deleted;
}
