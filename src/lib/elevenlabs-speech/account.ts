import { createHmac } from "node:crypto";
import type { ElevenlabsPeerSpendReport, ElevenlabsPeerUsage } from "./contracts";

// BL-236 (owner, Telegram 2026-10-29, msg 3823; ADR 0057 following ADR 0039): computers on the same ElevenLabs key add their
// characters up and hold one daily and monthly limit. The key is recognised by a fingerprint each computer derives from it; the key
// itself never leaves the computer.

/** A fixed, public domain-separation label (not a secret; the same on every computer). Bump `v1` on every computer together. */
export const ELEVENLABS_FINGERPRINT_LABEL = "ytm/elevenlabs-key-fingerprint/v1";

/** 32 lowercase hex characters (128 bits of HMAC-SHA256 under the fixed label): equal for the same key, unrelated for any other. */
export function elevenlabsKeyFingerprint(apiKey: string): string {
  return createHmac("sha256", ELEVENLABS_FINGERPRINT_LABEL).update(apiKey, "utf8").digest("hex").slice(0, 32);
}

/** A peer report older than this is shown as stale (its device may be off); its use still counts -- use is history. */
export const ELEVENLABS_PEER_STALE_AFTER_MS = 12 * 60_000;
const FUTURE_SKEW_MS = 5 * 60_000;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * What the OTHER computers on this ElevenLabs key used -- the Gemini rule (ADR 0039): a report counts toward today when written since
 * this computer's local day began, toward the month when written since its local month began; a stale one still counts; only
 * reports with THIS computer's fingerprint are added, and none when this computer has no usable key.
 */
export function accountWideUsage(input: { peers: ElevenlabsPeerSpendReport[]; ownDeviceId: string | null; ownFingerprint: string | null; dayStart: Date; monthStart: Date; now: Date }) {
  const none = { otherTodayChars: 0, otherMonthChars: 0, otherTodayUsd: 0, otherMonthUsd: 0, otherComputers: [] as ElevenlabsPeerUsage[] };
  if (!input.ownFingerprint) return none;
  const nowMs = input.now.getTime();
  const otherComputers: ElevenlabsPeerUsage[] = [];
  for (const report of input.peers) {
    if (report.keyFingerprint !== input.ownFingerprint) continue;
    if (input.ownDeviceId !== null && report.deviceId === input.ownDeviceId) continue;
    const at = Date.parse(report.updatedAt);
    if (!Number.isFinite(at) || at > nowMs + FUTURE_SKEW_MS || at < input.monthStart.getTime()) continue;
    const today = at >= input.dayStart.getTime();
    otherComputers.push({
      deviceId: report.deviceId,
      hostname: report.hostname,
      todayChars: today ? Math.max(0, report.usedTodayChars) : 0,
      monthChars: Math.max(0, report.usedMonthChars),
      todayUsd: today ? Math.max(0, report.spentTodayUsd) : 0,
      monthUsd: Math.max(0, report.spentMonthUsd),
      updatedAt: report.updatedAt,
      stale: nowMs - at > ELEVENLABS_PEER_STALE_AFTER_MS,
    });
  }
  const sum = (pick: (p: ElevenlabsPeerUsage) => number) => otherComputers.reduce((total, peer) => total + pick(peer), 0);
  return { otherTodayChars: sum((p) => p.todayChars), otherMonthChars: sum((p) => p.monthChars), otherTodayUsd: round4(sum((p) => p.todayUsd)), otherMonthUsd: round4(sum((p) => p.monthUsd)), otherComputers };
}
