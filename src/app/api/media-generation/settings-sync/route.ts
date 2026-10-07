import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, type MediaRouteDeps } from "../shared";

/**
 * BL-150 (docs/roadmap/plans/PRODUCTION_SETTINGS_SYNC_PLAN.md): where the shared Setup settings stand on this device -- what was
 * applied from the other computer, what is held and why, and the conflicts waiting for the owner's choice. A local read.
 */
export function createSettingsSyncGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => {
    const status = core.getSettingsSyncStatus();
    // Checked more than 15 s ago (or never, right after a start): check now, so the startup window sees a conflict that arrived
    // since the watcher's last tick. A check only reads the document unless a received value needs applying.
    const fresh = status.checkedAt !== null && Date.now() - Date.parse(status.checkedAt) < 15_000;
    return NextResponse.json(fresh ? status : await core.syncSharedSettings());
  });
}

export const GET = createSettingsSyncGetHandler();
