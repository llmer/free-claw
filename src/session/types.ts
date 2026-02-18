export type SessionStatus = "idle" | "running" | "cancelled";

export type ChatSession = {
  chatId: number;
  sessionId: string;
  status: SessionStatus;
  workDir: string;
  createdAt: string;
  lastMessageAt: string;
  /** Number of messages exchanged in this session. */
  messageCount: number;
};

export type TaskRun = {
  chatId: number;
  sessionId: string;
  prompt: string;
  startedAt: string;
  /** Accumulated response text (for streaming). */
  responseText: string;
};

export type SessionStoreFile = {
  version: 1;
  sessions: Record<string, ChatSession>;
};
