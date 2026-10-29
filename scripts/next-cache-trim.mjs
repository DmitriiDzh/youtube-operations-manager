// BL-237 (owner, Telegram 2026-10-30, msgs 3864-3866): a cap on Next.js's build cache. Turbopack's cache
// (.next/cache/turbopack) only grows -- it reached 16 GB on the Mac. Before a build, when `.next/cache` is larger than the
// limit (5 GB, or YTOM_NEXT_CACHE_LIMIT_GB) and turbopack alone is over half of it, `.next/cache/turbopack` is removed: the next build is slower once and the
// cache starts again. Nothing else in `.next` is touched. Called by `npm run build`'s prebuild step, so every build on every
// computer (the Mac's build-if-stale.sh, Windows start.bat/update.bat, a developer's build) gets it. Plain Node, no shell.
//
//   node scripts/next-cache-trim.mjs            trim when over the limit, print what was measured and done
//   node scripts/next-cache-trim.mjs --check    print the size only, change nothing
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The default limit for `.next/cache`, in GB (10^9 bytes). */
export const DEFAULT_NEXT_CACHE_LIMIT_GB = 5;
const GB = 1_000_000_000;

/** The limit in bytes from the environment: YTOM_NEXT_CACHE_LIMIT_GB when it is a positive number, otherwise 5 GB. */
export function nextCacheLimitBytes(env) {
  const raw = env.YTOM_NEXT_CACHE_LIMIT_GB;
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return (Number.isFinite(value) && value > 0 ? value : DEFAULT_NEXT_CACHE_LIMIT_GB) * GB;
}

/** The bytes under a folder (files only, links not followed); 0 when it does not exist. */
export async function folderBytes(dir) {
  let total = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) total += (await lstat(full).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

/**
 * Trims `<root>/.next/cache`: over `limitBytes` -> `.next/cache/turbopack` is removed, but only when turbopack is what fills
 * it (over half the limit by itself); otherwise removing it would not bring the cache under the limit and every build would
 * start cold for nothing, so it is kept and the log says what fills the cache. Returns what it measured and did.
 * `dryRun` measures only.
 * @param {{ root: string; limitBytes: number; dryRun?: boolean; log?: (line: string) => void }} options
 */
export async function trimNextCache({ root, limitBytes, dryRun = false, log = () => {} }) {
  const cacheDir = path.join(root, ".next", "cache");
  const turbopackDir = path.join(cacheDir, "turbopack");
  const bytes = await folderBytes(cacheDir);
  const gb = (n) => (n / GB).toFixed(2);
  if (bytes <= limitBytes) {
    log(`[next-cache] .next/cache is ${gb(bytes)} GB (limit ${gb(limitBytes)} GB): kept`);
    return { bytes, limitBytes, removed: false };
  }
  const turbopackBytes = await folderBytes(turbopackDir);
  if (turbopackBytes <= limitBytes / 2) {
    log(`[next-cache] .next/cache is ${gb(bytes)} GB, over the ${gb(limitBytes)} GB limit, but .next/cache/turbopack is only ${gb(turbopackBytes)} GB: kept (something else fills the cache)`);
    return { bytes, limitBytes, removed: false };
  }
  if (dryRun) {
    log(`[next-cache] .next/cache is ${gb(bytes)} GB (turbopack ${gb(turbopackBytes)} GB), over the ${gb(limitBytes)} GB limit (check only: nothing removed)`);
    return { bytes, limitBytes, removed: false };
  }
  await rm(turbopackDir, { recursive: true, force: true });
  log(`[next-cache] .next/cache was ${gb(bytes)} GB (turbopack ${gb(turbopackBytes)} GB), over the ${gb(limitBytes)} GB limit: removed .next/cache/turbopack (the next build rebuilds it)`);
  return { bytes, limitBytes, removed: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // No top-level await: the tests import this file through tsx, which compiles it as CommonJS.
  trimNextCache({ root, limitBytes: nextCacheLimitBytes(process.env), dryRun: process.argv.includes("--check"), log: (line) => console.log(line) }).catch((error) => {
    // Housekeeping: a failure never stops the build.
    console.warn(`[next-cache] not checked: ${error instanceof Error ? error.message : String(error)}`);
  });
}
