import type { ChatRegistry } from "../bot/registry.js";
import type { PendingProjectCreate } from "../bot/pending-project.js";
import type { SessionStore } from "../session-store.js";
import type { AccessStore } from "../access-store.js";
import type { ModelStore } from "../model-store.js";
import type { ProjectStore } from "../project-store.js";

declare module "discord.js" {
  interface Client {
    chatRegistry: ChatRegistry;
    sessionStore: SessionStore;
    accessStore: AccessStore;
    modelStore: ModelStore;
    projectStore: ProjectStore;
    pendingProjectCreates: Map<string, PendingProjectCreate>;
    onInstallComplete: (() => void | Promise<void>) | null;
    /** Per-thread/channel model overrides set via /model. Key = threadId or channelId. */
    modelOverrides: Map<string, string>;
  }
}

export {};
