import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { isLoopbackRequest } from "@/lib/loopback-guard";
import { isDomainError } from "@/lib/shared-domain";
import type { SystemTopicCore } from "@/lib/system-topic";

// BL-228 (SYSTEM_TOPIC_PLAN.md, ADR 0053 Amendment 1): the System topic's routes.
// - The owner's (Settings → AI agent → «System (Telegram)»): a Web session (401, the module is not called).
// - The hub's relay (FO-RESP-0043 H1): loopback only (403), then `Authorization: Bearer <relay secret>` (401), no Web session.
// DomainError -> its status. A 500 never carries the exception's text. No response carries the relay secret except the one that
// generates it.

export type SystemTopicRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: () => SystemTopicCore;
  isLoopback: (headers: Headers) => boolean;
  /** Whether the database may be written now (the outbox GET marks messages delivered; GETs skip src/proxy.ts's gate). */
  mayWrite: () => Promise<boolean>;
};

export async function defaultSystemTopicRouteDeps(): Promise<SystemTopicRouteDeps> {
  const [{ getSystemTopicCore }, { rawSqlClient }, { assertDeviceAvailableForMutation }] = await Promise.all([
    import("@/composition/system-topic-approvals"),
    import("@/lib/db"),
    import("@/lib/device-mutation-gate"),
  ]);
  return {
    getSession: () => getServerSession(authOptions),
    core: getSystemTopicCore,
    isLoopback: isLoopbackRequest,
    mayWrite: () => assertDeviceAvailableForMutation(rawSqlClient).then(() => true, () => false),
  };
}

type Resolve = () => Promise<SystemTopicRouteDeps> | SystemTopicRouteDeps;
type Run<C> = (args: { core: SystemTopicCore; request: Request; context: C; deps: SystemTopicRouteDeps }) => Promise<NextResponse>;

function failure(error: unknown): NextResponse {
  if (isDomainError(error)) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  // Logged here only (the relay secret never enters an error); the answer stays generic.
  console.error(`[system-topic] ${error instanceof Error ? error.message : String(error)}`);
  return NextResponse.json({ error: "internal_error", message: "The System topic request could not be handled" }, { status: 500 });
}

/** An owner route: a Web session first. */
function ownerHandler<C = unknown>(resolve: Resolve, run: Run<C>) {
  return async function route(request: Request, context: C): Promise<NextResponse> {
    const deps = await resolve();
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return await run({ core: deps.core(), request, context, deps });
    } catch (error) {
      return failure(error);
    }
  };
}

/** A relay route: loopback, then the bearer secret. */
function relayHandler(resolve: Resolve, run: Run<unknown>) {
  return async function route(request: Request): Promise<NextResponse> {
    const deps = await resolve();
    if (!deps.isLoopback(request.headers)) return NextResponse.json({ error: "forbidden_not_loopback", message: "Only this computer may call the relay" }, { status: 403 });
    try {
      const core = deps.core();
      if (!(await core.topic.verifyRelayAuthorization(request.headers.get("authorization")))) {
        return NextResponse.json({ error: "unauthorized", message: "Missing or wrong relay secret" }, { status: 401 });
      }
      return await run({ core, request, context: undefined, deps });
    } catch (error) {
      return failure(error);
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
type IdContext = { params: Promise<{ id: string }> };

export function createSystemTopicHandlers(resolve: Resolve) {
  const fullView = async (core: SystemTopicCore) => ({ ...(await core.topic.view()), requests: await core.approvals.list() });
  return {
    /** The settings, the relay secret's state (never the secret), the counters, the last 20 commands and the requests. */
    GET: ownerHandler(resolve, async ({ core }) => NextResponse.json(await fullView(core))),
    /** `{ ownerUserId, chatId, threadId, enabled, requestsPath }`; 409 system_topic_needs_service / system_topic_incomplete. */
    PUT: ownerHandler(resolve, async ({ core, request }) => {
      const body = await jsonBody(request);
      if (!body) return invalidBody();
      await core.topic.saveSettings(body);
      return NextResponse.json(await fullView(core));
    }),
    /** A new relay secret, shown this once: `{ secret, view }`. The previous secret stops working. */
    POST_RELAY_SECRET: ownerHandler(resolve, async ({ core }) => {
      const { secret } = await core.topic.generateRelaySecret();
      return NextResponse.json({ secret, view: await fullView(core) }, { headers: { "cache-control": "no-store" } });
    }),
    /** The owner's Confirm (runs the approved request once): `{ request, view }`; 404 / 409 system_topic_request_state. */
    POST_CONFIRM: ownerHandler<IdContext>(resolve, async ({ core, context }) => {
      const { id } = await context.params;
      const request = await core.approvals.confirm(id);
      return NextResponse.json({ request, view: await fullView(core) });
    }),
    /** The owner's Deny of a request not yet confirmed. */
    POST_DENY: ownerHandler<IdContext>(resolve, async ({ core, context }) => {
      const { id } = await context.params;
      const request = await core.approvals.deny(id);
      return NextResponse.json({ request, view: await fullView(core) });
    }),
    /** The hub relays one message: `{ replies: string[] }` (empty for a dropped or repeated message). */
    POST_INBOUND: relayHandler(resolve, async ({ core, request }) => {
      const body = await jsonBody(request);
      if (!body) return invalidBody();
      return NextResponse.json(await core.topic.handleInbound(body));
    }),
    /** The queued messages, each handed out once: `{ messages: [{ id, text }] }`. */
    GET_OUTBOX: relayHandler(resolve, async ({ core, deps }) => {
      if (!(await deps.mayWrite())) return NextResponse.json({ error: "device_unavailable", message: "The database is busy (an import, a migration or recovery mode); try again" }, { status: 503 });
      return NextResponse.json(await core.topic.takeOutbox(), { headers: { "cache-control": "no-store" } });
    }),
  };
}
