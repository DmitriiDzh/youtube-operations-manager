import { ELEVENLABS_SPEND_REPORT_FORMAT, ELEVENLABS_SPEND_REPORT_VERSION, type ElevenlabsSpendReport } from "@/lib/sync-gateway";

// BL-236 (owner msg 3823; ADR 0057 following ADR 0039 §2): this computer's ElevenLabs characters for the other computers on the same
// key, as an `elevenlabs-spend` report -- written when the figures, the key or the day changed, and at least every 5 minutes.

export const ELEVENLABS_SPEND_REPUBLISH_MS = 5 * 60_000;

export type ElevenlabsSpendSharePublisherDeps = {
  localUsage: (at: Date) => Promise<{ todayChars: number; monthChars: number; todayUsd: number; monthUsd: number }>;
  keyFingerprint: () => Promise<string | null>;
  deviceId: () => Promise<string | null>;
  hostname: () => string | null;
  publish: (report: ElevenlabsSpendReport) => Promise<void>;
  now: () => Date;
};

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, Number.isFinite(value) ? value : 0));

export function createElevenlabsSpendSharePublisher(deps: ElevenlabsSpendSharePublisherDeps) {
  let lastPublished = { key: "", at: 0 };
  return async function publishSpendShare(at: Date = deps.now()): Promise<boolean> {
    const [local, keyFingerprint, deviceId] = await Promise.all([deps.localUsage(at), deps.keyFingerprint(), deps.deviceId()]);
    if (!deviceId) return false;
    const report: ElevenlabsSpendReport = {
      format: ELEVENLABS_SPEND_REPORT_FORMAT,
      version: ELEVENLABS_SPEND_REPORT_VERSION,
      deviceId,
      hostname: deps.hostname(),
      keyFingerprint,
      updatedAt: at.toISOString(),
      usedTodayChars: Math.round(clamp(local.todayChars, 100_000_000)),
      usedMonthChars: Math.round(clamp(local.monthChars, 1_000_000_000)),
      spentTodayUsd: clamp(local.todayUsd, 100_000),
      spentMonthUsd: clamp(local.monthUsd, 1_000_000),
    };
    const key = JSON.stringify([report.hostname, report.keyFingerprint, report.usedTodayChars, report.usedMonthChars, report.spentTodayUsd, report.spentMonthUsd, at.toDateString()]);
    if (key === lastPublished.key && at.getTime() - lastPublished.at < ELEVENLABS_SPEND_REPUBLISH_MS) return false;
    await deps.publish(report);
    lastPublished = { key, at: at.getTime() };
    return true;
  };
}
