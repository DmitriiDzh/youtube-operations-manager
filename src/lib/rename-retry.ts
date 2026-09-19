import { rename } from "node:fs/promises";

/**
 * `rename()` with retry-on-EBUSY/EPERM (Windows only in practice): a file written moments
 * earlier by a just-closed handle (a SQLite connection, another process's own write) can
 * briefly still hold an OS-level lock even after `close()`/the writer returns -- native handle
 * release is not perfectly synchronous. Retrying a plain rename rather than failing outright
 * closes that narrow race. Single shared implementation (RISK-22, docs/TECHNICAL_DEBT.md) --
 * previously only applied in `src/lib/snapshot/adapters/filesystem.ts`'s `publishSnapshot`;
 * `src/lib/atomic-json-file/services.ts`'s own doc comment already named this exact gap.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  // Injectable only for tests -- a real EBUSY/EPERM race is Windows-specific and not
  // deterministically reproducible cross-platform; every real caller uses the default.
  renameFn: (from: string, to: string) => Promise<void> = rename
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await renameFn(from, to);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}
