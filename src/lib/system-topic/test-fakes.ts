import type { SystemApprovalAction, SystemRequestFiles, SystemRequestRow, SystemRequestStore } from "./approvals";
import { createSystemApprovals } from "./approvals";
import type { SystemCommandRow, SystemInboundMessage, SystemTopicState, SystemTopicStore } from "./contracts";
import { createSystemTopic } from "./services";

// BL-228: in-memory fakes for the System topic's tests (no database, no network, no file system). Not a test file itself, so the
// test runner does not pick it up; nothing in production imports it.

export const OWNER = 331110302;
export const CHAT = -1001234567890;
export const TOPIC = 42;
export const DIR = "/Volumes/T9/YouTube/00 YT Operator/System/requests";
export const T0 = Date.parse("2026-10-27T10:00:00.000Z");

export function memoryStore(initial: Partial<SystemTopicState> = {}): SystemTopicStore & { state: SystemTopicState; rows: Map<number, SystemCommandRow>; outbox: Array<{ id: string; text: string; createdAt: number; deliveredAt: number | null }> } {
  const state: SystemTopicState = {
    ownerUserId: String(OWNER),
    chatId: String(CHAT),
    threadId: String(TOPIC),
    enabled: true,
    requestsPath: DIR,
    relaySecretHash: null,
    relaySecretCreatedAt: null,
    droppedCount: 0,
    lastInboundAt: null,
    lastOutboxAt: null,
    lastScanAt: null,
    lastScanError: null,
    updatedAt: null,
    ...initial,
  };
  const rows = new Map<number, SystemCommandRow>();
  const outbox: Array<{ id: string; text: string; createdAt: number; deliveredAt: number | null }> = [];
  return {
    state,
    rows,
    outbox,
    async read() {
      return { ...state };
    },
    async saveSettings(settings, at) {
      Object.assign(state, settings, { updatedAt: at });
    },
    async setRelaySecretHash(hash, at) {
      state.relaySecretHash = hash;
      state.relaySecretCreatedAt = at;
    },
    async recordInbound({ dropped, at }) {
      state.droppedCount += dropped;
      state.lastInboundAt = at;
    },
    async recordScan({ at, error }) {
      state.lastScanAt = at;
      state.lastScanError = error;
    },
    async claimCommand(row) {
      if (rows.has(row.updateId)) return false;
      rows.set(row.updateId, { ...row, status: "received", resultText: null, finishedAt: null });
      return true;
    },
    async finishCommand(updateId, patch) {
      const row = rows.get(updateId);
      if (row) rows.set(updateId, { ...row, ...patch });
    },
    async recentCommands(limit) {
      return [...rows.values()].sort((a, b) => b.receivedAt - a.receivedAt || b.updateId - a.updateId).slice(0, limit);
    },
    async enqueueOutbox(row) {
      outbox.push({ ...row, deliveredAt: null });
    },
    async takeOutbox(at, limit) {
      const out = outbox.filter((m) => m.deliveredAt === null).slice(0, limit);
      for (const m of out) m.deliveredAt = at;
      state.lastOutboxAt = at;
      return out.map(({ id, text }) => ({ id, text }));
    },
  };
}

export function memoryRequestStore(): SystemRequestStore & { rows: Map<string, SystemRequestRow> } {
  const rows = new Map<string, SystemRequestRow>();
  return {
    rows,
    async get(id) {
      return rows.get(id) ?? null;
    },
    async insert(row) {
      if (rows.has(row.id)) return false;
      rows.set(row.id, { ...row });
      return true;
    },
    async transition(id, from, patch) {
      const row = rows.get(id);
      if (!row || !from.includes(row.state)) return false;
      rows.set(id, { ...row, ...patch });
      return true;
    },
    async listByStates(states) {
      return [...rows.values()].filter((r) => states.includes(r.state));
    },
    async recent(limit) {
      return [...rows.values()].sort((a, b) => b.seenAt - a.seenAt).slice(0, limit);
    },
  };
}

export function memoryFiles(): SystemRequestFiles & { files: Map<string, string>; results: Map<string, Record<string, unknown>> } {
  const files = new Map<string, string>();
  const results = new Map<string, Record<string, unknown>>();
  return {
    files,
    results,
    async list() {
      return [...files.keys(), ...[...results.keys()].map((id) => `${id}.result.json`)];
    },
    async read(_dir, name) {
      return files.get(name) ?? null;
    },
    async writeResult(_dir, id, text) {
      results.set(id, JSON.parse(text) as Record<string, unknown>);
    },
  };
}

export function inbound(updateId: number, text: string, overrides: { from?: number; chat?: number; thread?: number | null } = {}): SystemInboundMessage {
  return { updateId, messageId: updateId, chatId: overrides.chat ?? CHAT, threadId: overrides.thread === undefined ? TOPIC : overrides.thread, fromId: overrides.from ?? OWNER, date: null, text };
}

/** An allowlisted action whose estimate, refusal and run are set by the test; every run is recorded. */
export function fakeAction(options: { estimateUsd?: number | null; refusal?: string | null; capUsd?: number; fail?: string } = {}) {
  const runs: Array<{ args: Record<string, unknown>; actor: string }> = [];
  const action: SystemApprovalAction = {
    capUsd: options.capUsd ?? 2,
    parse: (args) => (args && typeof args === "object" && typeof (args as Record<string, unknown>).maxMinutes === "number" ? { ok: true, args: args as Record<string, unknown> } : { ok: false, error: "maxMinutes is required" }),
    check: async () => ({ estimateUsd: options.estimateUsd === undefined ? 1.5 : options.estimateUsd, refusal: options.refusal ?? null }),
    run: async (args, actor) => {
      runs.push({ args, actor });
      return options.fail ? { ok: false, error: options.fail } : { ok: true, result: { sessionId: "s-1" } };
    },
    summary: (args) => `${String(args.maxMinutes)} min`,
  };
  return { action, runs };
}

export function requestFile(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 1,
    id,
    createdAt: new Date(T0).toISOString(),
    requestedBy: "operator",
    action: "factory_media_start_session",
    args: { channelId: "UCa2amtpeOmgP-HkiLKPm1gg", maxMinutes: 60, maxUsd: 2, releaseWhenDone: true },
    costEstimateUsd: 1.2,
    reason: "render V52",
    ...overrides,
  });
}

/** The whole module on fakes: the topic core with its approvals, a clock the test moves. */
export function harness(options: { state?: Partial<SystemTopicState>; service?: boolean; action?: ReturnType<typeof fakeAction>; processStartedAt?: number; hash?: (text: string) => string } = {}) {
  const store = memoryStore(options.state);
  const requests = memoryRequestStore();
  const files = memoryFiles();
  const action = options.action ?? fakeAction();
  const clock = { now: T0 + 60_000 };
  const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
  let ids = 0;
  const approvals = createSystemApprovals({
    store: requests,
    files,
    actions: { factory_media_start_session: action.action },
    readState: () => store.read(),
    serviceMode: () => options.service ?? true,
    enqueue: (text) => store.enqueueOutbox({ id: `o${++ids}`, text, createdAt: clock.now }),
    clock: () => clock.now,
    processStartedAt: options.processStartedAt ?? T0 + 30 * 60_000,
    ...(options.hash ? { hash: options.hash } : {}),
    log: (event, context) => logs.push({ event, context }),
  });
  const topic = createSystemTopic({
    store,
    serviceMode: () => options.service ?? true,
    clock: () => clock.now,
    newId: () => `o${++ids}`,
    randomBytes: () => Buffer.alloc(32, ++ids),
    approvals: approvals.commands,
    log: (event, context) => logs.push({ event, context }),
  });
  const outboxTexts = () => store.outbox.map((m) => m.text);
  return { store, requests, files, action, clock, logs, approvals, topic, outboxTexts };
}
