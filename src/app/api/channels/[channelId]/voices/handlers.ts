import { readFile } from "node:fs/promises";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { isDomainError } from "@/lib/shared-domain";
import type { VoiceRegistryServices } from "@/lib/voice-registry";
import { getVideoMetadataErrorStatus } from "../../../video-metadata/error-status";

// BL-236 (ADR 0057): the owner's «Голоса» of the active channel -- list, play a preview, approve one preview (the owner's own pick),
// rename, archive. A Web session and the ACTIVE channel are required (AGENTS.md §F, ADR 0004), and the registry itself refuses a
// voice of another channel (`voice_not_found`, Playbook §6.6). Designing a voice (paid) stays with the Operator's
// factory_voice_design; nothing here calls a provider except the approval of an ElevenLabs preview (saving it as a voice).

export type VoicesRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  registry: () => Promise<Pick<VoiceRegistryServices, "list" | "approve" | "update" | "previewFile">>;
  readFile: (path: string) => Promise<Buffer>;
};

const defaultDeps = (): VoicesRouteDeps => ({
  getSession: () => getServerSession(authOptions),
  assertActiveChannel: async (args) => {
    await createChannelAccessCore().assertActiveChannel(args);
  },
  // Loaded on use: the voice registry never takes another route down with it (AGENTS.md §M).
  registry: async () => (await import("@/composition/speech")).voiceRegistryForProduction(),
  readFile: (path) => readFile(path),
});

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const badBody = () => NextResponse.json({ error: "validation_failed", message: "The request must be a JSON object without channelId or voiceId (they are in the address)." }, { status: 400 });

function errorResponse(error: unknown) {
  if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

type Params<T> = { params: Promise<T> };
type Base = { channelId: string };

export function createVoicesRouteHandlers(deps: VoicesRouteDeps = defaultDeps()) {
  async function guarded<T extends Base>(context: Params<T>, run: (params: T) => Promise<Response>): Promise<Response> {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const params = await context.params;
      await deps.assertActiveChannel({ userId, channelId: params.channelId });
      return await run(params);
    } catch (error) {
      return errorResponse(error);
    }
  }
  return {
    list: (request: Request, context: Params<Base>) =>
      guarded(context, async ({ channelId }) => NextResponse.json(await (await deps.registry()).list({ channelId, includeArchived: new URL(request.url).searchParams.get("archived") === "1" }))),

    /** PATCH `{ name }` or `{ archived: true }`. */
    update: (request: Request, context: Params<Base & { voiceId: string }>) =>
      guarded(context, async ({ channelId, voiceId }) => {
        const body = await bodyOf(request);
        if (!body || "channelId" in body || "voiceId" in body) return badBody();
        return NextResponse.json(await (await deps.registry()).update({ ...body, channelId, voiceId: decodeURIComponent(voiceId) }));
      }),

    /** POST `{ previewId }` -- the owner's pick: that preview becomes the voice. */
    approve: (request: Request, context: Params<Base & { voiceId: string }>) =>
      guarded(context, async ({ channelId, voiceId }) => {
        const body = await bodyOf(request);
        if (!body || "channelId" in body || "voiceId" in body) return badBody();
        return NextResponse.json(await (await deps.registry()).approve({ ...body, channelId, voiceId: decodeURIComponent(voiceId) }, "owner"));
      }),

    /** GET -- the preview's audio, for the player. Only a preview of this channel's voice. */
    preview: (_request: Request, context: Params<Base & { voiceId: string; previewId: string }>) =>
      guarded(context, async ({ channelId, voiceId, previewId }) => {
        const file = await (await deps.registry()).previewFile(channelId, decodeURIComponent(voiceId), decodeURIComponent(previewId));
        const data = await deps.readFile(file.localPath);
        return new Response(new Uint8Array(data), { status: 200, headers: { "content-type": file.mimeType, "content-length": String(data.length), "cache-control": "private, max-age=300" } });
      }),
  };
}
