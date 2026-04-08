export interface IdeProvider {
  key: string;
  displayName: string;
  categoryName: string;
  envKeys: readonly string[];
  description: string;
}

export const PROVIDERS: Record<string, IdeProvider> = {
  claude: {
    key: "claude",
    displayName: "Claude Code",
    categoryName: "Claude Code",
    envKeys: [],
    description: "Claude Code CLI (SDK uses local auth like T3 Code; optional ANTHROPIC_API_KEY for API-backed runs)",
  },
  codex: {
    key: "codex",
    displayName: "Codex",
    categoryName: "Codex",
    envKeys: [],
    description: "OpenAI Codex / Chat Completions API",
  },
  cursor: {
    key: "cursor",
    displayName: "Cursor",
    categoryName: "Cursor",
    envKeys: [],
    description: "Cursor bridge (requires runner service)",
  },
  antigravity: {
    key: "antigravity",
    displayName: "Antigravity",
    categoryName: "Antigravity",
    envKeys: [],
    description: "Antigravity bridge (vendor-specific)",
  },
} satisfies Record<string, IdeProvider>;

export type ProviderKey = keyof typeof PROVIDERS;

/** Emoji short names uploaded to the guild during /install. */
export const PROVIDER_EMOJI_NAMES: Partial<Record<ProviderKey, string>> = {
  claude: "ar_claude",
  codex: "ar_codex",
  cursor: "ar_cursor",
  antigravity: "ar_antigravity",
};

/** Provider → filename inside src/public/ */
export const PROVIDER_EMOJI_FILES: Partial<Record<ProviderKey, string>> = {
  claude: "claude.png",
  codex: "codex.png",
  cursor: "cursor.png",
  antigravity: "antigravity.png",
};

/**
 * Runtime cache of guild emoji strings (e.g. "<:ar_claude:123456>").
 */
export const resolvedProviderEmoji: Partial<Record<ProviderKey, string>> = {};

/**
 * Runtime cache of guild emoji image URLs for use in embed author icons.
 */
export const resolvedProviderEmojiURL: Partial<Record<ProviderKey, string>> = {};

export const PROVIDER_CATEGORY_NAME_UNICODE_PREFIX: Partial<Record<ProviderKey, string>> = {
  claude: "🟠",
  codex: "🧩",
  cursor: "💻",
  antigravity: "🛸",
};

export function normalizeCategoryChannelName(name: string): string {
  let s = name.trim().replace(/^(?:<a?:\w+:\d+>\s*)+/g, "").trim();
  for (const pre of Object.values(PROVIDER_CATEGORY_NAME_UNICODE_PREFIX)) {
    if (pre && s.startsWith(`${pre} `)) {
      s = s.slice(pre.length + 1).trim();
      break;
    }
  }
  return s;
}

export function providerCategoryChannelName(provider: IdeProvider): string {
  const prefix = PROVIDER_CATEGORY_NAME_UNICODE_PREFIX[provider.key as ProviderKey];
  return prefix ? `${prefix} ${provider.categoryName}` : provider.categoryName;
}

export const BOT_COMMANDS_CHANNEL = "bot-commands";
