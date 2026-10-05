import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../../shared";

/** The exchange janitor (AC-P14-14): `{ dryRun: true }` (default) only reports; `{ dryRun: false }` deletes terminal leftovers under `exchange/`. */
export function createJanitorPostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request).catch(() => ({ ok: true as const, body: {} }));
    const dryRun = body.ok && body.body && typeof body.body === "object" ? (body.body as { dryRun?: unknown }).dryRun !== false : true;
    return NextResponse.json(await core.cleanupExchange({ dryRun }));
  });
}

export const POST = createJanitorPostHandler();
