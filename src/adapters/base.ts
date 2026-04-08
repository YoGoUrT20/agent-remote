export const EventType = {
  TEXT_DELTA: "text_delta",
  TOOL_START: "tool_start",
  TOOL_RESULT: "tool_result",
  ERROR: "error",
  DONE: "done",
  THREAD_TITLE: "thread_title",
} as const;

export type EventTypeName = (typeof EventType)[keyof typeof EventType];

export interface AdapterEvent {
  type: EventTypeName;
  data: string;
  metadata?: Record<string, unknown> | null;
}

export function makeEvent(
  type: EventTypeName,
  data = "",
  metadata: Record<string, unknown> | null = null,
): AdapterEvent {
  return { type, data, metadata };
}

export interface ProviderSession {
  threadId: string;
  status: "connecting" | "ready" | "running" | "error" | "closed";
  cwd?: string;
  model?: string;
  resumeCursor?: unknown;
  activeTurnId?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface ProviderSendTurnInput {
  threadId: string;
  input?: string;
  attachments?: Array<{ type: string; mimeType: string; data: string }>;
}

export interface ProviderTurnStartResult {
  threadId: string;
  turnId: string;
  resumeCursor?: unknown;
}

export abstract class BaseAdapter {
  abstract readonly provider: string;

  abstract startSession(input: {
    threadId: string;
    cwd?: string;
    model?: string;
    resumeCursor?: unknown;
  }): Promise<ProviderSession>;

  abstract sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult>;

  abstract interruptTurn(threadId: string, turnId?: string): Promise<void>;

  abstract stopSession(threadId: string): Promise<void>;

  abstract streamEvents(): AsyncGenerator<AdapterEvent, void, undefined>;

  listSessions(): Promise<ReadonlyArray<ProviderSession>> {
    return Promise.resolve([]);
  }

  hasSession(_threadId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  async healthcheck(): Promise<boolean> {
    return true;
  }
}
