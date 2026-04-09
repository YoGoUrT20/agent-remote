import type { ChatRegistry } from "../bot/registry.js";
import type { PendingProjectCreate } from "../bot/pending-project.js";
import type { SessionStore } from "../session-store.js";

declare module "discord.js" {
  interface Client {
    chatRegistry: ChatRegistry;
    sessionStore: SessionStore;
    pendingProjectCreates: Map<string, PendingProjectCreate>;
    onInstallComplete: (() => void | Promise<void>) | null;
  }
}

export {};
