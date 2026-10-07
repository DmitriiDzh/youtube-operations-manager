import type { ZodType } from "zod";
import { DomainError } from "@/lib/shared-domain";

// ---------------------------------------------------------------------------
// The shared mechanics of a "per-device report" family (extracted from `media-sessions`, ADR 0028, for BL-143's
// `generation-plans`, AGENTS.md §M/§D: one implementation, not a copy per family). Each device writes only its OWN report and
// keeps the latest report of every peer: nothing is merged, so there are no conflicts. A report is any strict JSON object with
// `format`, `version`, `deviceId` and an ISO `updatedAt`; the family supplies its schema and its wording.
// ---------------------------------------------------------------------------

export type PerDeviceReportBase = { format: string; version: number; deviceId: string; updatedAt: string };

/** Where this device keeps its own latest report and the peers' latest reports (JSON text, one entry per device). */
export type PerDeviceReportStore = {
  readLocal(): Promise<string | null>;
  writeLocal(json: string): Promise<void>;
  readPeers(): Promise<Record<string, string>>;
  writePeer(deviceId: string, json: string): Promise<void>;
};

/** A report dated further ahead than this is refused: a peer clock running fast must not pin a report forever. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
/** Peers silent for longer than this are no longer listed (a retired device's last report stops showing). */
export const PEER_FORGET_AFTER_MS = 7 * 24 * 60 * 60_000;

export function createPerDeviceReportCore<R extends PerDeviceReportBase>(deps: {
  schema: ZodType<R>;
  /** How the family names its report in messages, e.g. "media sessions report". */
  label: string;
  store: PerDeviceReportStore;
  ownDeviceId(): Promise<string>;
  clock?: { now(): Date };
}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const now = () => (deps.clock ?? { now: () => new Date() }).now();

  // Peer reports are re-read often (every Plans poll, every audio request): parse each text once.
  const parsedCache = new Map<string, { text: string; report: R | null }>();
  function parseCached(key: string, text: string): R | null {
    const hit = parsedCache.get(key);
    if (hit && hit.text === text) return hit.report;
    const report = parseReport(text);
    parsedCache.set(key, { text, report });
    return report;
  }

  function parseReport(text: string): R | null {
    try {
      const parsed = deps.schema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Why a peer file is unusable, said out loud (the sync runner records it as a skipped peer, visible in the Merge tab). */
  function describeInvalid(text: string): string {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return `not a ${deps.label} (unreadable JSON)`;
    }
    const version = json && typeof json === "object" ? (json as Record<string, unknown>).version : undefined;
    if (typeof version === "number" && version > 1) return `${deps.label} version ${version} is newer than this app understands; update the app on this device`;
    return `invalid ${deps.label}`;
  }

  return {
    /** The owning module hands over this device's report (it never reaches back into that module from here). */
    async publishLocalReport(report: R): Promise<void> {
      const parsed = deps.schema.parse(report);
      if (parsed.deviceId !== (await deps.ownDeviceId())) {
        throw new DomainError({ code: "validation_failed", message: `A ${deps.label} can only be published for this device.` });
      }
      await deps.store.writeLocal(JSON.stringify(parsed));
    },

    /** The sync runner's push: this device's latest report, or `not_found` (nothing to push yet). */
    async exportBytes(): Promise<Uint8Array> {
      const local = await deps.store.readLocal();
      if (!local) throw new DomainError({ code: "not_found", message: `No ${deps.label} on this device yet.` });
      return encoder.encode(local);
    },

    /**
     * The sync runner's pull for one peer file: a valid report of ANOTHER device replaces that device's stored report unless it
     * is older than the one already kept. An invalid report is thrown (the runner lists the peer as skipped with the reason);
     * this device's own report is ignored.
     */
    async mergeIncoming(bytes: Uint8Array, fileDeviceId?: string): Promise<{ accepted: boolean }> {
      const text = decoder.decode(bytes);
      const report = parseReport(text);
      if (!report) throw new DomainError({ code: "validation_failed", message: describeInvalid(text) });
      // A device may speak only for itself (independent review, BL-143 phase 2): the report must name the device its file is
      // named after, so one synced device cannot replace another's report or send verdicts in its name.
      if (fileDeviceId !== undefined && report.deviceId !== fileDeviceId) {
        throw new DomainError({ code: "validation_failed", message: `${deps.label} in ${fileDeviceId}'s file claims to be from ${report.deviceId}` });
      }
      if (report.deviceId === (await deps.ownDeviceId())) return { accepted: false };
      if (Date.parse(report.updatedAt) > now().getTime() + MAX_FUTURE_SKEW_MS) {
        throw new DomainError({ code: "validation_failed", message: `${deps.label} dated ${report.updatedAt}, in the future: that device's clock is ahead` });
      }
      const known = (await deps.store.readPeers())[report.deviceId];
      const previous = known ? parseReport(known) : null;
      if (previous && Date.parse(previous.updatedAt) > Date.parse(report.updatedAt)) return { accepted: false };
      await deps.store.writePeer(report.deviceId, JSON.stringify(report));
      return { accepted: true };
    },

    /** Every peer's latest report (never this device's own), newest first. */
    async listPeerReports(): Promise<R[]> {
      const own = await deps.ownDeviceId();
      const cutoff = now().getTime() - PEER_FORGET_AFTER_MS;
      return Object.entries(await deps.store.readPeers())
        .map(([key, text]) => parseCached(key, text))
        .filter((r): r is R => r !== null && r.deviceId !== own && Date.parse(r.updatedAt) >= cutoff)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    },
  };
}
