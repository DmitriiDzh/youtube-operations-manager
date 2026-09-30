import { createHash } from "node:crypto";
import type { SqlExecutor } from "../contracts";
import { SNAPSHOT_REPLACE_ON_IMPORT_TABLES } from "../contracts";

type ExecuteResult = { rows: Array<Record<string, unknown>>; columns?: string[] };

function encodeValue(value: unknown): string {
  if (value === null || value === undefined) return "n";
  if (typeof value === "number") return `d${Number.isInteger(value) ? value.toString() : value.toPrecision(17)}`;
  if (typeof value === "bigint") return `d${value.toString()}`;
  if (typeof value === "string") return `s${value.length}:${value}`;
  if (value instanceof ArrayBuffer) return `b${Buffer.from(value).toString("hex")}`;
  if (ArrayBuffer.isView(value)) return `b${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")}`;
  return `u${String(value)}`;
}

/**
 * Automatic device sync (docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md §2): a deterministic SHA-256
 * over the CONTENT of every table a snapshot import replaces (`schema_meta` excluded). Columns are
 * taken in name order and rows sorted by every column, so the value depends only on the data --
 * never on physical column order (RISK-29) or rowids, which an import renumbers.
 *
 * `schema` names an attached database ("main" for the live one); a table missing there hashes as
 * absent, distinct from empty. The value is only ever compared against one this same device
 * recorded, so it never has to agree across builds or machines.
 */
export async function computeContentFingerprint(client: SqlExecutor, schema = "main"): Promise<string> {
  const hash = createHash("sha256");
  hash.update("ytom-content-fingerprint-v1\n");
  const tables = [...SNAPSHOT_REPLACE_ON_IMPORT_TABLES].sort();
  for (const table of tables) {
    const info = (await client.execute(`PRAGMA "${schema}".table_info("${table}")`)) as ExecuteResult;
    const columns = info.rows.map((row) => String(row.name)).sort();
    if (columns.length === 0) {
      hash.update(`T${table}:absent\n`);
      continue;
    }
    hash.update(`T${table}:${columns.join(",")}\n`);
    const columnList = columns.map((c) => `"${c}"`).join(", ");
    const result = (await client.execute(
      `SELECT ${columnList} FROM "${schema}"."${table}" ORDER BY ${columns.map((_, i) => i + 1).join(", ")}`
    )) as ExecuteResult;
    for (const row of result.rows) {
      hash.update(columns.map((c) => encodeValue(row[c])).join("|"));
      hash.update("\n");
    }
  }
  return hash.digest("hex");
}

/** True iff every table a snapshot import replaces is empty (or absent). */
export async function transferredTablesAreEmpty(client: SqlExecutor): Promise<boolean> {
  for (const table of SNAPSHOT_REPLACE_ON_IMPORT_TABLES) {
    const info = (await client.execute(`PRAGMA table_info("${table}")`)) as ExecuteResult;
    if (info.rows.length === 0) continue;
    const result = (await client.execute(`SELECT 1 FROM "${table}" LIMIT 1`)) as ExecuteResult;
    if (result.rows.length > 0) return false;
  }
  return true;
}

/** The fingerprint of a standalone database file (a scrubbed export copy), computed through
 * `ATTACH` on the caller's already-open connection -- the same reason `scrubDatabaseCopy` attaches
 * rather than opening a second client (a Windows EBUSY race on the following rename). */
export async function computeFileContentFingerprint(client: SqlExecutor, dbPath: string): Promise<string> {
  await client.execute({ sql: "ATTACH DATABASE ? AS fingerprint_target", args: [dbPath] });
  try {
    return await computeContentFingerprint(client, "fingerprint_target");
  } finally {
    await client.execute("DETACH DATABASE fingerprint_target");
  }
}
