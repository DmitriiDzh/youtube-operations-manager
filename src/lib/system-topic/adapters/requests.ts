import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@libsql/client";
import type { SystemRequestFiles, SystemRequestRow, SystemRequestState, SystemRequestStore } from "../approvals";
import { SYSTEM_REQUEST_ID_PATTERN } from "../parser";

// BL-228: the paid-call requests (`system_topic_requests`, schema v111) and the factory's requests folder. The folder is read; the
// only file written there is `<id>.result.json`, through a temporary file in the same folder and a rename.

type Row = Record<string, unknown>;
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

const COLUMNS: Record<keyof SystemRequestRow, string> = {
  id: "id",
  action: "action",
  argsJson: "args_json",
  hash: "hash",
  createdAt: "created_at",
  requestedBy: "requested_by",
  reason: "reason",
  agentEstimateUsd: "agent_estimate_usd",
  estimateUsd: "estimate_usd",
  state: "state",
  refusal: "refusal",
  seenAt: "seen_at",
  approvedAt: "approved_at",
  confirmedAt: "confirmed_at",
  finishedAt: "finished_at",
  resultJson: "result_json",
};

function fromRow(row: Row): SystemRequestRow {
  return {
    id: String(row.id),
    action: str(row.action),
    argsJson: str(row.args_json),
    hash: str(row.hash),
    createdAt: num(row.created_at),
    requestedBy: str(row.requested_by),
    reason: str(row.reason),
    agentEstimateUsd: num(row.agent_estimate_usd),
    estimateUsd: num(row.estimate_usd),
    state: String(row.state) as SystemRequestState,
    refusal: str(row.refusal),
    seenAt: Number(row.seen_at),
    approvedAt: num(row.approved_at),
    confirmedAt: num(row.confirmed_at),
    finishedAt: num(row.finished_at),
    resultJson: str(row.result_json),
  };
}

export function createSystemRequestStore(client: Client): SystemRequestStore {
  const rows = async (sql: string, args: Array<string | number | null>) => ((await client.execute({ sql, args })).rows as unknown as Row[]).map(fromRow);
  return {
    async get(id) {
      return (await rows("SELECT * FROM system_topic_requests WHERE id = ?", [id]))[0] ?? null;
    },
    async insert(row) {
      const keys = Object.keys(COLUMNS) as Array<keyof SystemRequestRow>;
      const result = await client.execute({
        sql: `INSERT OR IGNORE INTO system_topic_requests (${keys.map((k) => COLUMNS[k]).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
        args: keys.map((k) => row[k] as string | number | null),
      });
      return result.rowsAffected > 0;
    },
    async transition(id, from, patch) {
      const entries = Object.entries(patch) as Array<[keyof SystemRequestRow, string | number | null]>;
      if (entries.length === 0 || from.length === 0) return false;
      const result = await client.execute({
        sql: `UPDATE system_topic_requests SET ${entries.map(([key]) => `${COLUMNS[key]} = ?`).join(", ")} WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})`,
        args: [...entries.map(([, value]) => value), id, ...from],
      });
      return result.rowsAffected === 1;
    },
    async listByStates(states) {
      if (states.length === 0) return [];
      return rows(`SELECT * FROM system_topic_requests WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY seen_at, id`, [...states]);
    },
    async recent(limit) {
      return rows("SELECT * FROM system_topic_requests ORDER BY seen_at DESC, id DESC LIMIT ?", [limit]);
    },
  };
}

/** A name is used only after it passed the id pattern (plus its fixed extension): it can never leave the folder. */
function fileIn(dir: string, name: string): string {
  const stem = name.endsWith(".result.json") ? name.slice(0, -".result.json".length) : name.endsWith(".json") ? name.slice(0, -".json".length) : null;
  if (stem === null || !SYSTEM_REQUEST_ID_PATTERN.test(stem)) throw new Error(`not a request file name: ${name}`);
  return path.join(dir, name);
}

export const systemRequestFiles: SystemRequestFiles = {
  async list(dir) {
    try {
      return await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async read(dir, name) {
    try {
      return await readFile(fileIn(dir, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async writeResult(dir, id, text) {
    const target = fileIn(dir, `${id}.result.json`);
    const temp = path.join(dir, `.${id}.result.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, text, "utf8");
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  },
};
