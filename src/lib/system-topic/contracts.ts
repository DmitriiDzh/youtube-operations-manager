import type { SystemCommandsConfig } from "./schemas";

/**
 * BL-228 (docs/roadmap/plans/SYSTEM_TOPIC_PLAN.md, ADR 0053; FO-REQ-0042): the owner's commands in the HUB group's "System"
 * topic, executed by the Manager. A feature module (AGENTS.md §M): off by default, and nothing else in the app depends on it.
 * Stage 1: the settings, the poller, `help` and `status`; `stop`, `go`, `approve`, `deny` are parsed and answered "not available yet".
 */

/**
 * Where the topic's messages come from (owner, msg 3602: the System topic is one topic of the EXISTING HUB bot, which another process
 * may already poll -- two getUpdates consumers on one bot steal each other's updates). `none` (the default): nothing is received.
 * `bot_get_updates`: this app long-polls the bot itself -- only when nothing else polls it. A source the HUB hands messages over
 * through is expected later; each source is one `SystemInbox` adapter, and everything after it is the same.
 */
export const SYSTEM_INBOX_SOURCES = ["none", "bot_get_updates"] as const;
export type SystemInboxSource = (typeof SYSTEM_INBOX_SOURCES)[number];

/** One received message, whatever the source. `updateId` is unique per message and the audit trail's key (a message runs once). */
export type SystemInboxMessage = {
  updateId: number;
  messageId: number | null;
  chatId: number | null;
  threadId: number | null;
  fromId: number | null;
  text: string | null;
  /** Telegram's send time (unix seconds) when the source knows it. */
  date: number | null;
};

/**
 * An inbound source. `cursor` is the source's own position (getUpdates: the offset), kept in the database between calls; the source
 * returns the next one. It may wait (a long poll) and must end its wait when `signal` fires. Its errors carry no secret.
 */
export type SystemInbox = {
  receive(input: { cursor: number | null; signal?: AbortSignal }): Promise<{ messages: SystemInboxMessage[]; nextCursor: number | null }>;
};

/** The long-poll wait per getUpdates call. */
export const SYSTEM_TOPIC_POLL_TIMEOUT_SECONDS = 25;
/** How long a `status` run may take before it is killed. */
export const SYSTEM_STATUS_TIMEOUT_MS = 60_000;
/** The `status` output posted (characters), then "…". */
export const SYSTEM_STATUS_OUTPUT_LIMIT = 3500;
/** The audit rows the Settings card shows. */
export const SYSTEM_TOPIC_RECENT_COMMANDS = 20;

export type SystemCommand =
  | { kind: "help" }
  | { kind: "status"; channel: string | null }
  | { kind: "stop"; channel: string; target: string }
  | { kind: "go"; channel: string }
  | { kind: "approve"; id: string }
  | { kind: "deny"; id: string }
  /** One of the six words, with the wrong arguments. */
  | { kind: "usage"; command: SystemCommandWord }
  | { kind: "unknown" };

export const SYSTEM_COMMAND_WORDS = ["help", "status", "stop", "go", "approve", "deny"] as const;
export type SystemCommandWord = (typeof SYSTEM_COMMAND_WORDS)[number];

/**
 * The outcome of one command. `received`: claimed before it runs (a crash mid-command leaves it so, and it is never run again).
 * `done` / `failed` (the command ran; `status` exited non-zero or timed out) / `refused` (a check said no) / `usage` / `unknown` /
 * `not_available` (stage 1: stop, go, approve, deny).
 */
export type SystemCommandStatus = "received" | "done" | "failed" | "refused" | "usage" | "unknown" | "not_available";

export type SystemTopicSettings = {
  /** The owner's Telegram user id (digits). */
  ownerUserId: string | null;
  /** The HUB group's chat id (a negative number, as text: it does not fit every number type). */
  chatId: string | null;
  /** The "System" topic's message_thread_id (digits). */
  threadId: string | null;
  /** This computer's listening switch (off by default; only the Mac service may turn it on). */
  listening: boolean;
  /** The factory-owned commands.json (absolute path); read on every command, never written. */
  commandsPath: string | null;
  /** Where messages come from (default `none`). */
  inboxSource: SystemInboxSource;
};

export type SystemTopicState = SystemTopicSettings & {
  pollOffset: number | null;
  droppedCount: number;
  lastPollAt: number | null;
  lastPollError: string | null;
  updatedAt: number | null;
};

export type SystemCommandRow = {
  updateId: number;
  fromUserId: string;
  text: string;
  command: string | null;
  status: SystemCommandStatus;
  resultText: string | null;
  replyError: string | null;
  receivedAt: number;
  finishedAt: number | null;
};

export type SystemTopicStore = {
  read(): Promise<SystemTopicState>;
  saveSettings(settings: SystemTopicSettings, at: number): Promise<void>;
  /** Records a finished poll: the new offset (when it moved), the messages dropped, and the error (null on success). */
  recordPoll(input: { offset: number | null; dropped: number; at: number; error: string | null }): Promise<void>;
  /** Inserts the audit row as `received`; false when this update id is already recorded (it is then never run again). */
  claimCommand(row: { updateId: number; fromUserId: string; text: string; command: string | null; receivedAt: number }): Promise<boolean>;
  finishCommand(updateId: number, patch: { status: SystemCommandStatus; resultText: string; replyError: string | null; finishedAt: number }): Promise<void>;
  recentCommands(limit: number): Promise<SystemCommandRow[]>;
};

export type ProcessResult = { output: string; exitCode: number | null; timedOut: boolean; error: string | null };

export type ProcessRunnerPort = (argv: readonly string[], options: { cwd: string | undefined; timeoutMs: number }) => Promise<ProcessResult>;

/** The replies: always the bot's sendMessage, whatever the inbound source. */
export type TelegramReplyPort = {
  sendMessage(token: string, input: { chatId: string; threadId: number | null; text: string }): Promise<{ messageId: number | null }>;
};

/** The token slot (device-secrets `telegram_system_bot`). */
export type BotTokenPort = {
  read(): Promise<string | null>;
  hasToken(): Promise<boolean>;
  /** The bot's numeric id (the part before the colon, not secret) when a token is stored. */
  botId(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
};

export type SystemTopicDeps = {
  store: SystemTopicStore;
  replies: TelegramReplyPort;
  /** The inbound adapters by source; a source without one receives nothing. */
  inboxes: Partial<Record<Exclude<SystemInboxSource, "none">, SystemInbox>>;
  token: BotTokenPort;
  /** The factory config's text (null when the file does not exist). */
  readConfigFile(path: string): Promise<string | null>;
  /** This computer's workspace path of a channel (channel-workspaces), or null when none is set. */
  channelWorkspacePath(channelId: string): Promise<string | null>;
  runProcess: ProcessRunnerPort;
  /** `YTOM_SERVICE_MODE === "1"` on macOS: the only place the switch may be on and the poller may run. */
  serviceMode(): boolean;
  clock(): number;
  log?(event: string, context: Record<string, unknown>): void;
};

/** What the Settings card shows: never the token, only whether one is stored. */
export type SystemTopicView = SystemTopicSettings & {
  hasToken: boolean;
  botId: string | null;
  serviceMode: boolean;
  /** Whether the poller runs now (switch on, service, token, ids and an inbound source with an adapter). */
  active: boolean;
  droppedCount: number;
  lastPollAt: string | null;
  lastPollError: string | null;
  recent: Array<Omit<SystemCommandRow, "receivedAt" | "finishedAt"> & { receivedAt: string; finishedAt: string | null }>;
};

export type { SystemCommandsConfig };
