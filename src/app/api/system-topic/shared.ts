import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { isDomainError } from "@/lib/shared-domain";
import type { SystemTopic } from "@/lib/system-topic";

// BL-228 (SYSTEM_TOPIC_PLAN.md §2 item 3, ADR 0053): the owner's routes for Settings → «System (Telegram)». Every handler: a Web
// session (401, the module is not called), a thin call into the module, DomainError -> status. Mutating methods pass `src/proxy.ts`'s
// device mutation gate like every /api route. No response ever carries the bot token: the module's view has only `hasToken`.

export type SystemTopicRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: () => Pick<SystemTopic, "view" | "saveSettings" | "setToken" | "clearToken">;
};

export async function defaultSystemTopicRouteDeps(): Promise<SystemTopicRouteDeps> {
  const { createSystemTopicCore } = await import("@/lib/system-topic");
  return { getSession: () => getServerSession(authOptions), core: createSystemTopicCore };
}

type Run = (args: { core: ReturnType<SystemTopicRouteDeps["core"]>; request: Request }) => Promise<NextResponse>;

function handler(deps: () => Promise<SystemTopicRouteDeps> | SystemTopicRouteDeps, run: Run) {
  return async function route(request: Request): Promise<NextResponse> {
    const resolved = await deps();
    const session = await resolved.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return await run({ core: resolved.core(), request });
    } catch (error) {
      if (isDomainError(error)) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: "The System topic settings could not be handled" }, { status: 500 });
    }
  };
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const invalidBody = () => NextResponse.json({ error: "validation_failed", message: "Request body must be a JSON object" }, { status: 400 });

export function createSystemTopicHandlers(deps: () => Promise<SystemTopicRouteDeps> | SystemTopicRouteDeps) {
  return {
    /** The settings, `hasToken`, the poll state and the last 20 commands. */
    GET: handler(deps, async ({ core }) => NextResponse.json(await core.view())),
    /** `{ ownerUserId, chatId, threadId, listening, commandsPath }`; 409 system_topic_needs_service / system_topic_incomplete. */
    PUT: handler(deps, async ({ core, request }) => {
      const body = await jsonBody(request);
      if (!body) return invalidBody();
      return NextResponse.json(await core.saveSettings(body));
    }),
    /** `{ token }` -- stored in this computer's device secrets; the answer is the view (never the token). */
    PUT_TOKEN: handler(deps, async ({ core, request }) => {
      const body = await jsonBody(request);
      if (!body) return invalidBody();
      return NextResponse.json(await core.setToken(body));
    }),
    DELETE_TOKEN: handler(deps, async ({ core }) => NextResponse.json(await core.clearToken())),
  };
}
