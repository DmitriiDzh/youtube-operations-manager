/**
 * Server-side registry of long-running operations (ADR 0015): what is running right now, how far it
 * got, and whether the operator asked it to stop. In memory only -- it describes work this server
 * process is doing, so it is meaningless after a restart (a restart kills the work too). It holds
 * counters, labels and error text only: never tokens, credentials or video content.
 */
export type OperationRunStatus = "running" | "cancelling" | "success" | "failed" | "cancelled";

export type OperationItemStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type OperationItemSnapshot = {
  id: string;
  label: string;
  status: OperationItemStatus;
  detail?: string;
};

export type OperationSnapshot = {
  id: string;
  kind: string;
  channelId: string;
  title: string;
  status: OperationRunStatus;
  stage: string | null;
  items: OperationItemSnapshot[];
  /** Items in a final state (done / failed / skipped). */
  done: number;
  total: number;
  cancellable: boolean;
  message: string | null;
  startedAt: number;
  finishedAt: number | null;
};

/** What the code running the operation holds. Every call also counts as a heartbeat. */
export type OperationHandle = {
  readonly id: string;
  setStage(stage: string | null): void;
  setItem(itemId: string, status: OperationItemStatus, detail?: string): void;
  /** Cooperative cancel: check BEFORE starting each item, never mid-request. */
  isCancelRequested(): boolean;
  touch(): void;
  finish(result?: { error?: boolean; message?: string | null }): void;
};

export type StartOperationInput = {
  kind: string;
  channelId: string;
  title: string;
  items: Array<{ id: string; label: string }>;
  cancellable: boolean;
};

/** Matches by `code` so it still works when a dev hot reload gave the class two identities. */
export function isOperationAlreadyRunning(error: unknown): error is OperationAlreadyRunningError {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "operation_already_running";
}

/** Thrown by `start` when an operation of the same kind is already running for the channel. */
export class OperationAlreadyRunningError extends Error {
  readonly code = "operation_already_running";
  constructor(
    readonly kind: string,
    readonly channelId: string,
    readonly operationId: string
  ) {
    super(`An operation of kind "${kind}" is already running for this channel`);
    this.name = "OperationAlreadyRunningError";
  }
}
