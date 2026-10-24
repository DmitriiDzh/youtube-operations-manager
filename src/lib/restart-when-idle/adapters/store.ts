import type { Client } from "@libsql/client";
import { MEDIA_SESSION_NON_TERMINAL_STATUSES } from "@/lib/media-generation/contracts";
import { GEMINI_ACTIVE_STATUSES } from "@/lib/gemini-media/contracts";
import type { RestartHoldOwner, RestartHoldRow, RestartRequestRow, RestartRequestStatus, RestartStore } from "../contracts";

// BL-220: the restart requests and holds (SCHEMA_MIGRATIONS v108) and the read-only checks of the other modules' device-local tables
// (AC-RI-01). Plain SQL on the shared client -- the same reads stop.sh's `operation-lock media-idle` makes; nothing here writes
// another module's rows.

type Row = Record<string, unknown>;
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function requestFromRow(row: Row): RestartRequestRow {
  return {
    id: String(row.id),
    status: String(row.status) as RestartRequestStatus,
    requestedBy: String(row.requested_by) === "developer" ? "developer" : "owner",
    requestedAt: Number(row.requested_at),
    restartingAt: num(row.restarting_at),
    finishedAt: num(row.finished_at),
    fromVersion: str(row.from_version),
    fromSchema: num(row.from_schema),
    toVersion: str(row.to_version),
    toSchema: num(row.to_schema),
    waitedMinutes: num(row.waited_minutes),
  };
}

function holdFromRow(row: Row): RestartHoldRow {
  return {
    id: String(row.id),
    heldBy: String(row.held_by) as RestartHoldOwner,
    reason: String(row.reason),
    createdAt: Number(row.created_at),
    until: Number(row.until_at),
    releasedAt: num(row.released_at),
    releasedBy: str(row.released_by) as RestartHoldOwner | null,
  };
}

const REQUEST_COLUMNS: Record<keyof Omit<RestartRequestRow, "id">, string> = {
  status: "status",
  requestedBy: "requested_by",
  requestedAt: "requested_at",
  restartingAt: "restarting_at",
  finishedAt: "finished_at",
  fromVersion: "from_version",
  fromSchema: "from_schema",
  toVersion: "to_version",
  toSchema: "to_schema",
  waitedMinutes: "waited_minutes",
};

export function createRestartStore(client: Client, settings: { get(): Promise<number | null>; set(minutes: number): Promise<void> }): RestartStore {
  const rows = async (sql: string, args: Array<string | number | null> = []) => (await client.execute({ sql, args })).rows as unknown as Row[];
  return {
    async listRequests(statuses) {
      if (statuses.length === 0) return [];
      return (await rows(`SELECT * FROM restart_requests WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY requested_at, id`, [...statuses])).map(requestFromRow);
    },
    async insertRequest(row) {
      await client.execute({
        sql: "INSERT INTO restart_requests (id, status, requested_by, requested_at, restarting_at, finished_at, from_version, from_schema, to_version, to_schema, waited_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [row.id, row.status, row.requestedBy, row.requestedAt, row.restartingAt, row.finishedAt, row.fromVersion, row.fromSchema, row.toVersion, row.toSchema, row.waitedMinutes],
      });
    },
    async updateRequest(id, expected, set) {
      const entries = Object.entries(set) as Array<[keyof typeof REQUEST_COLUMNS, string | number | null]>;
      if (entries.length === 0) return false;
      const result = await client.execute({
        sql: `UPDATE restart_requests SET ${entries.map(([key]) => `${REQUEST_COLUMNS[key]} = ?`).join(", ")} WHERE id = ? AND status = ?`,
        args: [...entries.map(([, value]) => value), id, expected],
      });
      return result.rowsAffected > 0;
    },
    async lastDone() {
      const [row] = await rows("SELECT * FROM restart_requests WHERE status = 'done' ORDER BY finished_at DESC, id DESC LIMIT 1");
      return row ? requestFromRow(row) : null;
    },
    async insertHold(row) {
      await client.execute({
        sql: "INSERT INTO restart_holds (id, held_by, reason, created_at, until_at, released_at, released_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [row.id, row.heldBy, row.reason, row.createdAt, row.until, row.releasedAt, row.releasedBy],
      });
    },
    async getHold(id) {
      const [row] = await rows("SELECT * FROM restart_holds WHERE id = ?", [id]);
      return row ? holdFromRow(row) : null;
    },
    async listActiveHolds(now) {
      return (await rows("SELECT * FROM restart_holds WHERE released_at IS NULL AND until_at > ? ORDER BY created_at, id", [now])).map(holdFromRow);
    },
    async releaseHold(id, by, at) {
      const result = await client.execute({ sql: "UPDATE restart_holds SET released_at = ?, released_by = ? WHERE id = ? AND released_at IS NULL", args: [at, by, id] });
      return result.rowsAffected > 0;
    },
    getQuietMinutes: () => settings.get(),
    setQuietMinutes: (minutes) => settings.set(minutes),
  };
}

const MEDIA_JOB_BUSY_STATUSES = ["queued", "submitted", "generating", "transferring"] as const;
const UPLOAD_BUSY_STATUSES = ["uploading", "processing", "finishing"] as const;

/** The table reads of AC-RI-01 (a missing table counts as none -- a database from before that module). */
export function createTableReaders(client: Client) {
  const ids = async (sql: string, args: readonly string[]): Promise<string[]> => {
    try {
      return ((await client.execute({ sql, args: [...args] })).rows as unknown as Row[]).map((row) => String(row.id));
    } catch (error) {
      if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return [];
      throw error;
    }
  };
  const marks = (values: readonly string[]) => values.map(() => "?").join(", ");
  return {
    mediaSessions: () => ids(`SELECT id FROM media_sessions WHERE status IN (${marks(MEDIA_SESSION_NON_TERMINAL_STATUSES)}) ORDER BY created_at`, MEDIA_SESSION_NON_TERMINAL_STATUSES),
    mediaJobs: () => ids(`SELECT id FROM media_jobs WHERE status IN (${marks(MEDIA_JOB_BUSY_STATUSES)}) ORDER BY created_at`, MEDIA_JOB_BUSY_STATUSES),
    geminiJobs: () => ids(`SELECT job_id AS id FROM gemini_media_jobs WHERE status IN (${marks(GEMINI_ACTIVE_STATUSES)}) ORDER BY created_at`, GEMINI_ACTIVE_STATUSES),
    uploads: () => ids(`SELECT id FROM publishing_uploads WHERE status IN (${marks(UPLOAD_BUSY_STATUSES)}) ORDER BY created_at`, UPLOAD_BUSY_STATUSES),
    batches: () => ids("SELECT id FROM batches WHERE status = 'RUNNING' ORDER BY id", []),
    /** `gateway_call_events.occurred_at` is unix seconds. */
    async lastMcpCallAt(): Promise<number | null> {
      const [row] = (await client.execute({ sql: "SELECT MAX(occurred_at) AS last FROM gateway_call_events WHERE category = 'mcp_tool_calls'", args: [] })).rows as unknown as Row[];
      const last = num(row?.last);
      return last === null ? null : last * 1000;
    },
  };
}
