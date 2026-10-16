import { GEMINI_SPEND_REPORT_FORMAT, GEMINI_SPEND_REPORT_VERSION, type GeminiSpendReport } from "@/lib/sync-gateway";

// BL-193 (ADR 0039 §2): this computer's Gemini spend for the other computers on the same key, as a `gemini-spend` report. Written
// when the figures, the key or the day changed (the share loop ticks every 30 s), and at least every 5 minutes even when nothing
// changed, so the others can tell this computer is alive. Kept apart from the production core so the rule can be tested alone.

/** Even with nothing changed, the report is rewritten after this long. */
export const GEMINI_SPEND_REPUBLISH_MS = 5 * 60_000;

export type GeminiSpendSharePublisherDeps = {
  localSpend: (at: Date) => Promise<{ todayUsd: number; monthUsd: number }>;
  keyFingerprint: () => Promise<string | null>;
  deviceId: () => Promise<string | null>;
  hostname: () => string | null;
  publish: (report: GeminiSpendReport) => Promise<void>;
  now: () => Date;
};

/** The report schema's bounds (one bad figure must not be able to claim an absurd spend); a non-number counts 0. */
const clamp = (value: number, max: number) => Math.min(max, Math.max(0, Number.isFinite(value) ? value : 0));

export function createGeminiSpendSharePublisher(deps: GeminiSpendSharePublisherDeps) {
  let lastPublished = { key: "", at: 0 };
  /** Returns whether a report was written. No device id yet = nothing to publish under (the report is per device). */
  return async function publishSpendShare(at: Date = deps.now()): Promise<boolean> {
    const [local, keyFingerprint, deviceId] = await Promise.all([deps.localSpend(at), deps.keyFingerprint(), deps.deviceId()]);
    if (!deviceId) return false;
    const report: GeminiSpendReport = {
      format: GEMINI_SPEND_REPORT_FORMAT,
      version: GEMINI_SPEND_REPORT_VERSION,
      deviceId,
      hostname: deps.hostname(),
      keyFingerprint,
      updatedAt: at.toISOString(),
      spentTodayUsd: clamp(local.todayUsd, 100_000),
      spentMonthUsd: clamp(local.monthUsd, 1_000_000),
    };
    const key = JSON.stringify([report.hostname, report.keyFingerprint, report.spentTodayUsd, report.spentMonthUsd, at.toDateString()]);
    if (key === lastPublished.key && at.getTime() - lastPublished.at < GEMINI_SPEND_REPUBLISH_MS) return false;
    await deps.publish(report);
    lastPublished = { key, at: at.getTime() };
    return true;
  };
}
