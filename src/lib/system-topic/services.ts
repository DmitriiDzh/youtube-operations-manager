import path from "node:path";
import { fitTelegramText, redactTelegramToken } from "@/lib/telegram-bot-gateway";
import { DomainError, parseWithSchema } from "@/lib/shared-domain";
import {
  SYSTEM_STATUS_OUTPUT_LIMIT,
  SYSTEM_STATUS_TIMEOUT_MS,
  SYSTEM_TOPIC_RECENT_COMMANDS,
  type SystemCommand,
  type SystemCommandStatus,
  type SystemInbox,
  type SystemInboxMessage,
  type SystemTopicDeps,
  type SystemTopicState,
  type SystemTopicView,
} from "./contracts";
import { parseSystemCommand, SYSTEM_COMMAND_USAGE, SYSTEM_HELP_TEXT } from "./parser";
import { systemCommandsConfigSchema, systemTopicSettingsInputSchema, systemTopicTokenInputSchema, type SystemCommandsConfig } from "./schemas";

// BL-228 (docs/roadmap/plans/SYSTEM_TOPIC_PLAN.md, ADR 0053): the pure services -- the owner's settings, one poll of the topic, and
// the command runners. Everything outside (the database, Telegram, the token, the factory's config file, the channel workspaces, the
// child process) comes in through `SystemTopicDeps`. Replies are English (bot replies follow the MCP/API/CLI rule, AGENTS.md §H).

type Outcome = { status: SystemCommandStatus; text: string };

/** The `status` output cut to 3500 characters (never inside a character), then "…" (plan §3, AC-SYS-03). */
export function cutStatusOutput(output: string, limit: number = SYSTEM_STATUS_OUTPUT_LIMIT): string {
  const chars = Array.from(output);
  return chars.length <= limit ? output : `${chars.slice(0, limit).join("")}…`;
}

function settingsComplete(state: SystemTopicState): boolean {
  return state.ownerUserId !== null && state.chatId !== null && state.threadId !== null;
}

/** An argument that names a relative path (it has a `/`, is not absolute and is not a flag). */
function isRelativePath(arg: string): boolean {
  return arg.includes("/") && !path.isAbsolute(arg) && !arg.startsWith("-");
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createSystemTopic(deps: SystemTopicDeps) {
  const log = deps.log ?? (() => undefined);

  function inboxOf(state: SystemTopicState): SystemInbox | null {
    return state.inboxSource === "none" ? null : (deps.inboxes[state.inboxSource] ?? null);
  }

  async function isActive(state: SystemTopicState): Promise<boolean> {
    return state.listening && deps.serviceMode() && settingsComplete(state) && inboxOf(state) !== null && (await deps.token.hasToken());
  }

  async function view(): Promise<SystemTopicView> {
    const state = await deps.store.read();
    const [hasToken, botId, recent] = await Promise.all([deps.token.hasToken(), deps.token.botId(), deps.store.recentCommands(SYSTEM_TOPIC_RECENT_COMMANDS)]);
    return {
      ownerUserId: state.ownerUserId,
      chatId: state.chatId,
      threadId: state.threadId,
      listening: state.listening,
      commandsPath: state.commandsPath,
      inboxSource: state.inboxSource,
      hasToken,
      botId,
      serviceMode: deps.serviceMode(),
      active: await isActive(state),
      droppedCount: state.droppedCount,
      lastPollAt: state.lastPollAt === null ? null : new Date(state.lastPollAt).toISOString(),
      lastPollError: state.lastPollError,
      recent: recent.map((row) => ({
        ...row,
        receivedAt: new Date(row.receivedAt).toISOString(),
        finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt).toISOString(),
      })),
    };
  }

  /** Reads and checks the factory config; a refusal names what is wrong (never a crash of the poller). */
  async function readConfig(state: SystemTopicState): Promise<{ config: SystemCommandsConfig } | Outcome> {
    if (!state.commandsPath) return { status: "refused", text: "refused: no commands.json path is set in the Manager's Settings" };
    let text: string | null;
    try {
      text = await deps.readConfigFile(state.commandsPath);
    } catch (error) {
      return { status: "refused", text: `refused: the commands config is not readable at ${state.commandsPath} (${error instanceof Error ? error.message : String(error)})` };
    }
    if (text === null) return { status: "refused", text: `refused: no commands config at ${state.commandsPath}` };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: "refused", text: `refused: the commands config at ${state.commandsPath} is not valid JSON` };
    }
    const parsed = systemCommandsConfigSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { status: "refused", text: `refused: the commands config does not match format 1 (${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid"})` };
    }
    return { config: parsed.data };
  }

  async function runStatus(state: SystemTopicState, channel: string | null): Promise<Outcome> {
    const loaded = await readConfig(state);
    if ("status" in loaded) return loaded;
    const { config } = loaded;
    let argv = [...config.status.argv];
    let cwd: string | undefined;
    if (channel !== null) {
      const entry = Object.prototype.hasOwnProperty.call(config.channels, channel) ? config.channels[channel] : undefined;
      if (!entry) return { status: "refused", text: `refused: unknown channel "${channel}" (known: ${Object.keys(config.channels).join(", ") || "none"})` };
      const workspace = await deps.channelWorkspacePath(entry.channelId);
      if (workspace === null) return { status: "refused", text: `refused (channel_root_mismatch): no workspace path is set for ${channel} on this computer` };
      const root = path.resolve(entry.root);
      if (path.resolve(workspace) !== root) return { status: "refused", text: `refused (channel_root_mismatch): the config's root for ${channel} is not its workspace path on this computer` };
      if (!config.status.channelArg) return { status: "refused", text: "refused: the commands config has no status.channelArg" };
      argv = [...argv, config.status.channelArg, channel];
      cwd = root;
    }
    for (const arg of argv) {
      if (!isRelativePath(arg)) continue;
      if (cwd === undefined) return { status: "refused", text: `refused: a relative path in status.argv needs a channel root (${arg})` };
      if (!inside(cwd, path.resolve(cwd, arg))) return { status: "refused", text: `refused: a path in status.argv leaves the channel root (${arg})` };
    }
    const result = await deps.runProcess(argv, { cwd, timeoutMs: SYSTEM_STATUS_TIMEOUT_MS });
    if (result.error !== null) return { status: "failed", text: `status could not start: ${result.error}` };
    const output = result.output.trim().length === 0 ? "(no output)" : cutStatusOutput(result.output);
    if (result.timedOut) return { status: "failed", text: `${output}\n(stopped after ${SYSTEM_STATUS_TIMEOUT_MS / 1000} s)` };
    if (result.exitCode !== 0) return { status: "failed", text: `${output}\n(exit code ${result.exitCode ?? "none"})` };
    return { status: "done", text: output };
  }

  async function execute(state: SystemTopicState, command: SystemCommand): Promise<Outcome> {
    switch (command.kind) {
      case "help":
        return { status: "done", text: SYSTEM_HELP_TEXT };
      case "status":
        return runStatus(state, command.channel);
      case "stop":
      case "go":
      case "approve":
      case "deny":
        return { status: "not_available", text: `${command.kind} is not available yet` };
      case "usage":
        return { status: "usage", text: `usage: ${SYSTEM_COMMAND_USAGE[command.command]}` };
      case "unknown":
        return { status: "unknown", text: "unknown command, see help" };
    }
  }

  /** True when the message is the owner's, in the configured chat and topic, with text (plan §2, AC-SYS-01/02). */
  function accepted(state: SystemTopicState, message: SystemInboxMessage): boolean {
    if (message.text === null || message.chatId === null || message.threadId === null || message.fromId === null) return false;
    return String(message.chatId) === state.chatId && String(message.threadId) === state.threadId && String(message.fromId) === state.ownerUserId;
  }

  return {
    view,

    /** The owner's settings. The switch may be turned on only under the Mac service and with the token and the three ids set. */
    async saveSettings(input: unknown): Promise<SystemTopicView> {
      const settings = parseWithSchema(systemTopicSettingsInputSchema, input, "System topic settings");
      if (settings.listening) {
        if (!deps.serviceMode()) {
          throw new DomainError({ code: "system_topic_needs_service", message: "Only the Mac's system service (YTOM_SERVICE_MODE=1) may listen to the System topic" });
        }
        if (settings.ownerUserId === null || settings.chatId === null || settings.threadId === null || !(await deps.token.hasToken())) {
          throw new DomainError({ code: "system_topic_incomplete", message: "Set the bot token, the owner's user id, the group id and the topic id before listening" });
        }
      }
      await deps.store.saveSettings(settings, deps.clock());
      log("system_topic.settings_saved", { listening: settings.listening });
      return view();
    },

    async setToken(input: unknown): Promise<SystemTopicView> {
      const { token } = parseWithSchema(systemTopicTokenInputSchema, input, "System topic bot token");
      await deps.token.write(token);
      log("system_topic.token_saved", {});
      return view();
    },

    async clearToken(): Promise<SystemTopicView> {
      await deps.token.clear();
      log("system_topic.token_cleared", {});
      return view();
    },

    /**
     * One receive from the configured inbound source. With the switch off, outside the service, without the token (the replies need
     * it), the ids or a source, nothing is asked of any source (AC-SYS-13). Order: claim each kept message's audit row (unique update
     * id: a message is never run twice), store the source's new cursor and the dropped count, then run the claimed commands one by one
     * and reply in the topic. `mayWrite` is asked after the (long) receive and before the first write: an import / migration that
     * started during the wait must not see these rows -- nothing is written and the cursor stays, so the source sends them again.
     */
    async tick(options: { signal?: AbortSignal; mayWrite?: () => Promise<boolean> } = {}): Promise<{ polled: boolean }> {
      const { signal } = options;
      const mayWrite = options.mayWrite ?? (async () => true);
      const state = await deps.store.read();
      if (!state.listening || !deps.serviceMode() || !settingsComplete(state)) return { polled: false };
      const inbox = inboxOf(state);
      if (!inbox) return { polled: false };
      const token = await deps.token.read();
      if (!token) return { polled: false };
      let received: { messages: SystemInboxMessage[]; nextCursor: number | null };
      try {
        received = await inbox.receive({ cursor: state.pollOffset, signal });
      } catch (error) {
        if (signal?.aborted) return { polled: false };
        const message = redactTelegramToken(error instanceof Error ? error.message : String(error), token);
        if (await mayWrite()) await deps.store.recordPoll({ offset: state.pollOffset, dropped: 0, at: deps.clock(), error: message });
        throw new Error(message);
      }
      if (!(await mayWrite())) return { polled: false };
      let dropped = 0;
      const claimed: Array<{ updateId: number; text: string; command: SystemCommand }> = [];
      for (const update of [...received.messages].sort((a, b) => a.updateId - b.updateId)) {
        if (!accepted(state, update)) {
          dropped += 1;
          continue;
        }
        const text = update.text!;
        const command = parseSystemCommand(text);
        const fresh = await deps.store.claimCommand({ updateId: update.updateId, fromUserId: state.ownerUserId!, text: text.slice(0, 4096), command: command.kind, receivedAt: deps.clock() });
        if (fresh) claimed.push({ updateId: update.updateId, text, command });
      }
      await deps.store.recordPoll({ offset: received.nextCursor, dropped, at: deps.clock(), error: null });
      if (dropped > 0) log("system_topic.dropped", { count: dropped });
      for (const item of claimed) {
        let outcome: Outcome;
        try {
          outcome = await execute(state, item.command);
        } catch (error) {
          outcome = { status: "failed", text: `failed: ${redactTelegramToken(error instanceof Error ? error.message : String(error), token)}` };
        }
        const reply = fitTelegramText(redactTelegramToken(outcome.text, token));
        let replyError: string | null = null;
        try {
          await deps.replies.sendMessage(token, { chatId: state.chatId!, threadId: Number(state.threadId), text: reply });
        } catch (error) {
          replyError = redactTelegramToken(error instanceof Error ? error.message : String(error), token);
        }
        await deps.store.finishCommand(item.updateId, { status: outcome.status, resultText: reply, replyError, finishedAt: deps.clock() });
        log("system_topic.command", { updateId: item.updateId, command: item.command.kind, status: outcome.status, replied: replyError === null });
      }
      return { polled: true };
    },
  };
}

export type SystemTopic = ReturnType<typeof createSystemTopic>;
