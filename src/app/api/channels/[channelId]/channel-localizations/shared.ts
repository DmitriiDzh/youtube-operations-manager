import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createChannelLocalizationsOwnerCore, type ChannelLocalizationsService } from "@/lib/channel-localizations";
import { isDomainError } from "@/lib/shared-domain";

// BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md §2/§6, ADR 0047): the owner's routes for a channel's own translations. Every handler: a Web
// session (401), the channel must be the active one (ADR 0004, 403), a thin call into the module, DomainError -> status. GET and
// PUT are local; the preview reads YouTube (1 unit); only POST /apply writes to YouTube -- the one path to it, with the identity
// check, Live writes, backup, read-back and audit inside the module. Mutating methods pass `src/proxy.ts`'s gate like every /api route.

export type ChannelLocalizationsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  core: Pick<ChannelLocalizationsService, "view" | "save" | "preview" | "apply">;
};

export function defaultChannelLocalizationsRouteDeps(): ChannelLocalizationsRouteDeps {
  const access = createChannelAccessCore();
  return {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await access.assertActiveChannel(args);
    },
    core: createChannelLocalizationsOwnerCore(),
  };
}

type RouteContext = { params: Promise<{ channelId: string }> };

export function channelLocalizationsHandler(
  deps: ChannelLocalizationsRouteDeps,
  run: (args: { core: ChannelLocalizationsRouteDeps["core"]; channelId: string; userId: string; request: Request }) => Promise<NextResponse>
) {
  return async function handler(request: Request, context: RouteContext): Promise<NextResponse> {
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

export function createChannelLocalizationsHandlers(deps: ChannelLocalizationsRouteDeps) {
  return {
    /** The stored set, the baseline and the last apply (local only). */
    GET: channelLocalizationsHandler(deps, async ({ core, channelId }) => NextResponse.json(await core.view(channelId))),
    /** Replaces the stored set (`{ localizations }`; `{}` clears). Local only; refused whole with `details.refused`. */
    PUT: channelLocalizationsHandler(deps, async ({ core, channelId, request }) => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
      }
      const localizations = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).localizations : undefined;
      return NextResponse.json(await core.save(channelId, localizations, "owner"));
    }),
    /** What «Применить» would do now (a 1-unit read; nothing is written). */
    PREVIEW: channelLocalizationsHandler(deps, async ({ core, channelId }) => NextResponse.json(await core.preview(channelId))),
    /** The owner's «Применить»: the only path from this app to a channel's translations on YouTube. */
    APPLY: channelLocalizationsHandler(deps, async ({ core, channelId, userId }) => NextResponse.json(await core.apply(channelId, { userId }))),
  };
}
