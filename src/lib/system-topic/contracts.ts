/**
 * BL-228 (docs/roadmap/plans/SYSTEM_TOPIC_PLAN.md, ADR 0053 + Amendment 1; FO-RESP-0043 H4, owner msg 3607): the HUB group's
 * "System" topic. The hub (`hub_bot.py`, the factory's) polls the HUB bot and keeps `status` / `stop` / `go`; it relays the
 * System topic's messages to this app over loopback HTTP and posts what this app queues. The Manager does only one-time paid
 * approvals: the owner's `approve <id>` in the topic AND one confirm in the Web UI. The Manager makes no Telegram call.
 * A feature module (AGENTS.md §M): off by default, and nothing else in the app depends on it.
 */

/** A reply the Manager gives at most (the hub posts it as one Telegram message, 4096 characters at most). */
export const SYSTEM_REPLY_LIMIT = 4000;
/** The audit rows the Settings card shows. */
export const SYSTEM_TOPIC_RECENT_COMMANDS = 20;
/** The outbox messages one GET hands out at most. */
export const SYSTEM_OUTBOX_BATCH = 20;

export type SystemCommand =
  | { kind: "help" }
  /** `status` / `stop` / `go`: the hub handles them in each channel's topic (FO-RESP-0043 H4). */
  | { kind: "hub"; word: "status" | "stop" | "go" }
  | { kind: "approve"; id: string }
  | { kind: "deny"; id: string }
  /** One of the commands, with the wrong arguments. */
  | { kind: "usage"; command: "help" | "approve" | "deny" }
  | { kind: "unknown" };

/**
 * The outcome of one command. `received`: claimed before it runs (a crash mid-command leaves it so, and it is never run again).
 * `done` / `refused` (a check said no) / `usage` / `unknown` / `hub` (answered "handled by the hub").
 */
export type SystemCommandStatus = "received" | "done" | "refused" | "usage" | "unknown" | "hub";

export type SystemTopicSettings = {
  /** The owner's Telegram user id (digits). */
  ownerUserId: string | null;
  /** The HUB group's chat id (a negative number, as text: it does not fit every number type). */
  chatId: string | null;
  /** The "System" topic's message_thread_id (digits). */
  threadId: string | null;
  /** This computer's switch (off by default; only the Mac service may turn it on). */
  enabled: boolean;
  /** The factory's `00 YT Operator/System/requests` folder (absolute path); read, and only `<id>.result.json` is written there. */
  requestsPath: string | null;
};

export type SystemTopicState = SystemTopicSettings & {
  /** SHA-256 (hex) of the relay secret; the secret itself is never stored. */
  relaySecretHash: string | null;
  relaySecretCreatedAt: number | null;
  droppedCount: number;
  lastInboundAt: number | null;
  lastOutboxAt: number | null;
  lastScanAt: number | null;
  lastScanError: string | null;
  updatedAt: number | null;
};

export type SystemCommandRow = {
  updateId: number;
  fromUserId: string;
  text: string;
  command: string | null;
  status: SystemCommandStatus;
  resultText: string | null;
  receivedAt: number;
  finishedAt: number | null;
};

export type SystemTopicStore = {
  read(): Promise<SystemTopicState>;
  saveSettings(settings: SystemTopicSettings, at: number): Promise<void>;
  setRelaySecretHash(hash: string, at: number): Promise<void>;
  /** Adds dropped messages and stamps the last inbound call. */
  recordInbound(input: { dropped: number; at: number }): Promise<void>;
  recordScan(input: { at: number; error: string | null }): Promise<void>;
  /** Inserts the audit row as `received`; false when this update id is already recorded (it is then never run again). */
  claimCommand(row: { updateId: number; fromUserId: string; text: string; command: string | null; receivedAt: number }): Promise<boolean>;
  finishCommand(updateId: number, patch: { status: SystemCommandStatus; resultText: string; finishedAt: number }): Promise<void>;
  recentCommands(limit: number): Promise<SystemCommandRow[]>;
  enqueueOutbox(row: { id: string; text: string; createdAt: number }): Promise<void>;
  /** The undelivered messages, oldest first, marked delivered in the same step (each is handed out once). */
  takeOutbox(at: number, limit: number): Promise<Array<{ id: string; text: string }>>;
};

/** One message the hub relays (FO-RESP-0043 H1). */
export type SystemInboundMessage = {
  updateId: number;
  messageId: number | null;
  chatId: number | null;
  threadId: number | null;
  fromId: number | null;
  /** Telegram's send time (unix seconds) when known. */
  date: number | null;
  text: string | null;
};

/** The `approve` / `deny` commands' answers, from the approvals part (absent: "not available"). */
export type SystemApprovalCommands = {
  approveInTopic(id: string): Promise<{ status: SystemCommandStatus; text: string }>;
  denyInTopic(id: string): Promise<{ status: SystemCommandStatus; text: string }>;
};

export type SystemTopicDeps = {
  store: SystemTopicStore;
  /** `YTOM_SERVICE_MODE === "1"` on macOS: the only place the switch may be on. */
  serviceMode(): boolean;
  clock(): number;
  newId(): string;
  /** 32 random bytes for a new relay secret. */
  randomBytes(): Buffer;
  approvals?: SystemApprovalCommands;
  log?(event: string, context: Record<string, unknown>): void;
};

/** What the Settings card shows: never the relay secret, only whether one is set. */
export type SystemTopicView = SystemTopicSettings & {
  relaySecret: { set: boolean; createdAt: string | null };
  serviceMode: boolean;
  /** Whether the relay works now (switch on, service, ids and a relay secret). */
  active: boolean;
  droppedCount: number;
  lastInboundAt: string | null;
  lastOutboxAt: string | null;
  lastScanAt: string | null;
  lastScanError: string | null;
  recent: Array<Omit<SystemCommandRow, "receivedAt" | "finishedAt"> & { receivedAt: string; finishedAt: string | null }>;
};
