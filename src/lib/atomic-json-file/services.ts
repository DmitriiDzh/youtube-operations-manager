import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renameWithRetry } from "@/lib/rename-retry";

/**
 * Shared atomic-write-then-chmod-0600 implementation for small device-local JSON state files
 * (tmp-write -> chmod tmp -> rename -> chmod final). Previously duplicated verbatim between
 * `src/lib/cli-auth/storage.ts` and `src/lib/bootstrap-config/services.ts` (found by
 * independent review, AGENTS.md §D: one implementation per pattern, not two that could drift
 * independently -- e.g. a future Windows-rename-retry-on-EBUSY fix like the one already applied
 * in `src/lib/snapshot/adapters/filesystem.ts` for an analogous issue).
 */
export async function writeJsonFileAtomic(targetPath: string, data: unknown): Promise<void> {
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true });
  if (process.platform !== "win32") {
    try {
      await chmod(dir, 0o700);
    } catch {
      // Best effort on an already-existing directory.
    }
  }

  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  await writeFile(tmpPath, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: fsConstants.S_IRUSR | fsConstants.S_IWUSR,
  });
  if (process.platform !== "win32") {
    await chmod(tmpPath, 0o600);
  }

  // RISK-22 (docs/TECHNICAL_DEBT.md): retry on Windows EBUSY/EPERM rather than throwing
  // unhandled on every login/bootstrap-config save that races a transiently-held handle.
  await renameWithRetry(tmpPath, targetPath);

  if (process.platform !== "win32") {
    await chmod(targetPath, 0o600);
  }
}
