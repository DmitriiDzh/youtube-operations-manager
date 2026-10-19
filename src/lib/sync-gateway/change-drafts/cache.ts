import { createHash } from "node:crypto";
import type { FieldConflict } from "./contracts";

/**
 * BL-203 (docs/roadmap/plans/FAST_NAVIGATION_PLAN.md §2 stage 1): what this process already computed from a given document's
 * bytes, so an unchanged document is not loaded again. `Automerge.load` of a real 0.7 MB draft document takes ~650 ms and blocks
 * the server thread, and the conflict poll (every 20 s per tab) and the sync cycle (every 60 s) used to repeat it on bytes that
 * had not changed.
 *
 * Every key is the sha256 of the document bytes (or a pair of them), so an entry can never be stale: the same bytes are the same
 * document. Only `projectedCleanly` depends on something outside the bytes (the SQL projection), which is why it is recorded only
 * after a save whose projection reported no failure, and why one cache belongs to one projection target (production: one per
 * process, `index.ts`; tests: one per core unless shared on purpose).
 */
export type ChangeDraftsCache = {
  conflicts: BoundedMap<FieldConflict[]>;
  savedBytes: BoundedMap<Uint8Array>;
  /** Local document hashes whose whole SQL projection last succeeded with no failed row. */
  projectedCleanly: BoundedMap<true>;
  /** `${localHash}:${incomingHash}` pairs where the local document already contains the incoming one. */
  containsIncoming: BoundedMap<true>;
};

export function hashDocumentBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A Map that forgets its oldest entry beyond `limit` (insertion order, refreshed on read). */
export class BoundedMap<V> {
  private readonly entries = new Map<string, V>();
  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}

export function createChangeDraftsCache(): ChangeDraftsCache {
  return {
    conflicts: new BoundedMap(32),
    // Whole documents (~0.7 MB each): enough for every channel of a normal device, not more.
    savedBytes: new BoundedMap(8),
    projectedCleanly: new BoundedMap(32),
    containsIncoming: new BoundedMap(64),
  };
}
