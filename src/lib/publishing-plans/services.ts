import { parseWithSchema } from "@/lib/shared-domain";
import type { PublishingPlanDecision, PublishingPlanMeta, PublishingPlanSlot, PublishingPlansSnapshot } from "@/lib/sync-gateway";
import { isValidIanaTimezone } from "@/lib/zoned-time";
import { DomainError, PUBLISHING_PLAN_LIMITS, type PlanSaveRefusal, type PlanSummary, type PlanView, type PublishingPlanActor, type PublishingPlansPorts } from "./contracts";
import { addDays, contentHashOf, contentOf, decisionStateOf, instantOf, isCalendarDate, isMonday, planViewOf } from "./model";
import { getPlanInputSchema, listPlansInputSchema, ownerDecisionInputSchema, savePlanInputSchema } from "./schemas";

// BL-225 (FO-REQ-0040 items 1, 5, 6; WEEKLY_PUBLISHING_PLAN.md stage 1 items 3-5; ADR 0051): what agents and the owner may do with a
// plan. Agents (the Factory Operator, a channel's worker) save, get and list; the owner approves, revokes, vetoes and restores. The
// two surfaces are built separately (`agentSurface`, `ownerSurface`) so no MCP path can hold a decision function.

const refusedError = (refused: PlanSaveRefusal[], weekStart: string) =>
  new DomainError({ code: "validation_failed", message: `The plan was not saved: ${refused.map((r) => `${r.slotId ? `${r.slotId} ` : ""}${r.field}: ${r.reason}`).join("; ")}`, details: { weekStart, refused } });

export function createPublishingPlansService(ports: PublishingPlansPorts) {
  const stamp = () => ports.now().toISOString();

  async function assertChannel(channelId: string): Promise<void> {
    if (!(await ports.isChannelConnected(channelId))) {
      throw new DomainError({ code: "publishing_plan_channel_unavailable", message: "This channel is not connected on this computer", details: { channelId } });
    }
  }

  function slotsOf(snapshot: PublishingPlansSnapshot, weekStart: string): PublishingPlanSlot[] {
    return Object.values(snapshot.slots).filter((s) => s.weekStart === weekStart);
  }
  function decisionsOf(snapshot: PublishingPlansSnapshot, weekStart: string): PublishingPlanDecision[] {
    return Object.values(snapshot.decisions).filter((d) => d.weekStart === weekStart);
  }

  async function viewOf(channelId: string, snapshot: PublishingPlansSnapshot, meta: PublishingPlanMeta): Promise<PlanView> {
    const slots = slotsOf(snapshot, meta.weekStart);
    const progress = ports.progress ? await ports.progress(channelId, meta.weekStart, slots.map((s) => s.slotId)) : new Map();
    return planViewOf({ channelId, meta, slots, decisions: decisionsOf(snapshot, meta.weekStart), progress, now: ports.now() });
  }

  async function requirePlan(channelId: string, weekStart: string): Promise<{ snapshot: PublishingPlansSnapshot; meta: PublishingPlanMeta }> {
    const snapshot = await ports.store.read(channelId);
    const meta = snapshot.plans[weekStart];
    if (!meta) throw new DomainError({ code: "publishing_plan_not_found", message: "No plan for this week in this channel", details: { channelId, weekStart } });
    return { snapshot, meta };
  }

  async function list(channelId: string): Promise<PlanSummary[]> {
    const snapshot = await ports.store.read(channelId);
    const views = await Promise.all(Object.values(snapshot.plans).map((meta) => viewOf(channelId, snapshot, meta)));
    return views
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
      .map((view): PlanSummary => {
        const summary: Partial<PlanView> = { ...view };
        delete summary.slots;
        return summary as PlanSummary;
      });
  }

  /**
   * `*_publishing_plan_save`: the plan made or updated. Slots are given whole (an omitted `lengthHint` / `note` is none); a slot
   * not named is kept; `removeSlotIds` deletes. Every rule is checked first and any refusal saves nothing.
   */
  async function save(input: unknown, by: PublishingPlanActor): Promise<{ plan: PlanView; changed: string[]; unlocked: string[]; removed: string[] }> {
    const parsed = parseWithSchema(savePlanInputSchema, input, "publishing plan");
    const { channelId, weekStart } = parsed;
    return ports.withLock(async () => {
      await assertChannel(channelId);
      const now = ports.now();
      const refused: PlanSaveRefusal[] = [];
      if (!isCalendarDate(weekStart)) refused.push({ field: "weekStart", reason: "week_start_invalid" });
      else if (!isMonday(weekStart)) refused.push({ field: "weekStart", reason: "week_start_not_monday" });
      const snapshot = await ports.store.read(channelId);
      const existing = snapshot.plans[weekStart] ?? null;
      if (parsed.timeZone !== undefined && !isValidIanaTimezone(parsed.timeZone)) refused.push({ field: "timeZone", reason: "time_zone_invalid" });
      if (!existing && parsed.timeZone === undefined) refused.push({ field: "timeZone", reason: "time_zone_required" });
      if (refused.length > 0) throw refusedError(refused, weekStart);

      const timeZone = parsed.timeZone ?? existing!.timeZone;
      const weekEnd = addDays(weekStart, 6);
      const current = new Map(slotsOf(snapshot, weekStart).map((s) => [s.slotId, s]));
      const decisions = decisionsOf(snapshot, weekStart);
      const decisionsFor = (slotId: string) => decisions.filter((d) => d.slotId === slotId);
      const approvedNow = (slot: PublishingPlanSlot) => existing !== null && decisionStateOf(decisionsFor(slot.slotId), contentHashOf(existing.timeZone, contentOf(slot))).approved;

      const seen = new Set<string>();
      const upserts: PublishingPlanSlot[] = [];
      const changed: string[] = [];
      for (const input of parsed.slots ?? []) {
        if (seen.has(input.slotId)) {
          refused.push({ slotId: input.slotId, field: "slots", reason: "duplicate_slot" });
          continue;
        }
        seen.add(input.slotId);
        const content = contentOf({ date: input.date, publishAt: input.publishAt, lengthHint: input.lengthHint ?? null, note: input.note ?? null });
        const before = current.get(input.slotId);
        const same = before !== undefined && contentHashOf(existing!.timeZone, contentOf(before)) === contentHashOf(timeZone, content);
        if (same) continue; // unchanged: a no-op whatever its time
        if (!isCalendarDate(content.date)) {
          refused.push({ slotId: input.slotId, field: "date", reason: "date_invalid" });
          continue;
        }
        if (content.date < weekStart || content.date > weekEnd) {
          refused.push({ slotId: input.slotId, field: "date", reason: "outside_week" });
          continue;
        }
        const instant = instantOf(content.publishAt, timeZone);
        if (!instant) {
          refused.push({ slotId: input.slotId, field: "publishAt", reason: "publish_at_invalid" });
          continue;
        }
        if (content.publishAt.slice(0, 10) !== content.date) {
          refused.push({ slotId: input.slotId, field: "publishAt", reason: "date_mismatch" });
          continue;
        }
        if (instant.getTime() <= now.getTime()) {
          refused.push({ slotId: input.slotId, field: "publishAt", reason: "in_past" });
          continue;
        }
        upserts.push({ ...content, weekStart, slotId: input.slotId, createdAt: before?.createdAt ?? stamp(), updatedAt: stamp(), updatedBy: by });
        changed.push(input.slotId);
      }

      const removes: string[] = [];
      for (const slotId of new Set(parsed.removeSlotIds ?? [])) {
        const slot = current.get(slotId);
        if (!slot) refused.push({ slotId, field: "removeSlotIds", reason: "unknown_slot" });
        else if (approvedNow(slot)) refused.push({ slotId, field: "removeSlotIds", reason: "slot_approved" });
        else if (seen.has(slotId)) refused.push({ slotId, field: "removeSlotIds", reason: "duplicate_slot" });
        else removes.push(slotId);
      }

      const remaining = new Set([...current.keys(), ...upserts.map((s) => s.slotId)]);
      for (const slotId of removes) remaining.delete(slotId);
      if (remaining.size > PUBLISHING_PLAN_LIMITS.slots) refused.push({ field: "slots", reason: "too_many_slots" });
      if (refused.length > 0) throw refusedError(refused, weekStart);

      // A zone change re-times every slot: each one that was approved needs the owner again (its hash names the zone).
      const unlocked = existing
        ? [...current.values()]
            .filter((slot) => !removes.includes(slot.slotId) && approvedNow(slot))
            .filter((slot) => {
              const next = upserts.find((u) => u.slotId === slot.slotId) ?? slot;
              return contentHashOf(timeZone, contentOf(next)) !== contentHashOf(existing.timeZone, contentOf(slot));
            })
            .map((slot) => slot.slotId)
        : [];

      const zoneChanges = existing !== null && existing.timeZone !== timeZone;
      if (existing && upserts.length === 0 && removes.length === 0 && !zoneChanges) {
        return { plan: await viewOf(channelId, snapshot, existing), changed: [], unlocked: [], removed: [] };
      }
      const at = stamp();
      await ports.store.savePlan(channelId, {
        weekStart,
        create: existing ? null : { weekStart, timeZone, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by },
        ...(zoneChanges ? { timeZone } : {}),
        updatedAt: at,
        updatedBy: by,
        upserts,
        removes,
      });
      const after = await requirePlan(channelId, weekStart);
      return { plan: await viewOf(channelId, after.snapshot, after.meta), changed, unlocked, removed: removes };
    });
  }

  async function get(input: unknown): Promise<{ plan: PlanView }> {
    const { channelId, weekStart } = parseWithSchema(getPlanInputSchema, input, "publishing plan");
    await assertChannel(channelId);
    const { snapshot, meta } = await requirePlan(channelId, weekStart);
    return { plan: await viewOf(channelId, snapshot, meta) };
  }

  async function agentList(input: unknown): Promise<{ plans: PlanSummary[] }> {
    const { channelId } = parseWithSchema(listPlansInputSchema, input, "publishing plans");
    await assertChannel(channelId);
    return { plans: await list(channelId) };
  }

  /**
   * The owner's decision (Web UI only; ADR 0051 §3-§6). Approve: every slot named exists, still has the content shown, is not
   * vetoed and not released -- or nothing is approved. Revoke: the slot is approved with the content shown. Veto / restore: the
   * slot exists and is not released. A decision that changes nothing writes nothing.
   */
  async function decide(channelId: string, weekStart: string, input: unknown, userId: string): Promise<{ plan: PlanView; decided: string[] }> {
    const { action, slots } = parseWithSchema(ownerDecisionInputSchema, input, "decision");
    return ports.withLock(async () => {
      const { snapshot, meta } = await requirePlan(channelId, weekStart);
      const view = await viewOf(channelId, snapshot, meta);
      const byId = new Map(view.slots.map((s) => [s.slotId, s]));
      const refuse = (code: "publishing_plan_slot_not_found" | "publishing_plan_changed" | "publishing_plan_slot_vetoed" | "publishing_plan_slot_past", slotId: string, message: string) =>
        new DomainError({ code, message, details: { channelId, weekStart, slotId } });
      const targets = [];
      for (const named of slots) {
        const slot = byId.get(named.slotId);
        if (!slot) throw refuse("publishing_plan_slot_not_found", named.slotId, `No slot ${named.slotId} in this plan`);
        if (slot.released) throw refuse("publishing_plan_slot_past", named.slotId, `Slot ${named.slotId}'s time has passed`);
        if (action === "approve" || action === "revoke") {
          if (named.contentHash !== slot.contentHash) throw refuse("publishing_plan_changed", named.slotId, `Slot ${named.slotId} changed since it was shown; reload the plan`);
          if (action === "approve" && slot.vetoed) throw refuse("publishing_plan_slot_vetoed", named.slotId, `Slot ${named.slotId} is vetoed; restore it first`);
          if (action === "revoke" && slot.approval !== "approved") throw refuse("publishing_plan_changed", named.slotId, `Slot ${named.slotId} is not approved`);
        }
        targets.push(slot);
      }
      const kind = ({ approve: "approved", revoke: "revoked", veto: "vetoed", restore: "restored" } as const)[action];
      const effective = targets.filter((slot) =>
        action === "approve" ? slot.approval !== "approved" : action === "revoke" ? true : action === "veto" ? !slot.vetoed : Boolean(slot.vetoed)
      );
      if (effective.length > 0) {
        const device = await ports.deviceLabel();
        const at = stamp();
        const records: PublishingPlanDecision[] = effective.map((slot) => ({
          id: `pd_${ports.randomId()}`.slice(0, 40),
          weekStart,
          slotId: slot.slotId,
          kind,
          contentHash: slot.contentHash,
          snapshot: { date: slot.date, publishAt: slot.publishAt, lengthHint: slot.lengthHint, note: slot.note, timeZone: meta.timeZone },
          by: "owner",
          device,
          at,
        }));
        await ports.store.addDecisions(channelId, records);
        for (const record of records) {
          const slot = byId.get(record.slotId)!;
          await ports.audit({
            channelId,
            weekStart,
            slotId: record.slotId,
            detail: { event: `publishing_plan.${kind}`, at, decisionId: record.id, weekStart, slotId: record.slotId, contentHash: record.contentHash, publishAt: slot.publishAt, timeZone: meta.timeZone, publishAtUtc: slot.publishAtUtc, by: userId, device },
          });
        }
      }
      const after = await requirePlan(channelId, weekStart);
      return { plan: await viewOf(channelId, after.snapshot, after.meta), decided: effective.map((s) => s.slotId) };
    });
  }

  return {
    save,
    get,
    list: agentList,
    ownerList: async (channelId: string): Promise<{ plans: PlanSummary[]; waiting: number }> => {
      const plans = await list(channelId);
      return { plans, waiting: plans.reduce((sum, p) => sum + p.counts.needsApproval, 0) };
    },
    ownerGet: async (channelId: string, weekStart: string): Promise<{ plan: PlanView }> => {
      const { snapshot, meta } = await requirePlan(channelId, weekStart);
      return { plan: await viewOf(channelId, snapshot, meta) };
    },
    decide,
  };
}

export type PublishingPlansService = ReturnType<typeof createPublishingPlansService>;

/** What agents get (MCP): save, get, list -- never a decision (ADR 0051 §6, AC-WP-05). */
export type PublishingPlansAgentSurface = Pick<PublishingPlansService, "save" | "get" | "list">;
export function agentSurface(service: PublishingPlansAgentSurface): PublishingPlansAgentSurface {
  return { save: (input, by) => service.save(input, by), get: (input) => service.get(input), list: (input) => service.list(input) };
}

/** What the owner's Web UI routes get: the plans, one plan, and the decisions. */
export type PublishingPlansOwnerSurface = Pick<PublishingPlansService, "ownerList" | "ownerGet" | "decide">;
export function ownerSurface(service: PublishingPlansOwnerSurface): PublishingPlansOwnerSurface {
  return { ownerList: (channelId) => service.ownerList(channelId), ownerGet: (channelId, weekStart) => service.ownerGet(channelId, weekStart), decide: (channelId, weekStart, input, userId) => service.decide(channelId, weekStart, input, userId) };
}
