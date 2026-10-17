import { GEMINI_SHARED_LIMIT_FIELDS, type GeminiMediaSettings, type GeminiSharedLimitField } from "./contracts";

// BL-193 (owner, Telegram 2026-10-16, msg 2867: "да, общие"; ADR 0039): the Gemini limits, the same on every computer, through
// the sync-gateway `gemini-settings` document (the media-settings engine of ADR 0030 on its own document). The rules are ADR 0030's:
// the owner's save publishes only the fields it changed; a field the document lacks is seeded from this computer; a received value
// is applied through this module's own validation (`updateSettings`); a field set differently on two computers before they met is
// a conflict -- never applied, each computer keeps its own value until the owner picks one (a spend limit never changes by
// itself); a value this module calls invalid is held until the shared value changes. The switch (`enabled`) is NOT shared: it
// lets this computer's operator spend with this computer's key, and turning it on elsewhere must stay a decision made there.

/** A JSON value as the document stores it (the four limits are numbers). */
export type GeminiSharedValue = string | number | boolean | null | string[];

export type GeminiPendingSetting = { field: GeminiSharedLimitField; value: GeminiSharedValue; reason: string };
export type GeminiSettingsConflictView = { field: GeminiSharedLimitField; values: GeminiSharedValue[]; thisComputer: GeminiSharedValue };

export type GeminiSettingsSyncStatus = {
  checkedAt: string | null;
  lastApplied: { fields: GeminiSharedLimitField[]; at: string } | null;
  pending: GeminiPendingSetting[];
  conflicts: GeminiSettingsConflictView[];
  error: string | null;
};

export type GeminiSettingsSyncDeps = {
  shared: {
    read(): Promise<{ values: Record<string, GeminiSharedValue>; conflicts: Array<{ field: string; values: GeminiSharedValue[] }> }>;
    seedMissing(values: Record<string, GeminiSharedValue>): Promise<{ changed: string[] }>;
  };
  getSettings(): Promise<GeminiMediaSettings>;
  /** This module's own validated update -- without publishing back. */
  applyUpdate(patch: Record<string, unknown>): Promise<GeminiMediaSettings>;
  clock: { now(): Date };
};

const canonical = (value: unknown) => JSON.stringify(value ?? null);
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isShared = (field: string): field is GeminiSharedLimitField => (GEMINI_SHARED_LIMIT_FIELDS as readonly string[]).includes(field);

export function sharedLimitValues(settings: GeminiMediaSettings): Record<GeminiSharedLimitField, GeminiSharedValue> {
  const out = {} as Record<GeminiSharedLimitField, GeminiSharedValue>;
  for (const field of GEMINI_SHARED_LIMIT_FIELDS) out[field] = settings[field];
  return out;
}

/** The shared fields this save actually changed on this computer -- only those are published (an untouched conflicted one never is). */
export function changedSharedLimits(before: GeminiMediaSettings, after: GeminiMediaSettings): Partial<Record<GeminiSharedLimitField, GeminiSharedValue>> {
  const out: Partial<Record<GeminiSharedLimitField, GeminiSharedValue>> = {};
  for (const field of GEMINI_SHARED_LIMIT_FIELDS) if (canonical(before[field]) !== canonical(after[field])) out[field] = after[field];
  return out;
}

/** Which shared values to apply here: a conflicted field is held (owner's choice pending), an equal one needs nothing. */
export function planGeminiPeerApply(input: { local: GeminiMediaSettings; shared: Record<string, GeminiSharedValue>; conflicted: ReadonlySet<string> }): {
  patch: Partial<Record<GeminiSharedLimitField, GeminiSharedValue>>;
  held: GeminiPendingSetting[];
} {
  const patch: Partial<Record<GeminiSharedLimitField, GeminiSharedValue>> = {};
  const held: GeminiPendingSetting[] = [];
  for (const field of GEMINI_SHARED_LIMIT_FIELDS) {
    if (!Object.hasOwn(input.shared, field)) continue;
    const value = input.shared[field];
    if (canonical(input.local[field]) === canonical(value)) continue;
    if (input.conflicted.has(field)) {
      held.push({ field, value, reason: "set differently on the two computers: waiting for your choice" });
      continue;
    }
    patch[field] = value;
  }
  return { patch, held };
}

export function createGeminiSettingsSync(deps: GeminiSettingsSyncDeps) {
  let status: GeminiSettingsSyncStatus = { checkedAt: null, lastApplied: null, pending: [], conflicts: [], error: null };
  // A value this module called invalid is not retried until any shared value changes.
  const failed = new Map<string, { value: string; reason: string }>();
  let lastSharedSignature: string | null = null;

  // One at a time: a tick, an owner's save and a conflict choice never interleave (ADR 0030's safety rules).
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  function conflictViews(conflicts: Array<{ field: string; values: GeminiSharedValue[] }>, local: GeminiMediaSettings): GeminiSettingsConflictView[] {
    const values = sharedLimitValues(local);
    return conflicts.filter((c): c is { field: GeminiSharedLimitField; values: GeminiSharedValue[] } => isShared(c.field)).map((c) => ({ field: c.field, values: c.values, thisComputer: values[c.field] }));
  }

  /** The status from the document alone, applying nothing (a GET must not write). */
  async function peek(): Promise<GeminiSettingsSyncStatus> {
    const at = deps.clock.now().toISOString();
    try {
      const local = await deps.getSettings();
      const { values, conflicts } = await deps.shared.read();
      const { patch, held } = planGeminiPeerApply({ local, shared: values, conflicted: new Set(conflicts.map((c) => c.field)) });
      return {
        ...status,
        checkedAt: at,
        pending: [...held, ...Object.entries(patch).map(([field, value]) => ({ field: field as GeminiSharedLimitField, value: value as GeminiSharedValue, reason: failed.get(field)?.reason ?? "will be applied on the next check" }))],
        conflicts: conflictViews(conflicts, local),
        error: null,
      };
    } catch (error) {
      return { ...status, checkedAt: at, error: describe(error) };
    }
  }

  async function tick(): Promise<GeminiSettingsSyncStatus> {
    const at = deps.clock.now().toISOString();
    try {
      const local = await deps.getSettings();
      await deps.shared.seedMissing(sharedLimitValues(local));
      const { values, conflicts } = await deps.shared.read();
      const signature = canonical(values);
      if (signature !== lastSharedSignature) failed.clear();
      lastSharedSignature = signature;
      const { patch, held } = planGeminiPeerApply({ local, shared: values, conflicted: new Set(conflicts.map((c) => c.field)) });
      const pending: GeminiPendingSetting[] = [...held];
      const applied: GeminiSharedLimitField[] = [];
      // Each field on its own: one value this module refuses never holds back the others.
      for (const [field, value] of Object.entries(patch) as Array<[GeminiSharedLimitField, GeminiSharedValue]>) {
        const prior = failed.get(field);
        if (prior && prior.value === canonical(value)) {
          pending.push({ field, value, reason: prior.reason });
          continue;
        }
        try {
          await deps.applyUpdate({ [field]: value });
          applied.push(field);
          failed.delete(field);
        } catch (error) {
          // Only a value this module calls invalid is held until the shared value changes; anything else is retried next tick.
          const invalid = (error as { code?: string })?.code === "validation_failed";
          const reason = invalid ? `not applied: ${describe(error)}` : `not applied yet (retried): ${describe(error)}`;
          if (invalid) failed.set(field, { value: canonical(value), reason });
          pending.push({ field, value, reason });
        }
      }
      const now = await deps.getSettings();
      status = { checkedAt: at, lastApplied: applied.length > 0 ? { fields: applied, at } : status.lastApplied, pending, conflicts: conflictViews(conflicts, now), error: null };
    } catch (error) {
      status = { ...status, checkedAt: at, error: describe(error) };
    }
    return status;
  }

  return {
    /** Seed, read, and apply what can be applied (the Gemini settings loop). */
    tick: () => exclusive(tick),
    peek,
    status: () => status,
    /** Runs `fn` with no tick in between (an owner's save, a conflict choice). */
    exclusive,
  };
}

export type GeminiSettingsSync = ReturnType<typeof createGeminiSettingsSync>;
