import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  ThreadAutoArchiveDuration,
  type ThreadChannel,
} from "discord.js";
import type { BaseAdapter } from "../../adapters/base.js";
import { loadSettings, type Settings } from "../../config.js";
import { isUserAllowed } from "../../access-store.js";
import { runSerial } from "../serial-queue.js";
import { buildChatAdapter } from "../../adapters/factory.js";
import {
  isVoiceMessage,
  pickVoiceAttachment,
  transcribeVoiceAttachment,
  type VoiceTranscription,
} from "../../voice/index.js";
import { downloadAllAttachments } from "../../attachments.js";
import type { WhisperDType } from "../../voice/transcribe.js";
import {
  BOT_COMMANDS_CHANNEL,
  PROVIDERS,
  PROVIDER_MODELS,
  resolvedProviderEmojiURL,
  type ProviderKey,
} from "../../constants.js";
import {
  categoryFromProjectParent,
  currentAccess,
  MAX_EMBED_DESC,
  persistSessionId,
  projectWorkspaceCwd,
  providerKeyFromCategory,
  resolveModelLabel,
  slugifyThreadTitle,
} from "./utils.js";

/* ── Streaming embed for assistant replies ── */

async function streamAssistantRepliesEmbed(
  thread: ThreadChannel,
  adapter: BaseAdapter,
  options: { fallbackThreadTitle: string; providerKey: ProviderKey; skipRename?: boolean; modelLabel?: string; pingUserId?: string },
): Promise<void> {
  const { fallbackThreadTitle, providerKey, skipRename = false, modelLabel, pingUserId } = options;
  let reasoning = "";
  let response = "";
  let lastEdit = 0;
  let named = skipRename;
  let hasError = false;
  const turnStartTime = performance.now();

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

  const buildFooter = (stats?: { inputTokens?: number; outputTokens?: number; elapsed?: number }): { text: string; iconURL?: string } | null => {
    const parts: string[] = [];
    if (modelLabel) parts.push(modelLabel);
    if (stats?.elapsed != null) {
      const secs = stats.elapsed;
      parts.push(secs >= 60 ? `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s` : `${secs.toFixed(1)}s`);
    }
    if (stats?.outputTokens) {
      const tok = stats.outputTokens;
      if (stats.elapsed && stats.elapsed > 0) {
        const tps = tok / stats.elapsed;
        parts.push(`${tok.toLocaleString()} tokens (${tps.toFixed(1)} tok/s)`);
      } else {
        parts.push(`${tok.toLocaleString()} tokens`);
      }
    }
    if (parts.length === 0) return null;
    return { text: parts.join("  ·  "), ...(emojiURL ? { iconURL: emojiURL } : {}) };
  };

  const buildEmbed = (description: string, color: number, stats?: { inputTokens?: number; outputTokens?: number; elapsed?: number }) => {
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: providerName, ...(emojiURL ? { iconURL: emojiURL } : {}) })
      .setDescription(
        description.length > MAX_EMBED_DESC ? `${description.slice(0, MAX_EMBED_DESC)}…` : description,
      );
    const footer = buildFooter(stats);
    if (footer) embed.setFooter(footer);
    return embed;
  };

  const liveElapsed = () => (performance.now() - turnStartTime) / 1000;

  const statusMsg = await thread.send({
    embeds: [buildEmbed(":hourglass_flowing_sand: Thinking...", 0x5865f2, { elapsed: 0 })],
  });

  /* Tick the footer timer while the turn is in flight. */
  const tickTimer = setInterval(async () => {
    const body = formatBody() || ":hourglass_flowing_sand: Thinking...";
    const now = performance.now() / 1000;
    if (now - lastEdit < 0.85) return;
    lastEdit = now;
    try {
      await statusMsg.edit({
        embeds: [buildEmbed(body, 0x5865f2, { elapsed: liveElapsed() })],
      });
    } catch {}
  }, 1000);

  const render = async (throttle: boolean) => {
    const body = formatBody() || ":hourglass_flowing_sand: Thinking...";
    const now = performance.now() / 1000;
    if (throttle && now - lastEdit < 0.85) return;
    lastEdit = now;
    try {
      await statusMsg.edit({
        embeds: [buildEmbed(body, 0x5865f2, { elapsed: liveElapsed() })],
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
      clearInterval(tickTimer);
      const err = (event.data || "error").slice(0, MAX_EMBED_DESC);
      try {
        await statusMsg.edit({
          embeds: [buildEmbed(err, 0xed4245, { elapsed: liveElapsed() })],
        });
      } catch {
        await thread.send({ embeds: [buildEmbed(err, 0xed4245, { elapsed: liveElapsed() })] });
      }
      hasError = true;
    } else if (event.type === "done") {
      clearInterval(tickTimer);
      const elapsed = (performance.now() - turnStartTime) / 1000;
      const inputTokens = typeof event.metadata?.inputTokens === "number" ? event.metadata.inputTokens : undefined;
      const outputTokens = typeof event.metadata?.outputTokens === "number" ? event.metadata.outputTokens : undefined;
      const stats = { inputTokens, outputTokens, elapsed };

      if (!hasError) {
        const body = formatBody();
        try {
          await statusMsg.edit({
            embeds: [buildEmbed(body || "Done.", 0x57f287, stats)],
          });
        } catch {
        }
        if (pingUserId) {
          try {
            await thread.send({
              content: `<@${pingUserId}>`,
              allowedMentions: { users: [pingUserId] },
            });
          } catch {}
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

/* ── Voice transcription helpers ── */

function formatVoiceDuration(seconds: number): string {
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${seconds.toFixed(1)}s`;
}

function voiceTranscriptionEmbed(voice: VoiceTranscription, modelId: string): EmbedBuilder {
  const trimmed = voice.text.trim();
  const description = trimmed
    ? "> " + trimmed.replace(/\n/g, "\n> ")
    : "_(no speech detected)_";
  const modelShort = modelId.split("/").pop() ?? modelId;
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: `🎙️ Voice message · ${formatVoiceDuration(voice.durationSeconds)}` })
    .setDescription(description.length > MAX_EMBED_DESC ? `${description.slice(0, MAX_EMBED_DESC)}…` : description)
    .setFooter({ text: `Transcribed locally with ${modelShort}` });
}

interface ResolvedInput {
  text: string;
  voice: VoiceTranscription | null;
  voiceModelId: string;
}

/** Resolve a message's effective input text, transcribing voice attachments
    if present. Returns null if the message can't produce any input. */
async function resolveInput(message: import("discord.js").Message, settings: Settings): Promise<ResolvedInput | null> {
  const rawText = (message.content ?? "").trim();
  if (!settings.voiceEnabled || !isVoiceMessage(message)) {
    return rawText ? { text: rawText, voice: null, voiceModelId: settings.voiceWhisperModel } : null;
  }
  const att = pickVoiceAttachment(message);
  if (!att) return rawText ? { text: rawText, voice: null, voiceModelId: settings.voiceWhisperModel } : null;
  try { await message.react("🎙️"); } catch {}
  try {
    const voice = await transcribeVoiceAttachment(att, {
      modelId: settings.voiceWhisperModel,
      dtype: settings.voiceWhisperDtype as WhisperDType,
      language: settings.voiceLanguage,
    });
    const text = voice.text.trim() || rawText;
    if (!text) return { text: "", voice, voiceModelId: settings.voiceWhisperModel };
    return { text, voice, voiceModelId: settings.voiceWhisperModel };
  } catch (e) {
    console.error("voice transcription failed:", e);
    const errEmbed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("Voice transcription failed")
      .setDescription(e instanceof Error ? e.message : String(e));
    try {
      if (message.channel.isTextBased() && "send" in message.channel) {
        await (message.channel as { send: (o: { embeds: EmbedBuilder[] }) => Promise<unknown> }).send({ embeds: [errEmbed] });
      }
    } catch {}
    return null;
  }
}

/* ── Register MessageCreate handler ── */

export function registerMessageHandler(client: Client): void {
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
      const pk = providerKeyFromCategory(client, cat);
      if (!pk) return;
      const settingsForInput = loadSettings();
      const resolved = await resolveInput(message, settingsForInput);
      if (!resolved || !resolved.text) return;
      const text = resolved.text;
      if (resolved.voice) {
        try {
          await threadCh.send({ embeds: [voiceTranscriptionEmbed(resolved.voice, resolved.voiceModelId)] });
        } catch {}
      }
      let sess = client.chatRegistry.get(threadCh.id);

      /* Restore persisted model override if not already set in-memory */
      if (!client.modelOverrides.has(threadCh.id)) {
        const persisted = client.sessionStore.get(threadCh.id);
        if (persisted?.model) client.modelOverrides.set(threadCh.id, persisted.model);
      }

      /* Check if model override requires session restart */
      const modelOverride = client.modelOverrides.get(threadCh.id);
      if (sess && modelOverride) {
        const currentModel = sess.adapter.getSessionModel(threadCh.id);
        if (currentModel && currentModel !== modelOverride) {
          try {
            await sess.adapter.stopSession(threadCh.id);
          } catch {}
          client.chatRegistry.remove(threadCh.id);
          sess = undefined;
        }
      }

      /* Session missing (e.g. bot restarted or model changed) — resume from persisted session */
      if (!sess) {
        const settings = loadSettings();
        let enabledList = settings.enabledProviderKeys();
        if (!enabledList.length) enabledList = ["claude"];
        if (!enabledList.includes(pk)) return;
        try {
          const adapter = buildChatAdapter(pk, settings);
          const cwdOpt = projectWorkspaceCwd(settings, parent.name);
          const persisted = client.sessionStore.get(threadCh.id);
          const sessionModel = modelOverride ?? client.modelStore.getDefaultModel(pk) ?? undefined;
          await adapter.startSession({
            threadId: threadCh.id,
            cwd: cwdOpt,
            model: sessionModel,
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
      const downloaded = await downloadAllAttachments(message);
      const attachments = downloaded.map((a) => ({ type: a.type, mimeType: a.mimeType, data: a.data, fileName: a.fileName }));
      const pingEnabled = access.pingOnResponse;
      await runSerial(threadCh.id, async () => {
        try {
          await threadCh.sendTyping();
          await session.adapter.sendTurn({ threadId: threadCh.id, input: text, attachments });
          const activeModel = session.adapter.getSessionModel(threadCh.id) ?? client.modelOverrides.get(threadCh.id);
          await streamAssistantRepliesEmbed(threadCh, session.adapter, {
            fallbackThreadTitle: threadCh.name,
            providerKey: pk,
            skipRename: true,
            modelLabel: resolveModelLabel(pk, activeModel),
            pingUserId: pingEnabled ? message.author.id : undefined,
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
    const pk = providerKeyFromCategory(client, cat);
    if (!pk) return;
    const settings = loadSettings();
    let enabledList = settings.enabledProviderKeys();
    if (!enabledList.length) enabledList = ["claude"];
    if (!enabledList.includes(pk)) return;
    if (!client.projectStore.has(message.channel.id)) return;
    const resolved = await resolveInput(message, settings);
    if (!resolved || !resolved.text) return;
    const text = resolved.text;

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
    if (resolved.voice) {
      try {
        await thread.send({ embeds: [voiceTranscriptionEmbed(resolved.voice, resolved.voiceModelId)] });
      } catch {}
    }

    const newThreadAttachments = await downloadAllAttachments(message);
    const newThreadAttachmentPayload = newThreadAttachments.map((a) => ({ type: a.type, mimeType: a.mimeType, data: a.data, fileName: a.fileName }));
    let adapter: BaseAdapter | null = null;
    try {
      adapter = buildChatAdapter(pk, settings);
      const cwdOpt = projectWorkspaceCwd(settings, message.channel.name);
      /* Model resolution order: channel /model override → /settings default → env/config default */
      const channelModelOverride =
        client.modelOverrides.get(message.channel.id) ??
        client.modelStore.getDefaultModel(pk);
      await adapter.startSession({ threadId: thread.id, cwd: cwdOpt, model: channelModelOverride });
      await adapter.sendTurn({ threadId: thread.id, input: text, attachments: newThreadAttachmentPayload });
      const session = { providerKey: pk, adapter };
      client.chatRegistry.add(thread.id, session);
      /* Propagate channel-level model override to the thread so subsequent /model checks work */
      if (channelModelOverride) client.modelOverrides.set(thread.id, channelModelOverride);
      adapter = null;
      const pingEnabledNewThread = access.pingOnResponse;
      await runSerial(thread.id, async () => {
        const newSessionModel = session.adapter.getSessionModel(thread.id) ?? channelModelOverride;
        await streamAssistantRepliesEmbed(thread, session.adapter, {
          fallbackThreadTitle: text,
          providerKey: pk,
          modelLabel: resolveModelLabel(pk, newSessionModel),
          pingUserId: pingEnabledNewThread ? message.author.id : undefined,
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
