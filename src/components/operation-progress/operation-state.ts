/**
 * Pure state machine behind the shared "operation in progress" overlay (owner instruction,
 * 2026-10-03: long YouTube writes / syncs must show that work is running). No React and no
 * fetching here so the transitions are unit-testable; `use-operation.ts` and
 * `operation-overlay.tsx` are thin wrappers around it.
 *
 * Lifecycle: idle -> running -> (cancelling ->) success | failed | cancelled -> idle (`reset`).
 */
export type OperationItemStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type OperationItem = {
  id: string;
  label: string;
  status: OperationItemStatus;
  detail?: string;
};

export type OperationStatus = "idle" | "running" | "cancelling" | "success" | "failed" | "cancelled";

export type QuotaServiceKey = "dataApi" | "analytics";

/** One Google API quota pool as last reported by Cloud Monitoring. `baseline` is the usage seen when
 * the operation began, so `used - baseline` is what this operation (plus anything else running
 * meanwhile) spent. */
export type OperationQuota = { service: QuotaServiceKey; used: number; limit: number; baseline: number };

/** The subset of the server registry snapshot (`src/lib/operation-progress`) the overlay mirrors. */
export type ServerOperationSnapshot = {
  title: string;
  status: "running" | "cancelling" | "success" | "failed" | "cancelled";
  stage: string | null;
  items: OperationItem[];
  cancellable: boolean;
  message: string | null;
  startedAt: number;
  finishedAt: number | null;
};

export type OperationState = {
  status: OperationStatus;
  title: string;
  stage: string | null;
  /** Items that reached a final state (done/failed/skipped). */
  done: number;
  total: number;
  items: OperationItem[];
  /** Whether the caller can honour a cancel request (it must stop BETWEEN items, never mid-write). */
  cancellable: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  message: string | null;
  quotas: OperationQuota[];
};

export const IDLE_OPERATION: OperationState = {
  status: "idle",
  title: "",
  stage: null,
  done: 0,
  total: 0,
  items: [],
  cancellable: false,
  startedAt: null,
  finishedAt: null,
  message: null,
  quotas: [],
};

export type OperationAction =
  | { type: "start"; title: string; items?: OperationItem[]; total?: number; cancellable?: boolean; now: number }
  | { type: "stage"; stage: string | null }
  | { type: "item"; id: string; status: OperationItemStatus; detail?: string }
  | { type: "setItems"; items: OperationItem[] }
  | { type: "counts"; done: number; total: number }
  | { type: "quota"; service: QuotaServiceKey; used: number; limit: number }
  | { type: "sync"; snapshot: ServerOperationSnapshot }
  | { type: "requestCancel" }
  | { type: "finish"; message?: string | null; error?: boolean; outcome?: "success" | "cancelled"; now: number }
  | { type: "reset" };

const FINAL_ITEM_STATUSES: ReadonlySet<OperationItemStatus> = new Set(["done", "failed", "skipped"]);

export function isOperationActive(state: OperationState): boolean {
  return state.status === "running" || state.status === "cancelling";
}

function countDone(items: OperationItem[]): number {
  return items.filter((item) => FINAL_ITEM_STATUSES.has(item.status)).length;
}

export function operationReducer(state: OperationState, action: OperationAction): OperationState {
  switch (action.type) {
    case "start": {
      const items = action.items ?? [];
      return {
        ...IDLE_OPERATION,
        status: "running",
        title: action.title,
        items,
        total: action.total ?? items.length,
        done: countDone(items),
        cancellable: action.cancellable ?? false,
        startedAt: action.now,
      };
    }
    case "stage":
      return isOperationActive(state) ? { ...state, stage: action.stage } : state;
    case "item": {
      if (!isOperationActive(state)) return state;
      const items = state.items.map((item) =>
        item.id === action.id ? { ...item, status: action.status, detail: action.detail ?? item.detail } : item
      );
      return { ...state, items, done: countDone(items) };
    }
    case "setItems": {
      if (!isOperationActive(state)) return state;
      return { ...state, items: action.items, total: action.items.length, done: countDone(action.items) };
    }
    case "counts": {
      if (!isOperationActive(state)) return state;
      const total = Math.max(0, action.total);
      return { ...state, total, done: Math.min(Math.max(0, action.done), total) };
    }
    case "quota": {
      // Accepted until reset (also after finish): the last reading after the work ends is the
      // most accurate one, since Cloud Monitoring reports usage with a short delay.
      if (state.status === "idle" || action.limit <= 0 || action.used < 0) return state;
      const existing = state.quotas.find((q) => q.service === action.service);
      const entry: OperationQuota = existing
        ? { ...existing, used: action.used, limit: action.limit }
        : { service: action.service, used: action.used, limit: action.limit, baseline: action.used };
      return {
        ...state,
        quotas: existing ? state.quotas.map((q) => (q.service === action.service ? entry : q)) : [...state.quotas, entry],
      };
    }
    case "sync": {
      // Server-driven operation: the registry is the source of truth, mirror it. Ignored once the
      // overlay was closed (idle), so a poll still in flight cannot reopen it.
      if (state.status === "idle") return state;
      const s = action.snapshot;
      return {
        ...state,
        title: s.title,
        status: s.status,
        stage: s.stage,
        items: s.items,
        total: s.items.length,
        done: countDone(s.items),
        cancellable: s.cancellable,
        message: s.message,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
      };
    }
    case "requestCancel":
      return state.status === "running" && state.cancellable ? { ...state, status: "cancelling" } : state;
    case "finish": {
      if (!isOperationActive(state)) return state;
      // `outcome` lets a caller that KNOWS the result override the guess: a cancel request that arrived
      // too late (the work finished anyway) must end as success, not as "cancelled".
      const status: OperationStatus = action.error
        ? "failed"
        : action.outcome ?? (state.status === "cancelling" ? "cancelled" : "success");
      return { ...state, status, finishedAt: action.now, message: action.message ?? null, stage: null };
    }
    case "reset":
      return IDLE_OPERATION;
  }
}
