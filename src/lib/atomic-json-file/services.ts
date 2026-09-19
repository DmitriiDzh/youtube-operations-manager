import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rm, type FileHandle } from "node:fs/promises";
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
 *
 * `openFn` is injectable only for tests (default: the real `open`) -- review series cycles 2-4
 * repeatedly found and re-found bugs in the write/sync/close sequence below with no test able to
 * exercise a close()-after-success failure, because nothing let a test substitute a handle whose
 * `close()` throws; this seam closes that gap (review series cycle 5).
 */
export async function writeJsonFileAtomic(
  targetPath: string,
  data: unknown,
  openFn: (path: string, flags: string, mode: number) => Promise<FileHandle> = open
): Promise<void> {
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
  try {
    // RISK-25's crash-vs-preexisting-data disambiguation (docs/TECHNICAL_DEBT.md) depends on
    // this write surviving a crash, not just a graceful process exit (which a plain writeFile
    // already survives, since the OS page cache outlives the process) -- `fsync` (via a real
    // file handle, not writeFile's own auto-closed one) forces the tmp file's content out of
    // the OS page cache before it is ever renamed into place (independent review, review
    // series cycle 2). Deliberately narrow, and *not* a full crash-safety guarantee on every
    // platform: this is a plain POSIX fsync(2), which never covers the directory entry the
    // rename produces (full rename crash-safety would also need an fsync of the directory --
    // disproportionate for a single-operator local desktop app), and on macOS specifically,
    // fsync(2) does not flush the drive controller's own write cache the way
    // `fcntl(F_FULLFSYNC)` does (Apple's own guidance; Node has no built-in binding for it) --
    // a real power-loss event on macOS, this project's own second supported platform, can
    // still lose or tear this write. Reduces the original bug's window (any interruption at
    // all) to a narrower one (an actual power/OS-crash mid-write), not to zero (review series
    // cycle 3 -- corrects an earlier overclaim in this same comment).
    const handle = await openFn(tmpPath, "w", fsConstants.S_IRUSR | fsConstants.S_IWUSR);
    try {
      await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
      await handle.sync();
    } catch (error) {
      // The write/sync itself failed -- a close() failure on top must never replace that real
      // error (review series cycle 3).
      await handle.close().catch(() => {});
      throw error;
    }
    // write/sync genuinely succeeded here: a close() failure now (a late EIO/ENOSPC flush
    // error, or a filesystem that only surfaces errors on close) is itself a real fault the
    // caller must learn about, not silently swallowed (review series cycle 4 -- cycle 3's own
    // fix for the case above had overshot into masking this one too). Written as catch-and-
    // rethrow rather than a mutable "did it succeed" flag so a future edit cannot forget to
    // keep a flag in sync with the code it's tracking (review series cycle 5).
    await handle.close();

    if (process.platform !== "win32") {
      await chmod(tmpPath, 0o600);
    }

    // RISK-22 (docs/TECHNICAL_DEBT.md): retry on Windows EBUSY/EPERM rather than throwing
    // unhandled on every login/bootstrap-config save that races a transiently-held handle.
    await renameWithRetry(tmpPath, targetPath);
  } catch (error) {
    // Any failure above (write, sync, close, chmod, or a rename that exhausts its own
    // retries) leaves an orphaned tmp file behind unless removed here -- previously left to
    // accumulate as disk debris on every one of those paths, not a data-safety issue by
    // itself, but real cleanup review series cycle 5 found missing (a no-op if the rename
    // already succeeded and moved it, or if it was never created).
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  if (process.platform !== "win32") {
    await chmod(targetPath, 0o600);
  }
}
