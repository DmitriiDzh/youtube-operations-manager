import { createHash, timingSafeEqual } from "node:crypto";
import { DomainError, parseWithSchema } from "@/lib/shared-domain";
import {
  SYSTEM_OUTBOX_BATCH,
  SYSTEM_REPLY_LIMIT,
  SYSTEM_TOPIC_RECENT_COMMANDS,
  type SystemCommand,
  type SystemCommandStatus,
  type SystemInboundMessage,
  type SystemTopicDeps,
  type SystemTopicState,
  type SystemTopicView,
} from "./contracts";
import { parseSystemCommand, SYSTEM_COMMAND_USAGE, SYSTEM_HELP_TEXT, SYSTEM_HUB_REPLY } from "./parser";
import { systemInboundSchema, systemTopicSettingsInputSchema } from "./schemas";

// BL-228 (docs/roadmap/plans/SYSTEM_TOPIC_PLAN.md, ADR 0053 Amendment 1): the pure services -- the owner's settings, the relay secret,
// the hub's relayed messages and the outbox the hub posts from. Everything outside comes in through `SystemTopicDeps`. Replies are
// English (bot replies follow the MCP/API/CLI rule, AGENTS.md §H).

type Outcome = { status: SystemCommandStatus; text: string };

/** Cuts a reply to the limit without splitting a character (a broken surrogate pair makes Telegram refuse the message). */
export function fitReply(text: string, limit: number = SYSTEM_REPLY_LIMIT): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The relay secret's prefix: recognisable in a config file, and never mistaken for a Telegram token. */
export const RELAY_SECRET_PREFIX = "ytmrelay_";

function settingsComplete(state: SystemTopicState): boolean {
  return state.ownerUserId !== null && state.chatId !== null && state.threadId !== null;
}

export function createSystemTopic(deps: SystemTopicDeps) {
  const log = deps.log ?? (() => undefined);

  function isActive(state: SystemTopicState): boolean {
    return state.enabled && deps.serviceMode() && settingsComplete(state) && state.relaySecretHash !== null;
  }

  const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());

  async function view(): Promise<SystemTopicView> {
    const state = await deps.store.read();
    const recent = await deps.store.recentCommands(SYSTEM_TOPIC_RECENT_COMMANDS);
    return {
      ownerUserId: state.ownerUserId,
      chatId: state.chatId,
      threadId: state.threadId,
      enabled: state.enabled,
      requestsPath: state.requestsPath,
      relaySecret: { set: state.relaySecretHash !== null, createdAt: iso(state.relaySecretCreatedAt) },
      serviceMode: deps.serviceMode(),
      active: isActive(state),
      droppedCount: state.droppedCount,
      lastInboundAt: iso(state.lastInboundAt),
      lastOutboxAt: iso(state.lastOutboxAt),
      lastScanAt: iso(state.lastScanAt),
      lastScanError: state.lastScanError,
      recent: recent.map((row) => ({ ...row, receivedAt: new Date(row.receivedAt).toISOString(), finishedAt: iso(row.finishedAt) })),
    };
  }

  /** The relay works only with the switch on, under the Mac service, with the ids set (else 409 system_topic_disabled). */
  async function requireRelayState(): Promise<SystemTopicState> {
    const state = await deps.store.read();
    if (!state.enabled || !deps.serviceMode() || !settingsComplete(state)) {
      throw new DomainError({ code: "system_topic_disabled", message: "The System topic is off on this computer (Settings → AI agent → System)" });
    }
    return state;
  }

  async function execute(command: SystemCommand): Promise<Outcome> {
    switch (command.kind) {
      case "help":
        return { status: "done", text: SYSTEM_HELP_TEXT };
      case "hub":
        return { status: "hub", text: SYSTEM_HUB_REPLY };
      case "approve":
        return deps.approvals ? deps.approvals.approveInTopic(command.id) : { status: "refused", text: "approvals are not available" };
      case "deny":
        return deps.approvals ? deps.approvals.denyInTopic(command.id) : { status: "refused", text: "approvals are not available" };
      case "usage":
        return { status: "usage", text: `usage: ${SYSTEM_COMMAND_USAGE[command.command]}` };
      case "unknown":
        return { status: "unknown", text: "unknown command, see help" };
    }
  }

  /** True when the message is the owner's, in the configured chat and topic, with text (AC-SYS-01/02). */
  function accepted(state: SystemTopicState, message: SystemInboundMessage): boolean {
    if (message.text === null || message.chatId === null || message.threadId === null || message.fromId === null) return false;
    return String(message.chatId) === state.chatId && String(message.threadId) === state.threadId && String(message.fromId) === state.ownerUserId;
  }

  return {
    view,

    /** The owner's settings. The switch may be turned on only under the Mac service and with the three ids set. */
    async saveSettings(input: unknown): Promise<SystemTopicView> {
      const settings = parseWithSchema(systemTopicSettingsInputSchema, input, "System topic settings");
      if (settings.enabled) {
        if (!deps.serviceMode()) {
          throw new DomainError({ code: "system_topic_needs_service", message: "Only the Mac's system service (YTOM_SERVICE_MODE=1) may run the System topic" });
        }
        if (settings.ownerUserId === null || settings.chatId === null || settings.threadId === null) {
          throw new DomainError({ code: "system_topic_incomplete", message: "Set the owner's user id, the group id and the topic id before turning it on" });
        }
      }
      await deps.store.saveSettings(settings, deps.clock());
      log("system_topic.settings_saved", { enabled: settings.enabled });
      return view();
    },

    /**
     * A new relay secret: returned once, here, and never again; only its SHA-256 is stored. The previous one stops working at once
     * (the hub must be given the new one).
     */
    async generateRelaySecret(): Promise<{ secret: string; view: SystemTopicView }> {
      const secret = `${RELAY_SECRET_PREFIX}${deps.randomBytes().toString("base64url")}`;
      await deps.store.setRelaySecretHash(sha256Hex(secret), deps.clock());
      log("system_topic.relay_secret_generated", {});
      return { secret, view: await view() };
    },

    /** Whether an `Authorization` header carries the current relay secret (constant-time compare of the hashes). */
    async verifyRelayAuthorization(header: string | null): Promise<boolean> {
      const state = await deps.store.read();
      if (!state.relaySecretHash || !header) return false;
      const match = /^Bearer (\S{1,512})$/.exec(header.trim());
      if (!match) return false;
      const given = Buffer.from(sha256Hex(match[1]), "hex");
      const stored = Buffer.from(state.relaySecretHash, "hex");
      return given.length === stored.length && timingSafeEqual(given, stored);
    },

    /**
     * One message the hub relays. Not the owner's, not in the configured chat and topic, or without text: dropped silently (only
     * the counter rises, no reply, no audit row). The audit row is claimed before the command runs: a repeated update id gets no
     * second run and no second reply.
     */
    async handleInbound(raw: unknown): Promise<{ replies: string[] }> {
      const state = await requireRelayState();
      const message = parseWithSchema(systemInboundSchema, raw, "relayed message");
      const at = deps.clock();
      if (!accepted(state, message)) {
        await deps.store.recordInbound({ dropped: 1, at });
        log("system_topic.dropped", { updateId: message.updateId });
        return { replies: [] };
      }
      await deps.store.recordInbound({ dropped: 0, at });
      const text = message.text!;
      const command = parseSystemCommand(text);
      const fresh = await deps.store.claimCommand({ updateId: message.updateId, fromUserId: state.ownerUserId!, text: text.slice(0, 4096), command: command.kind, receivedAt: at });
      if (!fresh) return { replies: [] };
      let outcome: Outcome;
      try {
        outcome = await execute(command);
      } catch (error) {
        outcome = { status: "refused", text: `failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      const reply = fitReply(outcome.text);
      await deps.store.finishCommand(message.updateId, { status: outcome.status, resultText: reply, finishedAt: deps.clock() });
      log("system_topic.command", { updateId: message.updateId, command: command.kind, status: outcome.status });
      return { replies: [reply] };
    },

    /** The queued messages for the hub to post, each handed out once (marked delivered as it is returned). */
    async takeOutbox(): Promise<{ messages: Array<{ id: string; text: string }> }> {
      await requireRelayState();
      const at = deps.clock();
      const messages = await deps.store.takeOutbox(at, SYSTEM_OUTBOX_BATCH);
      return { messages };
    },

    /** Stamps the last scan of the requests folder (null: it went through). */
    async recordScan(error: string | null): Promise<void> {
      await deps.store.recordScan({ at: deps.clock(), error: error === null ? null : error.slice(0, 500) });
    },

    /** Queues a message for the hub to post in the topic. */
    async enqueue(text: string): Promise<void> {
      await deps.store.enqueueOutbox({ id: deps.newId(), text: fitReply(text), createdAt: deps.clock() });
    },
  };
}

export type SystemTopic = ReturnType<typeof createSystemTopic>;
