import { ELEVENLABS_SHARED_LIMIT_FIELDS, type ElevenlabsSettings, type ElevenlabsSharedLimitField } from "./contracts";

// BL-236 (owner, Telegram 2026-10-29, msg 3823: "как у других API, чтобы лимиты и расход был общий на все компьютеры"; ADR 0057): the
// ElevenLabs character limits, the same on every computer, through the sync-gateway `elevenlabs-settings` document -- exactly the
// Gemini limits' rules (ADR 0039 on ADR 0030's engine): a save publishes only the fields it changed; a field the document lacks is
// seeded from this computer (so values saved before sharing migrate on the first tick); a received value is applied through this
// module's own validation; a field set differently on two computers before they met is a conflict, held until the owner picks one.
// NOT shared: the switch (`enabled`, a decision made on each computer) and the output format (this computer's plan choice).
/** A JSON value as the document stores it (the four character limits are numbers). */
export type ElevenlabsSharedValue = string | number | boolean | null | string[];

export type ElevenlabsPendingSetting = { field: ElevenlabsSharedLimitField; value: ElevenlabsSharedValue; reason: string };
export type ElevenlabsSettingsConflictView = { field: ElevenlabsSharedLimitField; values: ElevenlabsSharedValue[]; thisComputer: ElevenlabsSharedValue };

export type ElevenlabsSettingsSyncStatus = {
  checkedAt: string | null;
  lastApplied: { fields: ElevenlabsSharedLimitField[]; at: string } | null;
  pending: ElevenlabsPendingSetting[];
  conflicts: ElevenlabsSettingsConflictView[];
  error: string | null;
};

export type ElevenlabsSettingsSyncDeps = {
  shared: {
    read(): Promise<{ values: Record<string, ElevenlabsSharedValue>; conflicts: Array<{ field: string; values: ElevenlabsSharedValue[] }> }>;
    seedMissing(values: Record<string, ElevenlabsSharedValue>): Promise<{ changed: string[] }>;
  };
  getSettings(): Promise<ElevenlabsSettings>;
  /** This module's own validated update -- without publishing back. */
  applyUpdate(patch: Record<string, unknown>): Promise<ElevenlabsSettings>;
  clock: { now(): Date };
};

const canonical = (value: unknown) => JSON.stringify(value ?? null);
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isShared = (field: string): field is ElevenlabsSharedLimitField => (ELEVENLABS_SHARED_LIMIT_FIELDS as readonly string[]).includes(field);

export function sharedLimitValues(settings: ElevenlabsSettings): Record<ElevenlabsSharedLimitField, ElevenlabsSharedValue> {
  const out = {} as Record<ElevenlabsSharedLimitField, ElevenlabsSharedValue>;
  for (const field of ELEVENLABS_SHARED_LIMIT_FIELDS) out[field] = settings[field];
  return out;
}

/** The shared fields this save actually changed on this computer -- only those are published (an untouched conflicted one never is). */
export function changedSharedLimits(before: ElevenlabsSettings, after: ElevenlabsSettings): Partial<Record<ElevenlabsSharedLimitField, ElevenlabsSharedValue>> {
  const out: Partial<Record<ElevenlabsSharedLimitField, ElevenlabsSharedValue>> = {};
  for (const field of ELEVENLABS_SHARED_LIMIT_FIELDS) if (canonical(before[field]) !== canonical(after[field])) out[field] = after[field];
  return out;
}

/** Which shared values to apply here: a conflicted field is held (owner's choice pending), an equal one needs nothing. */
export function planElevenlabsPeerApply(input: { local: ElevenlabsSettings; shared: Record<string, ElevenlabsSharedValue>; conflicted: ReadonlySet<string> }): {
  patch: Partial<Record<ElevenlabsSharedLimitField, ElevenlabsSharedValue>>;
  held: ElevenlabsPendingSetting[];
} {
  const patch: Partial<Record<ElevenlabsSharedLimitField, ElevenlabsSharedValue>> = {};
  const held: ElevenlabsPendingSetting[] = [];
  for (const field of ELEVENLABS_SHARED_LIMIT_FIELDS) {
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

export function createElevenlabsSettingsSync(deps: ElevenlabsSettingsSyncDeps) {
  let status: ElevenlabsSettingsSyncStatus = { checkedAt: null, lastApplied: null, pending: [], conflicts: [], error: null };
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

  function conflictViews(conflicts: Array<{ field: string; values: ElevenlabsSharedValue[] }>, local: ElevenlabsSettings): ElevenlabsSettingsConflictView[] {
    const values = sharedLimitValues(local);
    return conflicts.filter((c): c is { field: ElevenlabsSharedLimitField; values: ElevenlabsSharedValue[] } => isShared(c.field)).map((c) => ({ field: c.field, values: c.values, thisComputer: values[c.field] }));
  }

  /** The status from the document alone, applying nothing (a GET must not write). */
  async function peek(): Promise<ElevenlabsSettingsSyncStatus> {
    const at = deps.clock.now().toISOString();
    try {
      const local = await deps.getSettings();
      const { values, conflicts } = await deps.shared.read();
      const { patch, held } = planElevenlabsPeerApply({ local, shared: values, conflicted: new Set(conflicts.map((c) => c.field)) });
      return {
        ...status,
        checkedAt: at,
        pending: [...held, ...Object.entries(patch).map(([field, value]) => ({ field: field as ElevenlabsSharedLimitField, value: value as ElevenlabsSharedValue, reason: failed.get(field)?.reason ?? "will be applied on the next check" }))],
        conflicts: conflictViews(conflicts, local),
        error: null,
      };
    } catch (error) {
      return { ...status, checkedAt: at, error: describe(error) };
    }
  }

  async function tick(): Promise<ElevenlabsSettingsSyncStatus> {
    const at = deps.clock.now().toISOString();
    try {
      const local = await deps.getSettings();
      await deps.shared.seedMissing(sharedLimitValues(local));
      const { values, conflicts } = await deps.shared.read();
      const signature = canonical(values);
      if (signature !== lastSharedSignature) failed.clear();
      lastSharedSignature = signature;
      const { patch, held } = planElevenlabsPeerApply({ local, shared: values, conflicted: new Set(conflicts.map((c) => c.field)) });
      const pending: ElevenlabsPendingSetting[] = [...held];
      const applied: ElevenlabsSharedLimitField[] = [];
      // Each field on its own: one value this module refuses never holds back the others.
      for (const [field, value] of Object.entries(patch) as Array<[ElevenlabsSharedLimitField, ElevenlabsSharedValue]>) {
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
    /** Seed, read, and apply what can be applied (the ElevenLabs settings loop). */
    tick: () => exclusive(tick),
    peek,
    status: () => status,
    /** Runs `fn` with no tick in between (an owner's save, a conflict choice). */
    exclusive,
  };
}

export type ElevenlabsSettingsSync = ReturnType<typeof createElevenlabsSettingsSync>;
