// BL-220 (docs/roadmap/plans/RESTART_WHEN_IDLE_PLAN.md, ADR 0049; FO-REQ-0038): the server restarts itself once nobody works with
// it. Types and fixed values only -- no database, no process, no files.

/** How often the server checks an open request (plan: "every 15 s while a request is open"). */
export const RESTART_TICK_MS = 15_000;
/** A request still waiting after 24 h ends by itself (owner answer 3). */
export const RESTART_REQUEST_MAX_AGE_MS = 24 * 60 * 60_000;
/** «Тишина MCP перед перезапуском, мин»: 1-30, default 3 (AC-RI-08). */
export const RESTART_QUIET_MINUTES_DEFAULT = 3;
export const RESTART_QUIET_MINUTES_MIN = 1;
export const RESTART_QUIET_MINUTES_MAX = 30;
/** A hold lasts 1-60 minutes and needs a reason (AC-RI-03). */
export const RESTART_HOLD_MINUTES_MIN = 1;
export const RESTART_HOLD_MINUTES_MAX = 60;
export const RESTART_HOLD_REASON_MAX = 200;
/** The developer script's request file, in the app-data folder (the same trust as stop.sh: the OS user). */
export const RESTART_REQUEST_FILE_NAME = "restart-request.json";

export type RestartRequester = "owner" | "developer";
export type RestartRequestStatus = "open" | "restarting" | "done" | "cancelled" | "expired";
/** Who set a hold: the Factory Operator, a channel worker (`worker:<channelId>`) or the owner. */
export type RestartHoldOwner = "factory" | "owner" | `worker:${string}`;

/** Times are epoch milliseconds. */
export type RestartRequestRow = {
  id: string;
  status: RestartRequestStatus;
  requestedBy: RestartRequester;
  requestedAt: number;
  restartingAt: number | null;
  finishedAt: number | null;
  fromVersion: string | null;
  fromSchema: number | null;
  toVersion: string | null;
  toSchema: number | null;
  waitedMinutes: number | null;
};

export type RestartHoldRow = {
  id: string;
  heldBy: RestartHoldOwner;
  reason: string;
  createdAt: number;
  until: number;
  releasedAt: number | null;
  releasedBy: RestartHoldOwner | null;
};

/** One reason the restart must wait (AC-RI-01). `ids` names at most a few of the rows; `until` is when it ends by itself. */
export type RestartWaitingKind =
  | "media_session"
  | "media_job"
  | "gemini_job"
  | "upload"
  | "live_stream"
  | "operation_lock"
  | "operation"
  | "batch"
  | "hold"
  | "mcp_quiet"
  | "check_failed";
export type RestartWaitingReason = { kind: RestartWaitingKind; count: number; ids: string[]; until: string | null };

export type RestartRequestView = {
  id: string;
  status: RestartRequestStatus;
  requestedBy: RestartRequester;
  requestedAt: string;
  restartingAt: string | null;
  finishedAt: string | null;
  waitedMinutes: number | null;
  fromVersion: string | null;
  fromSchema: number | null;
  toVersion: string | null;
  toSchema: number | null;
};

export type RestartHoldView = {
  holdId: string;
  heldBy: RestartHoldOwner;
  reason: string;
  createdAt: string;
  until: string;
  releasedAt: string | null;
  releasedBy: RestartHoldOwner | null;
  active: boolean;
};

export type RestartStatus = {
  /** The open request (or the one restarting right now), else null. */
  request: RestartRequestView | null;
  /** Every reason a restart must wait right now -- empty means it would restart at the next check. */
  waitingFor: RestartWaitingReason[];
  holds: RestartHoldView[];
  /** The latest finished restart (status done), else null. */
  lastRestart: RestartRequestView | null;
  quietMinutes: number;
  /** Whether this server runs as the macOS system service -- only then can it restart itself. */
  serviceMode: boolean;
};

/** Each reader names the rows that keep the restart waiting; a reader that throws keeps it waiting too (`check_failed`). */
export type RestartBusyReaders = {
  /** Media sessions on this computer that are not finished. */
  mediaSessions(): Promise<string[]>;
  /** Media jobs queued, submitted, generating or transferring. */
  mediaJobs(): Promise<string[]>;
  /** Gemini jobs queued, submitting or running. */
  geminiJobs(): Promise<string[]>;
  /** Uploads being sent or finished (uploading, processing, finishing). */
  uploads(): Promise<string[]>;
  /** Live streams being started, stopped or switched (a running stream is not one). */
  liveStreams(): Promise<string[]>;
  /** The device operation lock's operation type, or null. */
  operationLock(): Promise<string | null>;
  /** In-process operations that are running (Fix all, syncs, ...), by label. */
  operations(): Promise<string[]>;
  /** Batches RUNNING. */
  batches(): Promise<string[]>;
  /** The last MCP tool call on this computer (epoch ms), or null. */
  lastMcpCallAt(): Promise<number | null>;
};

export type RestartStore = {
  /** Requests in the given states, oldest first. */
  listRequests(statuses: readonly RestartRequestStatus[]): Promise<RestartRequestRow[]>;
  insertRequest(row: RestartRequestRow): Promise<void>;
  /** Sets the fields only while the request is still in `expected`; false when it was not (someone else moved it). */
  updateRequest(id: string, expected: RestartRequestStatus, set: Partial<Omit<RestartRequestRow, "id">>): Promise<boolean>;
  /** The latest request in `done`, else null. */
  lastDone(): Promise<RestartRequestRow | null>;
  insertHold(row: RestartHoldRow): Promise<void>;
  getHold(id: string): Promise<RestartHoldRow | null>;
  /** Holds not released whose `until` is after `now`, oldest first. */
  listActiveHolds(now: number): Promise<RestartHoldRow[]>;
  /** Marks a hold released when it is not yet; false when it already was. */
  releaseHold(id: string, by: RestartHoldOwner, at: number): Promise<boolean>;
  getQuietMinutes(): Promise<number | null>;
  setQuietMinutes(minutes: number): Promise<void>;
};

export type RestartWhenIdleDependencies = {
  store: RestartStore;
  readers: RestartBusyReaders;
  clock: () => number;
  newId: () => string;
  /** `YTOM_SERVICE_MODE === "1"`: launchd starts the next run after the stop. */
  serviceMode: () => boolean;
  /** The running build: version (with its commit) and schema. */
  build: () => { version: string; schema: number };
  /** Sends this process the graceful stop (SIGTERM) -- called at most once per process. */
  stop: () => void;
  /** Takes the developer's request file: its text (the file is removed first), or null when there is none. */
  takeRequestFile: () => Promise<string | null>;
  log: (event: string, context: Record<string, unknown>) => void;
};
