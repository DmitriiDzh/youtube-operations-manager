import { createPublishingPlansAgentCore, isMusicTemplate, type WeekTemplateView } from "@/lib/publishing-plans";
import { publishingPlanProgress } from "@/lib/publishing-plan-progress";
import { DomainError } from "@/lib/shared-domain";
import { createWeeklyBuildCore, type WeeklyBuildStarted, type WeeklyTemplateCollect } from "@/lib/weekly-build";

// BL-267 (WEEK_TEMPLATE_PLAN.md §3.9, ADR 0073 §7; owner O7, agreed with the Operator): «Собрать неделю по шаблону», composed at the app
// layer -- the weekly-build module runs the factory's launcher, the publishing-plans module owns the template and the plan's save;
// neither imports the other (AGENTS.md §M).

/** The template as the card needs it: in force or not, and whether it is a music template (the card shows only then). */
export async function weeklyTemplateState(channelId: string): Promise<{ inForce: boolean; music: boolean; template: WeekTemplateView | null }> {
  const { template } = await createPublishingPlansAgentCore().templateGet(channelId);
  return { inForce: template !== null, music: template !== null && isMusicTemplate(template.days), template };
}

/**
 * Writes the template in force -- the same serializer as `factory_publishing_template_get`'s `template` (AC-WT-47) -- and starts
 * `13 Weekly_Plan v1 auto --template [--week W]`. No template in force: `weekly_build_no_template`, nothing runs.
 */
export async function startWeeklyBuildByTemplate(channelId: string, week: string | null): Promise<WeeklyBuildStarted> {
  const { template } = await weeklyTemplateState(channelId);
  if (!template) throw new DomainError({ code: "weekly_build_no_template", message: "No week template is in force for this channel.", details: { channelId } });
  return createWeeklyBuildCore().startByTemplate(channelId, { templateJson: `${JSON.stringify(template, null, 2)}\n`, week });
}

/** A finished template build's payloads, saved as the factory with the plan's own checks (one payload of another channel is refused). */
export async function collectWeeklyTemplateBuild(channelId: string): Promise<WeeklyTemplateCollect | null> {
  const plans = createPublishingPlansAgentCore(publishingPlanProgress);
  return createWeeklyBuildCore().collectTemplateBuild(channelId, async (payload) => {
    if ((payload as { channelId?: unknown } | null)?.channelId !== channelId) {
      throw new DomainError({ code: "validation_failed", message: "The payload names another channel", details: { refused: [{ field: "channelId", reason: "channel_mismatch" }] } });
    }
    // Durable across restarts (the collected-job memory is per process): a week that already has a plan is never saved over by a
    // job's payload -- the owner's or the Producer's moves since stay as they are.
    const weekStart = (payload as { weekStart?: unknown }).weekStart;
    const exists = await plans.get({ channelId, weekStart }).then(
      () => true,
      (error: unknown) => ((error as { code?: unknown })?.code === "publishing_plan_not_found" ? false : Promise.reject(error))
    );
    if (exists) throw new DomainError({ code: "validation_failed", message: "That week already has a plan", details: { refused: [{ field: "weekStart", reason: "week_has_plan" }] } });
    await plans.save(payload, "factory");
  });
}
