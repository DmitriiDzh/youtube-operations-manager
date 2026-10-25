import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { CHANNEL_BANNER_MAX_BYTES, createChannelBrandingOwnerCore, type ChannelBrandingService } from "@/lib/channel-branding";
import { isDomainError } from "@/lib/shared-domain";

// BL-223 (CHANNEL_BRANDING_PLAN.md §2-§4/§6, ADR 0050): the owner's routes for a channel's description, keywords and banner. Every
// handler: a Web session (401), the channel must be the active one (ADR 0004, 403), a thin call into the module, DomainError ->
// status. GET reads YouTube once (1 unit) next to the stored draft; PUT and GET /banner are local; POST /preview reads YouTube
// (1 unit); only POST /apply writes to YouTube -- the one path to it, with the identity check, Live writes, backup, read-back and
// audit inside the module. Mutating methods pass `src/proxy.ts`'s gate like every /api route.

export type ChannelBrandingRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  core: Pick<ChannelBrandingService, "get" | "save" | "bannerBytes" | "preview" | "apply">;
};

export function defaultChannelBrandingRouteDeps(): ChannelBrandingRouteDeps {
  const access = createChannelAccessCore();
  return {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await access.assertActiveChannel(args);
    },
    core: createChannelBrandingOwnerCore(),
  };
}

type RouteContext = { params: Promise<{ channelId: string }> };

function handler(deps: ChannelBrandingRouteDeps, run: (args: { core: ChannelBrandingRouteDeps["core"]; channelId: string; userId: string; request: Request }) => Promise<Response>) {
  return async function route(request: Request, context: RouteContext): Promise<Response> {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId } = await context.params;
      await deps.assertActiveChannel({ userId, channelId });
      return await run({ core: deps.core, channelId, userId, request });
    } catch (error) {
      if (isDomainError(error)) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

const invalid = (message: string, status = 400) => NextResponse.json({ error: "validation_failed", message }, { status });
const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** Multipart framing on top of the 6 MB banner (best effort: only when the browser sends Content-Length). */
const CONTENT_LENGTH_MARGIN_BYTES = 256 * 1024;

export function createChannelBrandingHandlers(deps: ChannelBrandingRouteDeps) {
  return {
    /** The stored draft, the last apply and the channel on YouTube now (1 unit; `live: null` with the code when unreadable). */
    GET: handler(deps, async ({ core, channelId }) => NextResponse.json(await core.get(channelId))),
    /**
     * Replaces the stored draft. JSON `{ description?, keywords?, keepBanner? }`, or multipart with the field `draft` (that JSON) and
     * the file `banner` (a new banner). Local only; refused whole with `details.refused`.
     */
    PUT: handler(deps, async ({ core, channelId, request }) => {
      const contentType = request.headers.get("content-type") ?? "";
      let fields: Record<string, unknown> | null;
      let bannerBytes: Buffer | null = null;
      if (contentType.startsWith("multipart/form-data")) {
        if (Number(request.headers.get("content-length") ?? 0) > CHANNEL_BANNER_MAX_BYTES + CONTENT_LENGTH_MARGIN_BYTES) return invalid("The banner exceeds 6 MB", 413);
        const form = await request.formData().catch(() => null);
        if (!form) return invalid("Request body must be multipart form data");
        try {
          fields = record(JSON.parse(String(form.get("draft") ?? "{}")));
        } catch {
          return invalid("The field 'draft' must be JSON");
        }
        const file = form.get("banner");
        if (file instanceof Blob) bannerBytes = Buffer.from(await file.arrayBuffer());
      } else {
        try {
          fields = record(await request.json());
        } catch {
          return invalid("Request body must be valid JSON");
        }
      }
      if (!fields) return invalid("The draft must be an object");
      const banner = bannerBytes ? ({ kind: "bytes", bytes: bannerBytes } as const) : fields.keepBanner === true ? ({ kind: "keep" } as const) : undefined;
      return NextResponse.json(await core.save(channelId, { description: fields.description, keywords: fields.keywords, banner }, "owner"));
    }),
    /** The stored draft's banner image (local), for the card. */
    BANNER: handler(deps, async ({ core, channelId }) => {
      const banner = await core.bannerBytes(channelId);
      if (!banner) return NextResponse.json({ error: "not_found", message: "No banner is saved in the draft" }, { status: 404 });
      return new Response(new Uint8Array(banner.bytes), { headers: { "content-type": banner.mimeType, "cache-control": "no-store" } });
    }),
    /** What «Применить» would do now (a 1-unit read; nothing is written), with the draftVersion «Применить» sends back. */
    PREVIEW: handler(deps, async ({ core, channelId }) => NextResponse.json(await core.preview(channelId))),
    /**
     * The owner's «Применить»: the only path from this app to a channel's branding on YouTube. Body `{ draftVersion }` -- the version
     * the preview answered (a draft saved since is refused with 409 `branding_changed`).
     */
    APPLY: handler(deps, async ({ core, channelId, userId, request }) => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return invalid("Request body must be valid JSON");
      }
      return NextResponse.json(await core.apply(channelId, { userId }, record(body)?.draftVersion));
    }),
  };
}
