import { createHmac } from "node:crypto";
import type { GeminiPeerSpend, GeminiPeerSpendReport } from "./contracts";

// BL-193 (owner, Telegram 2026-10-16, msgs 2864/2867; ADR 0039): computers that use the same Gemini key add their spend up and
// hold one daily and monthly limit. Google has no API that names the account behind a key, so the key is recognised by a
// fingerprint each computer derives from it -- the key itself never leaves the computer.

/**
 * The HMAC key of the fingerprint: a fixed, public domain-separation label, NOT a secret. It must be the same on every computer
 * (a per-device salt would make every computer's fingerprint different and nothing would ever be added up). What keeps the key
 * unrecoverable is the key's own entropy (an AI Studio key is ~35 random characters, far beyond any guessing), and the label makes
 * the value useless as a plain SHA-256 of the key (it matches no other system's hash of it). Changing the label changes every
 * fingerprint: bump the `v1` together on every computer.
 */
export const GEMINI_FINGERPRINT_LABEL = "ytm/gemini-key-fingerprint/v1";

/** 32 lowercase hex characters (128 bits of HMAC-SHA256 under the fixed label): equal for the same key, unrelated for any other. */
export function geminiKeyFingerprint(apiKey: string): string {
  return createHmac("sha256", GEMINI_FINGERPRINT_LABEL).update(apiKey, "utf8").digest("hex").slice(0, 32);
}

/** A peer report older than this is shown as stale (its device may be off); its spend still counts -- spend is history. */
export const GEMINI_PEER_STALE_AFTER_MS = 5 * 60_000;
/** A report dated further ahead than this (a peer clock running fast) is not counted at all. */
const FUTURE_SKEW_MS = 5 * 60_000;

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * What the OTHER computers on this Gemini key spent, for this computer's daily and monthly limits -- the rule ADR 0028 §5 uses for
 * RunPod's daily cap: a report counts toward today when it was written since this computer's local day began, toward the month
 * when written since its local month began (a computer that went off at noon still spent its morning; a report from earlier in
 * the month is still a lower bound of that computer's month). A stale report still counts. Only reports carrying THIS computer's
 * key fingerprint are added; with no fingerprint here (no usable key) nothing is.
 */
export function accountWideSpend(input: {
  peers: GeminiPeerSpendReport[];
  ownDeviceId: string | null;
  ownFingerprint: string | null;
  dayStart: Date;
  monthStart: Date;
  now: Date;
}): { otherTodayUsd: number; otherMonthUsd: number; otherComputers: GeminiPeerSpend[] } {
  if (!input.ownFingerprint) return { otherTodayUsd: 0, otherMonthUsd: 0, otherComputers: [] };
  const nowMs = input.now.getTime();
  const otherComputers: GeminiPeerSpend[] = [];
  for (const report of input.peers) {
    if (report.keyFingerprint !== input.ownFingerprint) continue;
    if (input.ownDeviceId !== null && report.deviceId === input.ownDeviceId) continue;
    const at = Date.parse(report.updatedAt);
    if (!Number.isFinite(at) || at > nowMs + FUTURE_SKEW_MS || at < input.monthStart.getTime()) continue;
    otherComputers.push({
      deviceId: report.deviceId,
      hostname: report.hostname,
      todayUsd: at >= input.dayStart.getTime() ? Math.max(0, report.spentTodayUsd) : 0,
      monthUsd: Math.max(0, report.spentMonthUsd),
      updatedAt: report.updatedAt,
      stale: nowMs - at > GEMINI_PEER_STALE_AFTER_MS,
    });
  }
  return {
    otherTodayUsd: round4(otherComputers.reduce((sum, peer) => sum + peer.todayUsd, 0)),
    otherMonthUsd: round4(otherComputers.reduce((sum, peer) => sum + peer.monthUsd, 0)),
    otherComputers,
  };
}
