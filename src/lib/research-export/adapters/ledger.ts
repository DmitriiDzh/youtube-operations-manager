import { insertWorkspaceExportFile, listExpiredWorkspaceExportFiles, markWorkspaceExportFileDeleted } from "@/lib/db";
import type { LedgerFileRecord } from "../contracts";
import type { ResearchExportDeps } from "../services";

export function createResearchExportLedger(): ResearchExportDeps["ledger"] {
  return {
    insert: async (record) => insertWorkspaceExportFile(record),
    listExpired: async (now) =>
      (await listExpiredWorkspaceExportFiles(now)).map(
        (row): LedgerFileRecord => ({ ...row, dataset: row.dataset as LedgerFileRecord["dataset"], format: row.format as LedgerFileRecord["format"] })
      ),
    markDeleted: (id, at) => markWorkspaceExportFileDeleted(id, at),
  };
}
