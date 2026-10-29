import { NextResponse } from "next/server";
import { z } from "zod";
import { ELEVENLABS_SHARED_LIMIT_FIELDS } from "@/lib/elevenlabs-speech";
import { defaultElevenlabsRouteDeps, elevenlabsHandler, readJsonBody, type ElevenlabsRouteDeps } from "../../shared";

const resolveSchema = z.object({ field: z.enum(ELEVENLABS_SHARED_LIMIT_FIELDS), value: z.number() }).strict();

/** BL-236 (owner msg 3823): the owner picks one value of an ElevenLabs limit that differs between the computers; it becomes the shared value. */
export function createElevenlabsSettingsSyncResolveHandler(deps: ElevenlabsRouteDeps = defaultElevenlabsRouteDeps()) {
  return elevenlabsHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const parsed = resolveSchema.safeParse(body.body);
    if (!parsed.success) return NextResponse.json({ error: "validation_failed", message: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
    return NextResponse.json(await core.resolveSettingConflict(parsed.data));
  });
}

export const POST = createElevenlabsSettingsSyncResolveHandler();
