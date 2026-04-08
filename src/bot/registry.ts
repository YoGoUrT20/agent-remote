import type { BaseAdapter } from "../adapters/base.js";

export interface DiscordChatSession {
  providerKey: string;
  adapter: BaseAdapter;
}

export class ChatRegistry {
  private readonly _sessions = new Map<string, DiscordChatSession>();

  add(threadId: string, session: DiscordChatSession): void {
    this._sessions.set(threadId, session);
  }

  get(threadId: string): DiscordChatSession | undefined {
    return this._sessions.get(threadId);
  }

  remove(threadId: string): void {
    this._sessions.delete(threadId);
  }
}
