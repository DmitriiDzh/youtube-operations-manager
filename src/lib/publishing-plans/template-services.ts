// BL-267 (WEEK_TEMPLATE_PLAN.md §3.3, ADR 0073 §1): what the owner, the Producer and the agents may do with a channel's week template.
// The owner (Web UI only) edits (a new version + its approval in one change), accepts or rejects a proposal, withdraws; the Producer
// only proposes; every agent reads. The decision functions are built into the owner surface only (index.ts), so no MCP path holds one.
import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import type { PublishingPlanTemplateDecision, PublishingPlanTemplateVersion } from "@/lib/sync-gateway";
import { isValidIanaTimezone } from "@/lib/zoned-time";
import { DomainError, type PublishingPlansPorts } from "./contracts";
import { contentOfVersion, nextTemplateSeq, pendingProposal, TEMPLATE_MATCH_RULES, templateHashOf, templateInForce, templateViewOf, validateTemplate, type WeekTemplateContent, type WeekTemplateView } from "./template";

export const templateDecisionInputSchema = z
  .object({ action: z.enum(["accept", "reject"]), versionId: z.string().min(1).max(40), contentHash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
export const templateSaveInputSchema = z.object({ template: z.unknown(), basedOn: z.string().min(1).max(40).optional() }).strict();

/** What every reader gets (`*_publishing_template_get`, the owner's screen). */
export type TemplateAnswer = {
  template: WeekTemplateView | null;
  proposal: WeekTemplateView | null;
  matchRules: typeof TEMPLATE_MATCH_RULES;
};

export function createTemplateServices(ports: PublishingPlansPorts, assertChannel: (channelId: string) => Promise<void>) {
  const stamp = () => ports.now().toISOString();

  function refused(refusals: unknown[]): DomainError {
    return new DomainError({ code: "validation_failed", message: `The template was refused: ${refusals.map((r) => JSON.stringify(r)).join("; ")}`, details: { refused: refusals } });
  }

  function parse(channelId: string, input: unknown): WeekTemplateContent {
    const result = validateTemplate(input, channelId, isValidIanaTimezone);
    if (!result.ok) throw refused(result.refused);
    return result.content;
  }

  async function get(channelId: string): Promise<TemplateAnswer> {
    const snapshot = await ports.store.read(channelId);
    const inForce = templateInForce(snapshot);
    const proposal = pendingProposal(snapshot);
    return { template: inForce ? templateViewOf(channelId, inForce.version) : null, proposal: proposal ? templateViewOf(channelId, proposal) : null, matchRules: TEMPLATE_MATCH_RULES };
  }

  function version(content: WeekTemplateContent, by: "owner" | "producer", device: string | null, seq: number, basedOn?: string): PublishingPlanTemplateVersion {
    return { id: `tv_${ports.randomId()}`.slice(0, 40), format: "week-template/1", days: content.days, horizonWeeks: content.horizonWeeks, displayTimeZone: content.displayTimeZone, contentHash: templateHashOf(content), by, device, at: stamp(), seq, ...(basedOn ? { basedOn } : {}) };
  }

  function decision(v: Pick<PublishingPlanTemplateVersion, "id" | "contentHash">, kind: PublishingPlanTemplateDecision["kind"], device: string | null, seq: number): PublishingPlanTemplateDecision {
    return { id: `td_${ports.randomId()}`.slice(0, 40), versionId: v.id, contentHash: v.contentHash, kind, by: "owner", device, at: stamp(), seq };
  }

  async function audit(channelId: string, detail: Record<string, unknown>) {
    await ports.audit({ channelId, weekStart: null, slotId: null, detail: { at: stamp(), ...detail } });
  }

  return {
    get: async (channelId: string): Promise<TemplateAnswer> => {
      await assertChannel(channelId);
      return get(channelId);
    },

    /** The owner's edit (AC-WT-04): one new version and its `approved` decision in ONE change; the same content again writes nothing. */
    async ownerSave(channelId: string, input: unknown, userId: string): Promise<TemplateAnswer & { changed: boolean }> {
      const parsed = parseWithSchema(templateSaveInputSchema, input, "week template");
      const content = parse(channelId, parsed.template);
      return ports.withLock(async () => {
        const snapshot = await ports.store.read(channelId);
        const inForce = templateInForce(snapshot);
        if (inForce && inForce.version.contentHash === templateHashOf(content)) return { ...(await get(channelId)), changed: false };
        const device = await ports.deviceLabel();
        const seq = nextTemplateSeq(snapshot);
        const v = version(content, "owner", device, seq, parsed.basedOn && snapshot.templateVersions?.[parsed.basedOn] ? parsed.basedOn : undefined);
        const d = decision(v, "approved", device, seq);
        await ports.store.addTemplateRecords(channelId, { versions: [v], decisions: [d] });
        await audit(channelId, { event: "publishing_plan.template_approved", versionId: v.id, decisionId: d.id, contentHash: v.contentHash, previous: inForce?.version.id ?? null, basedOn: v.basedOn ?? null, by: userId, device });
        ports.notifyOwnerDecision?.();
        return { ...(await get(channelId)), changed: true };
      });
    },

    /** The owner accepts or rejects a version he was shown (its hash): a proposal, or an older version brought back. */
    async ownerDecide(channelId: string, input: unknown, userId: string): Promise<TemplateAnswer> {
      const parsed = parseWithSchema(templateDecisionInputSchema, input, "template decision");
      return ports.withLock(async () => {
        const snapshot = await ports.store.read(channelId);
        const v = snapshot.templateVersions?.[parsed.versionId];
        if (!v) throw new DomainError({ code: "publishing_plan_template_not_found", message: "No such template version", details: { channelId, versionId: parsed.versionId } });
        if (v.contentHash !== parsed.contentHash || templateHashOf(contentOfVersion(v)) !== v.contentHash) {
          throw new DomainError({ code: "publishing_plan_changed", message: "The template changed since it was shown; reload", details: { channelId, versionId: parsed.versionId } });
        }
        const device = await ports.deviceLabel();
        const d = decision(v, parsed.action === "accept" ? "approved" : "rejected", device, nextTemplateSeq(snapshot));
        await ports.store.addTemplateRecords(channelId, { decisions: [d] });
        await audit(channelId, { event: parsed.action === "accept" ? "publishing_plan.template_approved" : "publishing_plan.template_rejected", versionId: v.id, decisionId: d.id, contentHash: v.contentHash, proposedBy: v.by, by: userId, device });
        ports.notifyOwnerDecision?.();
        return get(channelId);
      });
    },

    /** «Даты по шаблону» off: nothing is dated by the template until the owner approves one again (dates on YouTube stay). */
    async ownerWithdraw(channelId: string, userId: string): Promise<TemplateAnswer & { changed: boolean }> {
      return ports.withLock(async () => {
        const snapshot = await ports.store.read(channelId);
        const inForce = templateInForce(snapshot);
        if (!inForce) return { ...(await get(channelId)), changed: false };
        const device = await ports.deviceLabel();
        const d = decision(inForce.version, "withdrawn", device, nextTemplateSeq(snapshot));
        await ports.store.addTemplateRecords(channelId, { decisions: [d] });
        await audit(channelId, { event: "publishing_plan.template_withdrawn", versionId: inForce.version.id, decisionId: d.id, by: userId, device });
        ports.notifyOwnerDecision?.();
        return { ...(await get(channelId)), changed: true };
      });
    },

    /** The Producer's proposal (AC-WT-03): a version without a decision; the same as in force, or as the pending proposal, writes nothing. */
    async propose(channelId: string, input: unknown): Promise<TemplateAnswer & { proposed: boolean }> {
      await assertChannel(channelId);
      const content = parse(channelId, input);
      return ports.withLock(async () => {
        const snapshot = await ports.store.read(channelId);
        const hash = templateHashOf(content);
        if (templateInForce(snapshot)?.version.contentHash === hash || pendingProposal(snapshot)?.contentHash === hash) return { ...(await get(channelId)), proposed: false };
        const v = version(content, "producer", await ports.deviceLabel(), nextTemplateSeq(snapshot));
        await ports.store.addTemplateRecords(channelId, { versions: [v] });
        await audit(channelId, { event: "publishing_plan.template_proposed", versionId: v.id, contentHash: v.contentHash, by: "producer" });
        return { ...(await get(channelId)), proposed: true };
      });
    },
  };
}

export type TemplateServices = ReturnType<typeof createTemplateServices>;
