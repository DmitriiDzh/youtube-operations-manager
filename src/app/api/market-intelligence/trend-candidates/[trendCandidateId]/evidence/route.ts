import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type TrendEvidenceRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "getTrendEvidenceSummary" | "recordTrendEvidence">;
};

const defaultDeps: TrendEvidenceRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createMarketIntelligenceCore(),
};

// Factory shape (mirrors src/app/api/youtube/create-playlist/route.ts) so a test can inject a
// fake `core` that still validates through the REAL zod schema -- found necessary by independent
// code review: an earlier fix here was "verified" only against a hand-rolled toy schema, not the
// actual `recordTrendEvidenceInputSchema`, and this route had no test of its own at all despite
// being the one place a real regression (the `referenceId: undefined` strict-schema bug) shipped.
//
// GET switched to `getTrendEvidenceSummary` in Phase 9 slice 9H, part A
// (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md §6) -- newest-first evidence plus an
// independent-supporting-channel count; `listTrendEvidence` itself (no MCP/CLI caller, confirmed by
// grep) keeps its own ascending order unchanged for any future caller that wants it directly.
export function createTrendEvidenceGetHandler(deps: TrendEvidenceRouteDeps = defaultDeps) {
  return async function GET(_request: Request, { params }: { params: Promise<{ trendCandidateId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const { trendCandidateId } = await params;
      const result = await deps.core.getTrendEvidenceSummary({ trendCandidateId });
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json(
          { error: error.code, message: error.message, details: error.details },
          { status: getVideoMetadataErrorStatus(error.code) }
        );
      }
      return NextResponse.json(
        { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 }
      );
    }
  };
}

// Records an additional observation against an existing trend candidate without changing its
// status (e.g. another supporting channel/video, or a plain signal note).
export function createTrendEvidencePostHandler(deps: TrendEvidenceRouteDeps = defaultDeps) {
  return async function POST(request: Request, { params }: { params: Promise<{ trendCandidateId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
      }
      // A well-formed-but-non-object body (e.g. a literal `null`) parses fine as JSON, so it must be
      // handled here rather than destructured directly (found by independent code review).
      const bodyRecord = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

      const { trendCandidateId } = await params;
      // referenceId must be omitted entirely (not merely `undefined`) when the body doesn't send it --
      // the "signal" branch of recordTrendEvidenceInputSchema is `.strict()` with no referenceId key at
      // all, and zod's `.strict()` treats an own key whose value is `undefined` as an unrecognized key,
      // rejecting every "signal" submission outright (found by independent code review).
      const evidence = await deps.core.recordTrendEvidence(
        {
          trendCandidateId,
          evidenceType: bodyRecord.evidenceType,
          description: bodyRecord.description,
          ...(bodyRecord.referenceId !== undefined ? { referenceId: bodyRecord.referenceId } : {}),
        },
        { createdVia: "web_ui" }
      );
      return NextResponse.json({ evidence }, { status: 201 });
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json(
          { error: error.code, message: error.message, details: error.details },
          { status: getVideoMetadataErrorStatus(error.code) }
        );
      }
      return NextResponse.json(
        { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 }
      );
    }
  };
}

export const GET = createTrendEvidenceGetHandler();
export const POST = createTrendEvidencePostHandler();
