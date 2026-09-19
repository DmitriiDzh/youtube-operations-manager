// Minimal structural type for "something SQL-executable" -- deliberately not importing
// @libsql/client's Client type here so this stays a leaf module with zero coupling to
// src/lib/db.ts (mirrors src/lib/batches/ledger-state.ts's "zero imports" pattern, which
// RISK-10 in docs/TECHNICAL_DEBT.md exists specifically to keep working).
export type SqlExecutor = {
  execute(query: string | { sql: string; args?: unknown[] }): Promise<unknown>;
};

export class DatabaseBackupError extends Error {
  code: "backup_destination_exists" | "backup_source_unavailable";

  constructor(code: DatabaseBackupError["code"], message: string) {
    super(message);
    this.name = "DatabaseBackupError";
    this.code = code;
  }
}
