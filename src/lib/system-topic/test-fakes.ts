import type { TelegramUpdate } from "@/lib/telegram-bot-gateway";
import type { ProcessResult, SystemCommandRow, SystemTopicDeps, SystemTopicState, SystemTopicStore } from "./contracts";

// BL-228: in-memory fakes for the System topic's tests (no database, no network, no child process). Not a test file itself, so the
// test runner does not pick it up; nothing in production imports it.

export const OWNER = 331110302;
export const CHAT = -1001234567890;
export const TOPIC = 42;
export const TOKEN = "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ";
export const TROPICO_ID = "UCa2amtpeOmgP-HkiLKPm1gg";
export const TROPICO_ROOT = "/Volumes/T9/YouTube/01 Tropico Jazz";
export const CONFIG_PATH = "/Volumes/T9/YouTube/00 YT Operator/System/commands.json";
export const STATUS_ARGV = ["python3", "/Volumes/T9/YouTube/00 YT Operator/90 Scripts/factory_status.py"];

export const CONFIG = {
  format: 1,
  channels: { tropico: { channelId: TROPICO_ID, root: TROPICO_ROOT } },
  status: { argv: STATUS_ARGV, channelArg: "--channel" },
  go: { argv: ["python3", "06 Workflows/factory_launch.py", "start", "13 Weekly_Plan v1", "run"], cwd: "channelRoot" },
  stopFile: "06 Workflows/_data/weekly-plan/STOP",
  jobsDir: "06 Workflows/_data/jobs",
};

export function memoryStore(initial: Partial<SystemTopicState> = {}): SystemTopicStore & { state: SystemTopicState; rows: Map<number, SystemCommandRow> } {
  const state: SystemTopicState = {
    ownerUserId: String(OWNER),
    chatId: String(CHAT),
    threadId: String(TOPIC),
    listening: true,
    commandsPath: CONFIG_PATH,
    pollOffset: null,
    droppedCount: 0,
    lastPollAt: null,
    lastPollError: null,
    updatedAt: null,
    ...initial,
  };
  const rows = new Map<number, SystemCommandRow>();
  return {
    state,
    rows,
    async read() {
      return { ...state };
    },
    async saveSettings(settings, at) {
      Object.assign(state, settings, { updatedAt: at });
    },
    async recordPoll(input) {
      state.pollOffset = input.offset;
      state.droppedCount += input.dropped;
      state.lastPollAt = input.at;
      state.lastPollError = input.error;
    },
    async claimCommand(row) {
      if (rows.has(row.updateId)) return false;
      rows.set(row.updateId, { ...row, status: "received", resultText: null, replyError: null, finishedAt: null });
      return true;
    },
    async finishCommand(updateId, patch) {
      const row = rows.get(updateId);
      if (row) rows.set(updateId, { ...row, ...patch });
    },
    async recentCommands(limit) {
      return [...rows.values()].sort((a, b) => b.receivedAt - a.receivedAt || b.updateId - a.updateId).slice(0, limit);
    },
  };
}

export function message(updateId: number, text: string, overrides: { from?: number; chat?: number; thread?: number | null } = {}): TelegramUpdate {
  return {
    updateId,
    message: {
      messageId: updateId,
      chatId: overrides.chat ?? CHAT,
      threadId: overrides.thread === undefined ? TOPIC : overrides.thread,
      from: { id: overrides.from ?? OWNER, isBot: false, username: null },
      text,
    },
  };
}

export type Harness = {
  deps: SystemTopicDeps;
  store: ReturnType<typeof memoryStore>;
  getUpdatesCalls: Array<{ offset: number | null }>;
  sent: Array<{ chatId: string; threadId: number | null; text: string }>;
  runs: Array<{ argv: readonly string[]; cwd: string | undefined; timeoutMs: number }>;
  logs: Array<{ event: string; context: Record<string, unknown> }>;
  /** Updates the next getUpdates returns (each call takes the next batch; an Error is thrown). */
  batches: Array<TelegramUpdate[] | Error>;
};

export function harness(options: {
  state?: Partial<SystemTopicState>;
  token?: string | null;
  service?: boolean;
  config?: unknown;
  workspace?: string | null;
  result?: ProcessResult;
} = {}): Harness {
  const store = memoryStore(options.state);
  let token = options.token === undefined ? TOKEN : options.token;
  const h: Harness = { store, getUpdatesCalls: [], sent: [], runs: [], logs: [], batches: [], deps: undefined as unknown as SystemTopicDeps };
  let now = Date.parse("2026-10-27T10:00:00.000Z");
  h.deps = {
    store,
    telegram: {
      async getUpdates(_token, input) {
        h.getUpdatesCalls.push({ offset: input.offset });
        const next = h.batches.shift() ?? [];
        if (next instanceof Error) throw next;
        return next;
      },
      async sendMessage(_token, input) {
        h.sent.push(input);
        return { messageId: 1 };
      },
    },
    token: {
      read: async () => token,
      hasToken: async () => token !== null,
      botId: async () => (token ? token.split(":")[0] : null),
      write: async (value) => {
        token = value;
      },
      clear: async () => {
        token = null;
      },
    },
    readConfigFile: async () => (options.config === undefined ? JSON.stringify(CONFIG) : options.config === null ? null : typeof options.config === "string" ? options.config : JSON.stringify(options.config)),
    channelWorkspacePath: async (channelId) => (channelId === TROPICO_ID ? (options.workspace === undefined ? TROPICO_ROOT : options.workspace) : null),
    runProcess: async (argv, opts) => {
      h.runs.push({ argv, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
      return options.result ?? { output: "all good\n", exitCode: 0, timedOut: false, error: null };
    },
    serviceMode: () => options.service ?? true,
    clock: () => (now += 1000),
    log: (event, context) => h.logs.push({ event, context }),
  };
  return h;
}
