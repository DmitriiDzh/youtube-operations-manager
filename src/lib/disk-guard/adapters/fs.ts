import { lstat, readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import type { DiskVolume } from "../contracts";

// BL-237: the disk guard's file-system reads -- statfs of the app's places, and a bounded size walk of a folder.

/** The volumes of the given places, one entry per volume (places on the same volume share it). Throws when one cannot be read. */
export async function readVolumes(places: ReadonlyArray<{ label: DiskVolume["labels"][number]; path: string }>): Promise<DiskVolume[]> {
  const byDevice = new Map<string, DiskVolume>();
  for (const place of places) {
    const [info, own] = await Promise.all([statfs(place.path), stat(place.path)]);
    const key = String(own.dev);
    const existing = byDevice.get(key);
    if (existing) {
      if (!existing.labels.includes(place.label)) existing.labels.push(place.label);
      continue;
    }
    byDevice.set(key, {
      labels: [place.label],
      path: place.path,
      freeBytes: Number(info.bavail) * Number(info.bsize),
      totalBytes: Number(info.blocks) * Number(info.bsize),
    });
  }
  return [...byDevice.values()];
}

/**
 * The bytes of the files under `dir` (links are not followed, unreadable entries are skipped), stopping at `budgetMs`:
 * `complete: false` then, and `bytes` is what was counted so far (a lower bound). A missing folder is 0, complete.
 */
export async function folderSize(dir: string, options: { budgetMs: number; now?: () => number }): Promise<{ bytes: number; complete: boolean }> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.budgetMs;
  let bytes = 0;
  const pending = [dir];
  while (pending.length > 0) {
    if (now() > deadline) return { bytes, complete: false };
    const current = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) files.push(full);
    }
    // In small groups: quick, without flooding the thread pool the server's other work shares.
    for (let i = 0; i < files.length; i += 64) {
      const sizes = await Promise.all(files.slice(i, i + 64).map((file) => lstat(file).then((s) => s.size, () => 0)));
      for (const size of sizes) bytes += size;
      if (now() > deadline) return { bytes, complete: false };
    }
  }
  return { bytes, complete: true };
}
