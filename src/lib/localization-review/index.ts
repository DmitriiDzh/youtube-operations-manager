// BL-227 (docs/roadmap/plans/LANGUAGES_REVIEW_PLAN.md, ADR 0052): translation review by video -- agents' check reports and the
// review read model. A feature module (AGENTS.md §M): it reads change sets through `changesets`/`sync-gateway` and checks through
// `shared-localization-checks`; nothing else depends on it.
import { createChangeDraftsCoreForProduction } from "@/lib/sync-gateway";
import { reportChecks } from "./report";

export { reportChecksInputSchema, type ReportChecksInput } from "./report";

/** An agent's check report on a change set of `channelId` (the set must be that channel's: `not_found` otherwise). */
export async function reportLocalizationChecks(input: unknown, by: "factory" | "worker") {
  const drafts = createChangeDraftsCoreForProduction();
  return reportChecks({ addCheckReport: (report) => drafts.addCheckReport(report) }, input, by);
}
