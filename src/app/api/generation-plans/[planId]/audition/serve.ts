import path from "node:path";
import { NextResponse } from "next/server";
import { parseRange, streamLocalFile } from "@/lib/local-file-response";
import { isLoopbackRequest } from "@/lib/loopback-guard";
import { AUDITION_CONTENT_TYPES, auditionContentType } from "@/lib/generation-plans/contracts";
import { planErrorResponse } from "../../shared";

// BL-143 (ADR 0029 decision 5, AC-GP-14): the one route that sends a local media file to the browser -- the file of ONE
// attempt of ONE plan, found by the plans core (never a path from the request), proven inside the channel workspace by
// `workspace-exchange` (symlinks resolved), of an allowlisted type, with HTTP Range so the player can seek.

/** The types the review screen plays or shows; anything else is refused (415). BL-173: the list lives in the plans contracts. */
export { AUDITION_CONTENT_TYPES };

// Range parsing and streaming live in `@/lib/local-file-response` (shared with the storyboard takes, BL-184); re-exported for this
// route's own tests.
export { parseRange };

export function contentTypeFor(filePath: string): string | null {
  return auditionContentType(filePath);
}

export type AuditionDeps = {
  getSession(): Promise<{ user?: { id?: string | null } } | null>;
  /** BL-157 (AC-SM-03): refuses (plan_not_found) a plan that is not the session's active channel's. */
  assertVisible(userId: string, planId: string): Promise<void>;
  resolveAudition(input: { planId: string; itemKey: string; attemptRef: string }): Promise<{ channelId: string } & ({ kind: "sent"; relativePath: string } | { kind: "job"; jobId: string; localPath: string })>;
  /** The channel's workspace folder on this device, or null. */
  workspaceOf(channelId: string): Promise<string | null>;
  /** `workspace-exchange` resolvers, wired in the route. */
  resolveSentFile(workspace: string, relativePath: string): Promise<{ path: string; bytes: number }>;
  resolveJobFile(workspace: string, jobId: string, filePath: string): Promise<{ path: string; bytes: number }>;
};

type ResolvedTarget = { channelId: string } & ({ kind: "sent"; relativePath: string } | { kind: "job"; jobId: string; localPath: string });

/** The audition of one attempt: `?itemKey=&attemptRef=` (nothing else). */
export function createAuditionGetHandler(deps: AuditionDeps) {
  return createPlanFileGetHandler(deps, ["itemKey", "attemptRef"], (planId, q) => deps.resolveAudition({ planId, itemKey: q.itemKey, attemptRef: q.attemptRef }));
}

/** BL-143 phase 3 (FO-MSG-0009): a plan reference for A/B, `?id=` -- the same checks, Range and types as an audition. */
export function createReferenceGetHandler(deps: Omit<AuditionDeps, "resolveAudition"> & { resolveReference(input: { planId: string; id: string }): Promise<ResolvedTarget> }) {
  return createPlanFileGetHandler(deps, ["id"], (planId, q) => deps.resolveReference({ planId, id: q.id }));
}

/** BL-173 (PLAN_RECHECKS_PLAN.md §2.4): a re-check's file, `?recheckId=` -- the revised file, or the attempt's current one. */
export function createRecheckAuditionGetHandler(deps: Omit<AuditionDeps, "resolveAudition"> & { resolveRecheck(input: { planId: string; recheckId: string }): Promise<ResolvedTarget> }) {
  return createPlanFileGetHandler(deps, ["recheckId"], (planId, q) => deps.resolveRecheck({ planId, recheckId: q.recheckId }));
}

/**
 * BL-175 (VISUAL_REVIEW_PLAN.md §2.7): a small JPEG preview of an IMAGE attempt for the review grid, `?itemKey=&attemptRef=` --
 * the attempt's file found and proven exactly as its audition is (loopback, session, active channel, workspace proof); anything
 * that is not an image is 415. When no preview can be made, the original image is sent instead (the grid scales it).
 */
export function createPreviewGetHandler(deps: AuditionDeps & { preview(path: string): Promise<Uint8Array | null> }) {
  return createPlanFileGetHandler(
    deps,
    ["itemKey", "attemptRef"],
    (planId, q) => deps.resolveAudition({ planId, itemKey: q.itemKey, attemptRef: q.attemptRef }),
    async (file, type, request) => {
      if (!type.startsWith("image/")) return NextResponse.json({ error: "unsupported_media_type", message: "Only an image has a preview" }, { status: 415 });
      const body = await deps.preview(file.path);
      if (!body) return streamFile(file, type, request);
      return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(body.byteLength), "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }
  );
}

const streamFile = streamLocalFile;

type Responder = (file: { path: string; bytes: number }, type: string, request: Request) => Response | Promise<Response>;

function createPlanFileGetHandler(
  deps: Omit<AuditionDeps, "resolveAudition">,
  names: string[],
  resolveTarget: (planId: string, query: Record<string, string>) => Promise<ResolvedTarget>,
  respond: Responder = streamFile
) {
  return async function GET(request: Request, context: { params: Promise<{ planId: string }> }): Promise<Response> {
    // A local file leaves this route only for a browser on this computer (ADR 0029 §5): loopback Host and Origin.
    if (!isLoopbackRequest(request.headers)) return NextResponse.json({ error: "forbidden", message: "Local files are served only to this computer" }, { status: 403 });
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { planId } = await context.params;
      await deps.assertVisible(userId, planId);
      const url = new URL(request.url);
      const extra = [...url.searchParams.keys()].filter((k) => !names.includes(k));
      if (extra.length > 0) return NextResponse.json({ error: "validation_failed", message: `Unknown query parameter ${extra[0]}: only ${names.join(" and ")}` }, { status: 400 });
      const query: Record<string, string> = {};
      for (const name of names) {
        const value = url.searchParams.get(name);
        if (!value) return NextResponse.json({ error: "validation_failed", message: `${names.join(" and ")} ${names.length > 1 ? "are" : "is"} required` }, { status: 400 });
        query[name] = value;
      }
      const target = await resolveTarget(planId, query);
      const workspace = await deps.workspaceOf(target.channelId);
      if (!workspace) return NextResponse.json({ error: "not_found", message: "This channel has no workspace folder on this device, so the file cannot be played here." }, { status: 404 });
      let file: { path: string; bytes: number };
      try {
        file = target.kind === "sent" ? await deps.resolveSentFile(workspace, target.relativePath) : await deps.resolveJobFile(workspace, target.jobId, target.localPath);
      } catch (error) {
        return NextResponse.json({ error: "not_found", message: `The file is not available on this device: ${error instanceof Error ? error.message : String(error)}` }, { status: 404 });
      }
      const type = contentTypeFor(file.path);
      if (!type) return NextResponse.json({ error: "unsupported_media_type", message: `${path.extname(file.path) || "This file type"} is not played here` }, { status: 415 });
      return await respond(file, type, request);
    } catch (error) {
      return planErrorResponse(error);
    }
  };
}
