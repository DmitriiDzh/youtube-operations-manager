import { DomainError, mediaSessionsReportSchema, type MediaSessionsReport } from "./contracts";

/** Where this device keeps its own latest report and the peers' latest reports (JSON text, one entry per device). */
export type MediaSessionsReportStore = {
  readLocal(): Promise<string | null>;
  writeLocal(json: string): Promise<void>;
  readPeers(): Promise<Record<string, string>>;
  writePeer(deviceId: string, json: string): Promise<void>;
};

export type MediaSessionsShareDeps = {
  store: MediaSessionsReportStore;
  ownDeviceId(): Promise<string>;
  clock?: { now(): Date };
};

/** A report dated further ahead than this is refused: a peer clock running fast must not pin a report forever. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
/** Peers silent for longer than this are no longer listed (a retired device's last report stops showing). */
export const PEER_FORGET_AFTER_MS = 7 * 24 * 60 * 60_000;

function parseReport(text: string): MediaSessionsReport | null {
  try {
    const parsed = mediaSessionsReportSchema.safeParse(JSON.parse(text));
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
    return "not a media sessions report (unreadable JSON)";
  }
  const version = json && typeof json === "object" ? (json as Record<string, unknown>).version : undefined;
  if (typeof version === "number" && version > 1) return `media sessions report version ${version} is newer than this app understands; update the app on this device`;
  return "invalid media sessions report";
}

export function createMediaSessionsShareCore(deps: MediaSessionsShareDeps) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const now = () => (deps.clock ?? { now: () => new Date() }).now();
  return {
    /** media-generation hands over this device's report (it never reaches back into media-generation from here). */
    async publishLocalReport(report: MediaSessionsReport): Promise<void> {
      const parsed = mediaSessionsReportSchema.parse(report);
      if (parsed.deviceId !== (await deps.ownDeviceId())) {
        throw new DomainError({ code: "validation_failed", message: "A media sessions report can only be published for this device." });
      }
      await deps.store.writeLocal(JSON.stringify(parsed));
    },

    /** The sync runner's push: this device's latest report, or `not_found` (nothing to push yet). */
    async exportBytes(): Promise<Uint8Array> {
      const local = await deps.store.readLocal();
      if (!local) throw new DomainError({ code: "not_found", message: "No media sessions report on this device yet." });
      return encoder.encode(local);
    },

    /**
     * The sync runner's pull for one peer file: a valid report of ANOTHER device replaces that device's stored report unless it
     * is older than the one already kept. An unreadable file, an invalid report or this device's own report is ignored.
     */
    async mergeIncoming(bytes: Uint8Array): Promise<{ accepted: boolean }> {
      const text = decoder.decode(bytes);
      const report = parseReport(text);
      // Thrown, not swallowed (independent review): the runner then lists the peer as skipped with this reason.
      if (!report) throw new DomainError({ code: "validation_failed", message: describeInvalid(text) });
      if (report.deviceId === (await deps.ownDeviceId())) return { accepted: false };
      if (Date.parse(report.updatedAt) > now().getTime() + MAX_FUTURE_SKEW_MS) {
        throw new DomainError({ code: "validation_failed", message: `media sessions report dated ${report.updatedAt}, in the future: that device's clock is ahead` });
      }
      const known = (await deps.store.readPeers())[report.deviceId];
      const previous = known ? parseReport(known) : null;
      if (previous && Date.parse(previous.updatedAt) > Date.parse(report.updatedAt)) return { accepted: false };
      await deps.store.writePeer(report.deviceId, JSON.stringify(report));
      return { accepted: true };
    },

    /** Every peer's latest report (never this device's own), newest first. */
    async listPeerReports(): Promise<MediaSessionsReport[]> {
      const own = await deps.ownDeviceId();
      const cutoff = now().getTime() - PEER_FORGET_AFTER_MS;
      return Object.values(await deps.store.readPeers())
        .map(parseReport)
        .filter((r): r is MediaSessionsReport => r !== null && r.deviceId !== own && Date.parse(r.updatedAt) >= cutoff)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    },
  };
}

export type MediaSessionsShareCore = ReturnType<typeof createMediaSessionsShareCore>;
