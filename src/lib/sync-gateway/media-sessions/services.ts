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
};

function parseReport(text: string): MediaSessionsReport | null {
  try {
    const parsed = mediaSessionsReportSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createMediaSessionsShareCore(deps: MediaSessionsShareDeps) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
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
      const report = parseReport(decoder.decode(bytes));
      if (!report || report.deviceId === (await deps.ownDeviceId())) return { accepted: false };
      const known = (await deps.store.readPeers())[report.deviceId];
      const previous = known ? parseReport(known) : null;
      if (previous && Date.parse(previous.updatedAt) > Date.parse(report.updatedAt)) return { accepted: false };
      await deps.store.writePeer(report.deviceId, JSON.stringify(report));
      return { accepted: true };
    },

    /** Every peer's latest report (never this device's own), newest first. */
    async listPeerReports(): Promise<MediaSessionsReport[]> {
      const own = await deps.ownDeviceId();
      return Object.values(await deps.store.readPeers())
        .map(parseReport)
        .filter((r): r is MediaSessionsReport => r !== null && r.deviceId !== own)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    },
  };
}

export type MediaSessionsShareCore = ReturnType<typeof createMediaSessionsShareCore>;
