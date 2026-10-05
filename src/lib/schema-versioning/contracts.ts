import type { SqlExecutor } from "@/lib/db-backup/contracts";

export type { SqlExecutor };

export class SchemaVersionError extends Error {
  code: "schema_version_unsupported";
  details: { foundVersion: number; supportedVersion: number };

  constructor(details: { foundVersion: number; supportedVersion: number }) {
    super(
      `Database schema version ${details.foundVersion} is newer than this build supports ` +
        `(supported: ${details.supportedVersion}). Refusing to open it. Update the application ` +
        `before opening this database, or restore an older backup.`
    );
    this.name = "SchemaVersionError";
    this.code = "schema_version_unsupported";
    this.details = details;
  }
}

export type SchemaMigration = {
  /** Strictly increasing, no gaps required but no duplicates. */
  version: number;
  description: string;
  apply: (client: SqlExecutor) => Promise<void>;
};
