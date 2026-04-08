import type { ChatRegistry } from "../bot/registry.js";
import type { PendingProjectCreate } from "../bot/pending-project.js";

declare module "discord.js" {
  interface Client {
    chatRegistry: ChatRegistry;
    pendingProjectCreates: Map<string, PendingProjectCreate>;
    onInstallComplete: (() => void | Promise<void>) | null;
  }
}

export {};
