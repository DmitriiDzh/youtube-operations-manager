// BL-227 (docs/roadmap/plans/LANGUAGES_REVIEW_PLAN.md §5, ADR 0052): an agent's check report on a change set -- the agents' only way
// into this feature. It adds a report (the newest is current); it never approves, rejects or sends anything (AGENTS.md §G).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError } from "@/lib/shared-domain";

export const reportChecksInputSchema = z
  .object({
    channelId: z.string().min(1).max(64),
    changeSetId: z.string().min(1).max(64),
    entries: z
      .array(
        z
          .object({
            language: z.string().min(1).max(35),
            field: z.enum(["title", "description"]),
            verdict: z.enum(["pass", "warn", "fail"]),
            checks: z
              .array(z.object({ id: z.string().min(1).max(64), result: z.enum(["pass", "warn", "fail"]), detail: z.string().max(500) }).strict())
              .max(50),
            note: z.string().max(1000).optional(),
            backTranslation: z.string().max(6000).optional(),
          })
          .strict()
      )
      .min(1)
      .max(200),
  })
  .strict();
export type ReportChecksInput = z.infer<typeof reportChecksInputSchema>;

export type ReportChecksDeps = {
  addCheckReport(input: {
    channelId: string;
    id: string;
    changeSetId: string;
    reportedBy: "factory" | "worker";
    entries: ReportChecksInput["entries"];
  }): Promise<{ report: { id: string; reportedAt: string }; replacedId: string | null }>;
  newId?: () => string;
};

export async function reportChecks(deps: ReportChecksDeps, input: unknown, by: "factory" | "worker"): Promise<{ reportId: string; reportedAt: string; replaced: string | null }> {
  const parsed = reportChecksInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError({ code: "validation_failed", message: "Invalid check report", details: { issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), message: issue.message })) } });
  }
  const { report, replacedId } = await deps.addCheckReport({
    channelId: parsed.data.channelId,
    id: (deps.newId ?? randomUUID)(),
    changeSetId: parsed.data.changeSetId,
    reportedBy: by,
    entries: parsed.data.entries,
  });
  return { reportId: report.id, reportedAt: report.reportedAt, replaced: replacedId };
}
