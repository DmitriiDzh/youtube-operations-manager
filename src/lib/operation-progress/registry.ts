import { randomUUID } from "node:crypto";
import {
  OperationAlreadyRunningError,
  type OperationHandle,
  type OperationItemSnapshot,
  type OperationItemStatus,
  type OperationRunStatus,
  type OperationSnapshot,
  type StartOperationInput,
} from "./contracts";

type Entry = {
  snapshot: OperationSnapshot;
  cancelRequested: boolean;
  heartbeatAt: number;
};

export type OperationRegistryOptions = {
  now?: () => number;
  idGenerator?: () => string;
  /** A running operation that has not touched the registry for this long is treated as dead
   * (its process or loop is gone), so a crashed job can never keep an overlay open forever. */
  heartbeatTimeoutMs?: number;
  /** How long a finished operation stays readable (so a reloaded page can still see the result). */
  retainFinishedMs?: number;
};

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 3 * 60_000;
export const DEFAULT_RETAIN_FINISHED_MS = 10 * 60_000;

const FINAL_ITEM: ReadonlySet<OperationItemStatus> = new Set(["done", "failed", "skipped"]);
const ACTIVE: ReadonlySet<OperationRunStatus> = new Set(["running", "cancelling"]);

function countDone(items: OperationItemSnapshot[]): number {
  return items.filter((item) => FINAL_ITEM.has(item.status)).length;
}

export function createOperationRegistry(options: OperationRegistryOptions = {}) {
  const now = options.now ?? Date.now;
  const idGenerator = options.idGenerator ?? randomUUID;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const retainFinishedMs = options.retainFinishedMs ?? DEFAULT_RETAIN_FINISHED_MS;
  const entries = new Map<string, Entry>();

  /** Applies lazy expiry: dead heartbeats become `failed`, old finished entries disappear. */
  function sweep(): void {
    const t = now();
    for (const [id, entry] of entries) {
      const snap = entry.snapshot;
      if (ACTIVE.has(snap.status) && t - entry.heartbeatAt > heartbeatTimeoutMs) {
        entry.snapshot = {
          ...snap,
          status: "failed",
          stage: null,
          message: "Interrupted: the operation stopped reporting progress (the server may have restarted).",
          finishedAt: t,
          items: snap.items.map((item) =>
            FINAL_ITEM.has(item.status) ? item : { ...item, status: "skipped" as const }
          ),
        };
        entry.snapshot.done = countDone(entry.snapshot.items);
      } else if (!ACTIVE.has(snap.status) && snap.finishedAt !== null && t - snap.finishedAt > retainFinishedMs) {
        entries.delete(id);
      }
    }
  }

  function activeFor(channelId: string, kind: string): Entry | undefined {
    for (const entry of entries.values()) {
      if (entry.snapshot.channelId === channelId && entry.snapshot.kind === kind && ACTIVE.has(entry.snapshot.status)) {
        return entry;
      }
    }
    return undefined;
  }

  return {
    /** Registers an operation; throws `OperationAlreadyRunningError` if one of this kind is already
     * active for the channel (two concurrent runs of the same write job are never allowed). */
    start(input: StartOperationInput): OperationHandle {
      sweep();
      const running = activeFor(input.channelId, input.kind);
      if (running) throw new OperationAlreadyRunningError(input.kind, input.channelId, running.snapshot.id);

      const id = idGenerator();
      const t = now();
      const items: OperationItemSnapshot[] = input.items.map((item) => ({ id: item.id, label: item.label, status: "pending" }));
      const entry: Entry = {
        cancelRequested: false,
        heartbeatAt: t,
        snapshot: {
          id,
          kind: input.kind,
          channelId: input.channelId,
          title: input.title,
          status: "running",
          stage: null,
          items,
          done: 0,
          total: items.length,
          cancellable: input.cancellable,
          message: null,
          startedAt: t,
          finishedAt: null,
        },
      };
      entries.set(id, entry);

      const live = () => ACTIVE.has(entry.snapshot.status);
      return {
        id,
        setStage(stage) {
          if (!live()) return;
          entry.heartbeatAt = now();
          entry.snapshot = { ...entry.snapshot, stage };
        },
        setItem(itemId, status, detail) {
          if (!live()) return;
          entry.heartbeatAt = now();
          const nextItems = entry.snapshot.items.map((item) =>
            item.id === itemId ? { ...item, status, detail: detail ?? item.detail } : item
          );
          entry.snapshot = { ...entry.snapshot, items: nextItems, done: countDone(nextItems) };
        },
        isCancelRequested: () => entry.cancelRequested,
        touch() {
          if (live()) entry.heartbeatAt = now();
        },
        finish(result = {}) {
          if (!live()) return;
          const status: OperationRunStatus = result.error ? "failed" : entry.snapshot.status === "cancelling" ? "cancelled" : "success";
          entry.snapshot = { ...entry.snapshot, status, stage: null, message: result.message ?? null, finishedAt: now() };
        },
      };
    },

    get(id: string): OperationSnapshot | undefined {
      sweep();
      return entries.get(id)?.snapshot;
    },

    /** Operations of one channel, newest first; `activeOnly` hides finished ones. */
    list(filter: { channelId: string; kind?: string; activeOnly?: boolean }): OperationSnapshot[] {
      sweep();
      return [...entries.values()]
        .map((entry) => entry.snapshot)
        .filter(
          (snap) =>
            snap.channelId === filter.channelId &&
            (filter.kind === undefined || snap.kind === filter.kind) &&
            (!filter.activeOnly || ACTIVE.has(snap.status))
        )
        .sort((a, b) => b.startedAt - a.startedAt);
    },

    /** Asks a running, cancellable operation to stop before its next item. Returns whether the
     * request was accepted; a finished or non-cancellable operation is left untouched. */
    requestCancel(id: string): boolean {
      sweep();
      const entry = entries.get(id);
      if (!entry || entry.snapshot.status !== "running" || !entry.snapshot.cancellable) return false;
      entry.cancelRequested = true;
      entry.snapshot = { ...entry.snapshot, status: "cancelling" };
      return true;
    },
  };
}

export type OperationRegistry = ReturnType<typeof createOperationRegistry>;
