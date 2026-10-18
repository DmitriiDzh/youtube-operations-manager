import { NextResponse } from "next/server";
import { DomainError } from "@/lib/media-generation";
import { bodyRecord, defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../../shared";

/** BL-200 (AC-RT-06): the owner makes a tested runtime active, or `null` -- the image's built-in ComfyUI. Rollback = the previous id. */
export function createRuntimeActivatePostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const { runtimeId } = bodyRecord(body.body);
    if (runtimeId !== null && typeof runtimeId !== "string") throw new DomainError({ code: "validation_failed", message: "runtimeId is a runtime id or null", details: { field: "runtimeId" } });
    return NextResponse.json(await core.setActiveRuntime({ runtimeId }, { actor: "owner" }));
  });
}

export const POST = createRuntimeActivatePostHandler();
