import { NextResponse } from "next/server";
import { bodyRecord, defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../../shared";

// BL-132 (docs/roadmap/plans/FACTORY_MEDIA_CONTROL_PLAN.md §2.3): the factory template registry. GET = the last sync
// result on this device (read-only); POST = "Sync templates" now, by the owner (`{ dryRun?: boolean }`). The server
// also checks the registry by itself every 60 s (owner answer O1).

export function createTemplateSyncGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json({ lastSync: await core.getLastTemplateSync() }));
}

export function createTemplateSyncPostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const dryRun = bodyRecord(body.body).dryRun === true;
    return NextResponse.json({ result: await core.syncTemplatesFromRegistry({ trigger: "owner", dryRun }) });
  });
}

export const GET = createTemplateSyncGetHandler();
export const POST = createTemplateSyncPostHandler();
