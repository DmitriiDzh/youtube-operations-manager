import type { MediaSettingConflict, MediaSettingValue } from "@/lib/sync-gateway";
import type { MediaSettings } from "./contracts";

// BL-150 (owner, Telegram 2026-10-07, msgs 2008/2011; docs/roadmap/plans/PRODUCTION_SETTINGS_SYNC_PLAN.md): the Production → Setup
// settings shared through the sync-gateway `media-settings` document. This module decides which shared values this device
// applies, and applies them through Production's own `updateSettings` (the same validation as an edit in Setup). The document
// itself is an opaque map; the field list and every rule live here.

/** Every Setup field is shared except the price, which the receiving device reads from RunPod's catalog with the GPU. */
export const SHARED_SETTING_FIELDS = [
  "datacenterId",
  "gpuTypeId",
  "cloudType",
  "networkVolumeId",
  "templateId",
  "maxUsdPerDay",
  "defaultMaxMinutes",
  "idleMinutes",
  "watchIntervalSeconds",
  "maxConcurrentSessions",
  "gpuFallbackIds",
  "gpuMinVramGb",
  "gpuMaxPricePerHr",
  "capacityRetrySeconds",
  "capacityWaitMinutes",
  "factorySessionsEnabled",
  "factoryMaxUsdPerSession",
  "factoryMaxMinutesPerSession",
  "factoryMaxUsdPerDay",
  "factoryMaxUsdPerMonth",
  "ownerReleaseWhenDone",
] as const satisfies readonly (keyof MediaSettings)[];
export type SharedSettingField = (typeof SHARED_SETTING_FIELDS)[number];

/** IDs that exist only inside one RunPod account: applied only when both devices report the same account (AC-MS-04). */
export const ACCOUNT_BOUND_FIELDS: readonly SharedSettingField[] = ["networkVolumeId", "datacenterId", "templateId"];

const canonical = (value: unknown) => JSON.stringify(value ?? null);

export function sharedValuesOf(settings: MediaSettings): Record<SharedSettingField, MediaSettingValue> {
  const out = {} as Record<SharedSettingField, MediaSettingValue>;
  for (const field of SHARED_SETTING_FIELDS) {
    const value = settings[field];
    out[field] = Array.isArray(value) ? [...value] : (value as MediaSettingValue);
  }
  return out;
}

/** The fields this save actually changed on this device -- only those are published (an untouched conflicted field never is). */
export function changedSharedFields(before: MediaSettings, after: MediaSettings): Partial<Record<SharedSettingField, MediaSettingValue>> {
  const out: Partial<Record<SharedSettingField, MediaSettingValue>> = {};
  const values = sharedValuesOf(after);
  for (const field of SHARED_SETTING_FIELDS) if (canonical(before[field]) !== canonical(after[field])) out[field] = values[field];
  return out;
}

export type PendingSetting = { field: SharedSettingField; value: MediaSettingValue; reason: string };

/**
 * Which shared values to apply here. A conflicted field is never applied -- each device keeps its own value until the owner
 * picks one (owner msg 2011, option a: a spend limit never changes by itself). An account-bound field needs the same account.
 */
export function planPeerApply(input: {
  local: MediaSettings;
  shared: Record<string, MediaSettingValue>;
  conflicted: ReadonlySet<string>;
  sameAccount: boolean;
}): { patch: Partial<Record<SharedSettingField, MediaSettingValue>>; held: PendingSetting[] } {
  const patch: Partial<Record<SharedSettingField, MediaSettingValue>> = {};
  const held: PendingSetting[] = [];
  for (const field of SHARED_SETTING_FIELDS) {
    if (!(field in input.shared)) continue;
    const value = input.shared[field];
    if (canonical(input.local[field]) === canonical(value)) continue;
    if (input.conflicted.has(field)) {
      held.push({ field, value, reason: "set differently on the two computers: waiting for your choice" });
      continue;
    }
    if (ACCOUNT_BOUND_FIELDS.includes(field) && !input.sameAccount) {
      held.push({ field, value, reason: "the other computer uses another (or an unknown) RunPod account" });
      continue;
    }
    patch[field] = value;
  }
  return { patch, held };
}

export type SettingsConflictView = { field: SharedSettingField; values: MediaSettingValue[]; thisComputer: MediaSettingValue };

export type SettingsSyncStatus = {
  checkedAt: string | null;
  /** Fields applied from the other computer on the last tick that changed something. */
  lastApplied: { fields: SharedSettingField[]; at: string } | null;
  /** Shared values not applied here, with why (invalid, volume in use, another account, conflict). */
  pending: PendingSetting[];
  conflicts: SettingsConflictView[];
  error: string | null;
};

export type SettingsSyncDeps = {
  shared: {
    read(): Promise<{ values: Record<string, MediaSettingValue>; conflicts: MediaSettingConflict[] }>;
    seedMissing(values: Record<string, MediaSettingValue>): Promise<{ changed: string[] }>;
  };
  getSettings(): Promise<MediaSettings>;
  /** Production's own validated update (catalog checks, volume guard) -- without publishing back. */
  applyUpdate(patch: Record<string, unknown>): Promise<MediaSettings>;
  sameAccount(): Promise<boolean>;
  record(event: { action: string; subject: string; details: Record<string, unknown> }): Promise<void>;
  clock: { now(): Date };
};

const isVolumeBusy = (error: unknown) => (error as { code?: string })?.code === "media_session_conflict";
/** Only a value Production itself calls invalid is held until it changes; anything else (RunPod unreachable, no keys yet) is retried. */
const isInvalidValue = (error: unknown) => (error as { code?: string })?.code === "media_settings_invalid";
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createSettingsSync(deps: SettingsSyncDeps) {
  let status: SettingsSyncStatus = { checkedAt: null, lastApplied: null, pending: [], conflicts: [], error: null };
  // A value Production called invalid is not retried until any shared value changes (each retry may cost RunPod catalog reads;
  // a coupled change -- datacenter and volume -- can become valid when its partner arrives).
  const failed = new Map<string, { value: string; reason: string }>();
  let lastSharedSignature: string | null = null;

  // One at a time (independent review): a tick, an owner's save in Setup and a conflict choice never interleave -- two ticks
  // would apply twice (double RunPod reads, double audit rows), and a tick between a save's read and write could undo it.
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  /** The status from the document alone, applying nothing (for a GET: a read must not write, review). */
  async function peek(): Promise<SettingsSyncStatus> {
    const at = deps.clock.now().toISOString();
    try {
      const local = await deps.getSettings();
      const { values, conflicts } = await deps.shared.read();
      const { patch, held } = planPeerApply({ local, shared: values, conflicted: new Set(conflicts.map((c) => c.field)), sameAccount: await deps.sameAccount() });
      const nowValues = sharedValuesOf(local);
      return {
        ...status,
        checkedAt: at,
        pending: [...held, ...Object.entries(patch).map(([field, value]) => ({ field: field as SharedSettingField, value: value as MediaSettingValue, reason: failed.get(field)?.reason ?? "will be applied on the next check" }))],
        conflicts: conflicts
          .filter((c): c is MediaSettingConflict & { field: SharedSettingField } => (SHARED_SETTING_FIELDS as readonly string[]).includes(c.field))
          .map((c) => ({ field: c.field, values: c.values, thisComputer: nowValues[c.field] })),
        error: null,
      };
    } catch (error) {
      return { ...status, checkedAt: at, error: describe(error) };
    }
  }

  async function tick(): Promise<SettingsSyncStatus> {
    const at = deps.clock.now().toISOString();
    try {
      const local = await deps.getSettings();
      // The first sync (or a field a newer build added): this device's values for what the document does not have yet.
      await deps.shared.seedMissing(sharedValuesOf(local));
      const { values, conflicts } = await deps.shared.read();
      const signature = canonical(values);
      if (signature !== lastSharedSignature) failed.clear();
      lastSharedSignature = signature;
      const conflicted = new Set(conflicts.map((c) => c.field));
      const { patch, held } = planPeerApply({ local, shared: values, conflicted, sameAccount: await deps.sameAccount() });
      const pending: PendingSetting[] = [...held];
      const applied: SharedSettingField[] = [];
      const toTry = Object.entries(patch).filter(([field, value]) => {
        const prior = failed.get(field);
        if (prior && prior.value === canonical(value)) {
          pending.push({ field: field as SharedSettingField, value: value as MediaSettingValue, reason: prior.reason });
          return false;
        }
        return true;
      });
      if (toTry.length > 0) {
        try {
          await deps.applyUpdate(Object.fromEntries(toTry));
          applied.push(...toTry.map(([field]) => field as SharedSettingField));
        } catch {
          // One bad value must not hold back the others: each is applied on its own.
          const stillFailing: Array<[string, unknown, unknown]> = [];
          for (const [field, value] of toTry) {
            try {
              await deps.applyUpdate({ [field]: value });
              applied.push(field as SharedSettingField);
            } catch (error) {
              stillFailing.push([field, value, error]);
            }
          }
          // Fields valid only together (a datacenter and its volume) fail alone: tried together, then -- if one of them is bad on
          // its own -- together without each one in turn (the group is small: at most the shared fields).
          if (stillFailing.length > 1) {
            const groups = [stillFailing, ...stillFailing.map((_, skip) => stillFailing.filter((__, i) => i !== skip))].filter((g) => g.length > 1);
            for (const group of groups) {
              try {
                await deps.applyUpdate(Object.fromEntries(group.map(([field, value]) => [field, value])));
                applied.push(...group.map(([field]) => field as SharedSettingField));
                const done = new Set(group.map(([field]) => field));
                stillFailing.splice(0, stillFailing.length, ...stillFailing.filter(([field]) => !done.has(field)));
                break;
              } catch {
                // the next group
              }
            }
          }
          for (const [field, value, error] of stillFailing) {
            const reason = isVolumeBusy(error) ? "waiting: the network volume is in use on this computer" : isInvalidValue(error) ? `not applied: ${describe(error)}` : `not applied yet (retried): ${describe(error)}`;
            if (isInvalidValue(error)) failed.set(field, { value: canonical(value), reason });
            pending.push({ field: field as SharedSettingField, value: value as MediaSettingValue, reason });
          }
        }
      }
      for (const field of applied) failed.delete(field);
      if (applied.length > 0) {
        await deps.record({ action: "settings_applied_from_peer", subject: "media_settings", details: { fields: applied } }).catch(() => undefined);
      }
      const now = await deps.getSettings();
      const nowValues = sharedValuesOf(now);
      status = {
        checkedAt: at,
        lastApplied: applied.length > 0 ? { fields: applied, at } : status.lastApplied,
        pending,
        conflicts: conflicts
          .filter((c): c is MediaSettingConflict & { field: SharedSettingField } => (SHARED_SETTING_FIELDS as readonly string[]).includes(c.field))
          .map((c) => ({ field: c.field, values: c.values, thisComputer: nowValues[c.field] })),
        error: null,
      };
    } catch (error) {
      status = { ...status, checkedAt: at, error: describe(error) };
    }
    return status;
  }

  return {
    /** Seed, read, and apply what can be applied (the media watcher tick). */
    tick: () => exclusive(tick),
    /** The status from the document, applying nothing. */
    peek,
    status: () => status,
    /** Runs `fn` with no tick in between (an owner's save, a conflict choice). */
    exclusive,
  };
}

export type SettingsSync = ReturnType<typeof createSettingsSync>;
