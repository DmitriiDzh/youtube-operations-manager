import { NextResponse } from "next/server";
import { z } from "zod";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../../shared";

const resolveSchema = z
  .object({ field: z.string().min(1).max(64), value: z.union([z.string().max(500), z.number(), z.boolean(), z.null(), z.array(z.string().max(200)).max(50)]) })
  .strict();

/** BL-150 (owner msg 2011): the owner picks one value of a setting that differs between the computers; it becomes the shared value. */
export function createSettingsSyncResolveHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const parsed = resolveSchema.safeParse(body.body);
    if (!parsed.success) return NextResponse.json({ error: "validation_failed", message: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
    return NextResponse.json(await core.resolveSettingConflict(parsed.data));
  });
}

export const POST = createSettingsSyncResolveHandler();
