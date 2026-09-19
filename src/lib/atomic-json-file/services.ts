import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
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

  // RISK-25's crash-vs-preexisting-data disambiguation (docs/TECHNICAL_DEBT.md) depends on this
  // write surviving a crash, not just a graceful process exit (which a plain writeFile already
  // survives, since the OS page cache outlives the process) -- `fsync` (via a real file handle,
  // not writeFile's own auto-closed one) forces the tmp file's content out of the OS page cache
  // before it is ever renamed into place (independent review, review series cycle 2).
  // Deliberately narrow, and *not* a full crash-safety guarantee on every platform: this is a
  // plain POSIX fsync(2), which never covers the directory entry the rename produces (full
  // rename crash-safety would also need an fsync of the directory -- disproportionate for a
  // single-operator local desktop app), and on macOS specifically, fsync(2) does not flush the
  // drive controller's own write cache the way `fcntl(F_FULLFSYNC)` does (Apple's own guidance;
  // Node has no built-in binding for it) -- a real power-loss event on macOS, this project's own
  // second supported platform, can still lose or tear this write. Reduces the original bug's
  // window (any interruption at all) to a narrower one (an actual power/OS-crash mid-write), not
  // to zero (independent review, review series cycle 3 -- corrects an earlier overclaim in this
  // same comment).
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  const handle = await open(tmpPath, "w", fsConstants.S_IRUSR | fsConstants.S_IWUSR);
  // A close() failure while the try block is *already* failing (e.g. EIO on the same underlying
  // fault that made sync() throw) must never replace that real error -- plain try/finally
  // semantics would otherwise let it silently do exactly that. But when writeFile()/sync() both
  // genuinely succeeded, a close() failure (a late EIO/ENOSPC flush error, or an unusual
  // filesystem that surfaces errors only on close) is itself a real fault the caller must learn
  // about -- swallowing it unconditionally would silently mask that and let this function
  // proceed to chmod/rename as if the write were safe (independent review, review series cycle
  // 4 -- cycle 3's own fix for the opposite masking problem overshot into this one).
  let writeSucceeded = false;
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
    await handle.sync();
    writeSucceeded = true;
  } finally {
    if (writeSucceeded) {
      await handle.close();
    } else {
      await handle.close().catch(() => {});
    }
  }
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
