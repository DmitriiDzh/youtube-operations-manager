import { z } from "zod";
import { DomainError } from "@/lib/shared-domain";
import {
  DEFAULT_DISK_GUARD_THRESHOLD_GB,
  DISK_GUARD_REALERT_MS,
  DISK_GUARD_RECOVERY_MARGIN_GB,
  DISK_GUARD_THRESHOLD_MAX_GB,
  DISK_GUARD_THRESHOLD_MIN_GB,
  GB,
  INITIAL_DISK_GUARD_STATE,
  type DiskConsumer,
  type DiskConsumerKey,
  type DiskGuardDeps,
  type DiskGuardNotice,
  type DiskGuardSettings,
  type DiskGuardState,
  type DiskGuardView,
  type DiskVolume,
} from "./contracts";

const settingsSchema = z.object({ thresholdGb: z.number().finite().min(DISK_GUARD_THRESHOLD_MIN_GB).max(DISK_GUARD_THRESHOLD_MAX_GB) }).strict();

/** Forgiving: a missing or bad stored value is the default. */
export function diskGuardSettingsFromJson(json: string | null): DiskGuardSettings {
  try {
    const parsed = settingsSchema.safeParse(json ? JSON.parse(json) : null);
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to the default
  }
  return { thresholdGb: DEFAULT_DISK_GUARD_THRESHOLD_GB };
}

const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Forgiving per field: a bad stored value is its initial one. */
export function diskGuardStateFromJson(json: string | null): DiskGuardState {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = json ? JSON.parse(json) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
  } catch {
    stored = {};
  }
  return {
    alertActive: stored.alertActive === true,
    lastAlertAt: numberOrNull(stored.lastAlertAt),
    lastCheckAt: numberOrNull(stored.lastCheckAt),
    lastFreeBytes: numberOrNull(stored.lastFreeBytes),
    lastError: typeof stored.lastError === "string" ? stored.lastError : INITIAL_DISK_GUARD_STATE.lastError,
  };
}

/**
 * The alert rule (pure). Not alerting: free space below the threshold raises one alert. Alerting: back at or above
 * threshold + 2 GB ends it (the next drop alerts again); still below the threshold 24 h after the last alert raises one
 * more; anything else (below, or between the threshold and threshold + 2 GB) stays quiet.
 */
export function decideDiskAlert(state: DiskGuardState, freeBytes: number, thresholdGb: number, now: number): { raise: boolean; state: DiskGuardState } {
  const threshold = thresholdGb * GB;
  const below = freeBytes < threshold;
  if (!state.alertActive) {
    return below ? { raise: true, state: { ...state, alertActive: true, lastAlertAt: now } } : { raise: false, state };
  }
  if (freeBytes >= threshold + DISK_GUARD_RECOVERY_MARGIN_GB * GB) return { raise: false, state: { ...state, alertActive: false } };
  if (below && (state.lastAlertAt === null || now - state.lastAlertAt >= DISK_GUARD_REALERT_MS)) {
    return { raise: true, state: { ...state, lastAlertAt: now } };
  }
  return { raise: false, state };
}

export const gbText = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

const CONSUMER_LABEL: Record<DiskConsumerKey, string> = {
  liveStreamsBuffer: "live-streams buffer",
  backups: "backups",
  nextCache: "build cache (.next/cache)",
  tempDir: "temp folder",
};

/** The System topic message (English like the topic's other messages). */
export function diskAlertMessage(input: { hostname: string; volumes: DiskVolume[]; thresholdGb: number; consumers: DiskConsumer[] }): string {
  const lines = [`Low disk space on ${input.hostname}: below ${input.thresholdGb} GB free.`];
  for (const volume of input.volumes) {
    lines.push(`${volume.path}: ${gbText(volume.freeBytes)} free of ${gbText(volume.totalBytes)}`);
  }
  if (input.consumers.length > 0) {
    const sorted = [...input.consumers].sort((a, b) => b.bytes - a.bytes);
    lines.push(`App folders: ${sorted.map((c) => `${CONSUMER_LABEL[c.key]} ${c.complete ? "" : "at least "}${gbText(c.bytes)}`).join(", ")}.`);
  }
  lines.push("Details: Servers -> Sessions -> Disk in the app.");
  return lines.join("\n");
}

export function createDiskGuard(deps: DiskGuardDeps) {
  const log = deps.log ?? (() => undefined);
  const readSettings = async () => diskGuardSettingsFromJson(await deps.getSettingsJson());
  const readState = async () => diskGuardStateFromJson(await deps.getStateJson());
  const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
  // One folder measurement at a time (review): a second request while one runs gets the running one's result, so repeated
  // clicks or two open tabs never walk $TMPDIR in parallel.
  let measuring: Promise<DiskConsumer[]> | null = null;
  const measureOnce = (): Promise<DiskConsumer[]> =>
    (measuring ??= deps
      .measureConsumers()
      .catch(() => [] as DiskConsumer[])
      .finally(() => {
        measuring = null;
      }));

  function noticeOf(state: DiskGuardState, settings: DiskGuardSettings): DiskGuardNotice | null {
    if (!state.alertActive || state.lastFreeBytes === null || state.lastAlertAt === null) return null;
    return { freeBytes: state.lastFreeBytes, thresholdGb: settings.thresholdGb, since: new Date(state.lastAlertAt).toISOString() };
  }

  return {
    /** One check (the server's 15-minute loop). Never throws over the disk; at most one alert per call. */
    async tick(): Promise<{ raised: boolean; posted: boolean; freeBytes: number | null }> {
      const now = deps.clock();
      const [settings, state] = await Promise.all([readSettings(), readState()]);
      let volumes: DiskVolume[];
      try {
        volumes = await deps.volumes();
        if (volumes.length === 0) throw new Error("no volume could be read");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.setStateJson(JSON.stringify({ ...state, lastCheckAt: now, lastError: message.slice(0, 300) }));
        log("disk_guard.check_failed", { message });
        return { raised: false, posted: false, freeBytes: null };
      }
      const lowest = Math.min(...volumes.map((v) => v.freeBytes));
      const decision = decideDiskAlert(state, lowest, settings.thresholdGb, now);
      // Saved before the message goes out: a failing post never makes the next check alert again.
      await deps.setStateJson(JSON.stringify({ ...decision.state, lastCheckAt: now, lastFreeBytes: lowest, lastError: null }));
      if (!decision.raise) return { raised: false, posted: false, freeBytes: lowest };
      const consumers = await measureOnce();
      let posted = false;
      try {
        posted = await deps.postSystemMessage(diskAlertMessage({ hostname: deps.hostname(), volumes, thresholdGb: settings.thresholdGb, consumers }));
      } catch (error) {
        log("disk_guard.post_failed", { message: error instanceof Error ? error.message : String(error) });
      }
      log("disk_guard.alert", { freeBytes: lowest, thresholdGb: settings.thresholdGb, posted });
      return { raised: true, posted, freeBytes: lowest };
    },

    /** The bell's notice: stored state only (cheap enough for the bell's 30-second poll). */
    async notice(): Promise<DiskGuardNotice | null> {
      const [settings, state] = await Promise.all([readSettings(), readState()]);
      return noticeOf(state, settings);
    },

    /** The «Диск» card: the volumes now, the alert, and -- when asked -- the big folders' sizes. Changes nothing. */
    async view(options: { measure?: boolean } = {}): Promise<DiskGuardView> {
      const [settings, state] = await Promise.all([readSettings(), readState()]);
      let volumes: DiskVolume[] = [];
      let volumesError: string | null = null;
      try {
        volumes = await deps.volumes();
      } catch (error) {
        volumesError = error instanceof Error ? error.message : String(error);
      }
      const consumers = options.measure ? await measureOnce() : null;
      return { settings, volumes, volumesError, notice: noticeOf(state, settings), lastCheckAt: iso(state.lastCheckAt), consumers };
    },

    async updateSettings(input: unknown): Promise<DiskGuardSettings> {
      const parsed = settingsSchema.safeParse(input);
      if (!parsed.success) {
        throw new DomainError({
          code: "validation_failed",
          message: `The threshold must be a number of GB from ${DISK_GUARD_THRESHOLD_MIN_GB} to ${DISK_GUARD_THRESHOLD_MAX_GB}`,
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      await deps.setSettingsJson(JSON.stringify(parsed.data));
      return parsed.data;
    },
  };
}

export type DiskGuard = ReturnType<typeof createDiskGuard>;
