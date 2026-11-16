import { parseWithSchema } from "@/lib/shared-domain";
import type { PublishingPlanDecision, PublishingPlanMeta, PublishingPlanPackageFingerprint, PublishingPlanSlot, PublishingPlansSnapshot } from "@/lib/sync-gateway";
import { isValidIanaTimezone } from "@/lib/zoned-time";
import { isDeletedOnYoutube } from "@/lib/shared-video-presence";
import { DEFAULT_APPROVAL_STAGE, DomainError, PUBLISHING_PLAN_LIMITS, type PlanMoveResult, type PlanSaveRefusal, type PlanSlotDecision, type PlanProgressResult, type PlanSlotProgress, type PlanSummary, type PlanView, type PublishingPlanActor, type PublishingPlanApprovalStage, type PublishingPlansPorts, type ReplacedSlot, type SocialSlotState, SOCIAL_LOOKBACK_MS } from "./contracts";
import { addDays, approvalStandsOn, contentHashOf, contentOf, decisionsForStage, decisionStateOf, fingerprintOf, instantOf, isCalendarDate, isMonday, mediaOfProgress, planViewOf, slotViewOf, standingPackageApprovalOf, standingVetoOf, decisionOrder, lastApprovedPackageOf } from "./model";
import { matchSlots, templateInForce, type MatchSlot, type SlotMatch } from "./template";
import { createTemplateServices } from "./template-services";
import { moveSlotInputSchema } from "./schemas";
import { approvalStageInputSchema, getPlanInputSchema, listPlansInputSchema, ownerDecisionInputSchema, ownerRetimeInputSchema, PLAN_LIST_DEFAULT_LIMIT, savePlanInputSchema, type OwnerDecisionInput } from "./schemas";

// BL-225 (FO-REQ-0040 items 1, 5, 6; WEEKLY_PUBLISHING_PLAN.md stage 1 items 3-5; ADR 0051): what agents and the owner may do with a
// plan. Agents (the Factory Operator, a channel's worker) save, get and list; the owner approves, revokes, vetoes and restores. The
// two surfaces are built separately (`agentSurface`, `ownerSurface`) so no MCP path can hold a decision function.

/** BL-256: video-details' and plan-schedule's margin -- a date within 15 minutes is neither written nor removed. */
const RETIME_MARGIN_MS = 15 * 60_000;
/** BL-256 review 4: a new time approved in the same step is at least this far ahead. */
const RETIME_APPROVE_MARGIN_MS = 30 * 60_000;

const refusedError = (refused: PlanSaveRefusal[], weekStart: string) =>
  new DomainError({ code: "validation_failed", message: `The plan was not saved: ${refused.map((r) => `${r.slotId ? `${r.slotId} ` : ""}${r.field}: ${r.reason}`).join("; ")}`, details: { weekStart, refused } });

export function createPublishingPlansService(ports: PublishingPlansPorts) {
  const stamp = () => ports.now().toISOString();

  async function assertChannel(channelId: string): Promise<void> {
    if (!(await ports.isChannelConnected(channelId))) {
      throw new DomainError({ code: "publishing_plan_channel_unavailable", message: "This channel is not connected on this computer", details: { channelId } });
    }
  }

  /**
   * BL-242 (ADR 0062 §1): the channel's approval stage. BL-267 (ADR 0073, plan §3.8, AC-WT-38): retired -- every channel is in
   * `packaged` whatever the document says (a slot-stage approval dates nothing new).
   */
  const stageOf = (snapshot: PublishingPlansSnapshot): PublishingPlanApprovalStage => (void snapshot, DEFAULT_APPROVAL_STAGE);

  /**
   * BL-267 (ADR 0073 §2, plan §3.2): every slot's place in the template in force, over the whole channel (positions are claimed
   * across weeks: the first created slot takes one). None in force (missing, withdrawn, unreadable): undefined -- nothing is dated
   * by the template (fail closed).
   */
  function matchesOf(snapshot: PublishingPlansSnapshot, progress: Map<string, PlanSlotProgress>): Map<string, SlotMatch> | undefined {
    const inForce = templateInForce(snapshot);
    if (!inForce) return undefined;
    const all = Object.values(snapshot.decisions);
    const slots: MatchSlot[] = Object.values(snapshot.slots).flatMap((slot) => {
      const meta = snapshot.plans[slot.weekStart];
      const instant = meta ? instantOf(slot.publishAt, meta.timeZone) : null;
      if (!instant) return [];
      const p = progress.get(slot.slotId) ?? null;
      const pkg = p?.package && !isDeletedOnYoutube(p) ? p.package : null;
      return [{ slotId: slot.slotId, instant, createdAt: slot.createdAt, vetoed: standingVetoOf(all.filter((d) => d.slotId === slot.slotId)) !== null, durationSeconds: pkg?.durationSeconds ?? null, video: pkg?.video ?? null }];
    });
    return matchSlots(inForce.version.days, slots);
  }

  function slotsOf(snapshot: PublishingPlansSnapshot, weekStart: string): PublishingPlanSlot[] {
    return Object.values(snapshot.slots).filter((s) => s.weekStart === weekStart);
  }
  /**
   * The decisions of a week's slots. BL-267 (ADR 0073 §5, AC-WT-32): read by slot id across weeks (a moved slot keeps its decisions;
   * ids are unique in a channel), plus the week's own decisions of slots no longer anywhere (a removed vetoed slot).
   */
  function decisionsOf(snapshot: PublishingPlansSnapshot, weekStart: string): PublishingPlanDecision[] {
    const ids = new Set(slotsOf(snapshot, weekStart).map((s) => s.slotId));
    const anywhere = new Set(Object.values(snapshot.slots).map((s) => s.slotId));
    return Object.values(snapshot.decisions).filter((d) => ids.has(d.slotId) || (d.weekStart === weekStart && !anywhere.has(d.slotId)));
  }

  /** BL-240: a slot of the channel by its id, in whichever week holds it (ids are unique in a channel). */
  const findSlot = (snapshot: PublishingPlansSnapshot, slotId: string): PublishingPlanSlot | null => Object.values(snapshot.slots).find((s) => s.slotId === slotId) ?? null;
  /** BL-240: a removed slot whose veto still stands -- its id stays vetoed for the uploads and cannot be used again. */
  const removedVetoed = (snapshot: PublishingPlansSnapshot, slotId: string): boolean =>
    !findSlot(snapshot, slotId) && standingVetoOf(Object.values(snapshot.decisions).filter((d) => d.slotId === slotId)) !== null;

  /** BL-240: the slots the given ones replace, as they stand (their own plan, decisions and package). */
  async function replacedOf(channelId: string, snapshot: PublishingPlansSnapshot, slotIds: string[]): Promise<Map<string, ReplacedSlot>> {
    const out = new Map<string, ReplacedSlot>();
    for (const slotId of new Set(slotIds)) {
      const slot = findSlot(snapshot, slotId);
      const meta = slot ? snapshot.plans[slot.weekStart] : undefined;
      if (!slot || !meta) {
        out.set(slotId, { slotId, weekStart: null, publishAt: null, video: null, vetoed: removedVetoed(snapshot, slotId), released: false, found: false });
        continue;
      }
      const progress = ports.progress ? ((await ports.progress(channelId, slot.weekStart, [slotId])).progress.get(slotId) ?? null) : null;
      const view = slotViewOf({ stage: stageOf(snapshot), meta, slot, decisions: decisionsOf(snapshot, slot.weekStart).filter((d) => d.slotId === slotId), progress, now: ports.now() });
      out.set(slotId, { slotId, weekStart: slot.weekStart, publishAt: slot.publishAt, video: view.package?.video ?? null, vetoed: view.vetoed !== null, released: view.released, found: true });
    }
    return out;
  }

  type ChannelState = { progress: Map<string, PlanSlotProgress>; counting: Map<string, string[]>; packagesUnavailable: boolean };

  /**
   * BL-242 round 3 (item 3): ONE progress read for the channel's live slots -- every slot not released by its own times, and every
   * vetoed one (its video's date may still be ahead) -- plus the asked ones. Past slots are not asked. `counting`: in the `packaged`
   * stage, the live slots whose approval counts (R1), by the video number they name. `failClosed`: a failed read is an empty one.
   */
  async function channelState(channelId: string, snapshot: PublishingPlansSnapshot, asked: readonly string[], failClosed = false): Promise<ChannelState> {
    const stage = stageOf(snapshot);
    const now = ports.now();
    const ids = new Set(asked);
    for (const meta of Object.values(snapshot.plans)) {
      const bare = planViewOf({ stage, channelId, meta, slots: slotsOf(snapshot, meta.weekStart), decisions: decisionsOf(snapshot, meta.weekStart), progress: new Map(), now });
      for (const slot of bare.slots) if (!slot.released || slot.vetoed) ids.add(slot.slotId);
    }
    let read: PlanProgressResult = { progress: new Map(), packagesUnavailable: false };
    if (ports.progress && ids.size > 0) {
      const pending = ports.progress(channelId, "", [...ids].sort());
      read = failClosed ? await pending.catch((): PlanProgressResult => ({ progress: new Map(), packagesUnavailable: true })) : await pending;
    }
    return stateFrom(channelId, snapshot, read);
  }

  /** The counting approvals of `snapshot` over a progress already read (BL-243: save() reuses its one read for the view it returns). */
  function stateFrom(channelId: string, snapshot: PublishingPlansSnapshot, read: PlanProgressResult): ChannelState {
    const stage = stageOf(snapshot);
    const now = ports.now();
    const progress = read.progress;
    const counting = new Map<string, string[]>();
    if (stage === "packaged") {
      const matches = matchesOf(snapshot, progress);
      for (const meta of Object.values(snapshot.plans)) {
        const view = planViewOf({ stage, channelId, meta, slots: slotsOf(snapshot, meta.weekStart), decisions: decisionsOf(snapshot, meta.weekStart), progress, now, matches });
        for (const slot of view.slots) {
          if (slot.vetoed || slot.released || slot.approval !== "approved" || !slot.fingerprint) continue;
          counting.set(slot.fingerprint.video, [...(counting.get(slot.fingerprint.video) ?? []), slot.slotId]);
        }
      }
    }
    return { progress, counting, packagesUnavailable: read.packagesUnavailable };
  }

  async function viewOf(channelId: string, snapshot: PublishingPlansSnapshot, meta: PublishingPlanMeta, known?: ChannelState): Promise<PlanView> {
    const slots = slotsOf(snapshot, meta.weekStart);
    const state = known ?? (await channelState(channelId, snapshot, slots.map((s) => s.slotId)));
    const replaced = await replacedOf(channelId, snapshot, slots.flatMap((s) => (s.replacesSlotId ? [s.replacesSlotId] : [])));
    const view = planViewOf({ stage: stageOf(snapshot), channelId, meta, slots, decisions: decisionsOf(snapshot, meta.weekStart), progress: state.progress, now: ports.now(), replaced, matches: matchesOf(snapshot, state.progress) });
    // Round 3 item 2: an approval the uploads turn pending because another counting approval names the same video number.
    for (const slot of view.slots) {
      if (slot.approval === "approved" && slot.fingerprint && !slot.vetoed && !slot.released) slot.duplicateVideo = (state.counting.get(slot.fingerprint.video)?.length ?? 0) > 1;
    }
    return view;
  }

  async function requirePlan(channelId: string, weekStart: string): Promise<{ snapshot: PublishingPlansSnapshot; meta: PublishingPlanMeta }> {
    const snapshot = await ports.store.read(channelId);
    const meta = snapshot.plans[weekStart];
    if (!meta) throw new DomainError({ code: "publishing_plan_not_found", message: "No plan for this week in this channel", details: { channelId, weekStart } });
    return { snapshot, meta };
  }

  async function list(channelId: string): Promise<PlanSummary[]> {
    const snapshot = await ports.store.read(channelId);
    const state = await channelState(channelId, snapshot, Object.values(snapshot.slots).map((s) => s.slotId));
    const views = await Promise.all(Object.values(snapshot.plans).map((meta) => viewOf(channelId, snapshot, meta, state)));
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
      const stage = stageOf(snapshot);
      const toRemove = [...new Set(parsed.removeSlotIds ?? [])];
      const otherWeeksIds = new Set(Object.values(snapshot.slots).filter((s) => s.weekStart !== weekStart).map((s) => s.slotId));
      const seen = new Set<string>();
      const upserts: PublishingPlanSlot[] = [];
      const changed: string[] = [];
      for (const input of parsed.slots ?? []) {
        if (seen.has(input.slotId)) {
          refused.push({ slotId: input.slotId, field: "slots", reason: "duplicate_slot" });
          continue;
        }
        seen.add(input.slotId);
        const content = contentOf({ date: input.date, publishAt: input.publishAt, lengthHint: input.lengthHint ?? null, note: input.note ?? null, ...(input.replacesSlotId ? { replacesSlotId: input.replacesSlotId } : {}) });
        const before = current.get(input.slotId);
        // Review #2: a slot id is unique in the channel (the uploads find a slot by its id alone).
        if (!before && otherWeeksIds.has(input.slotId)) {
          refused.push({ slotId: input.slotId, field: "slots", reason: "slot_id_in_other_week" });
          continue;
        }
        // BL-240: a removed vetoed slot's id keeps its veto (the uploads still stop a package naming it): never a new slot.
        if (!before && removedVetoed(snapshot, input.slotId)) {
          refused.push({ slotId: input.slotId, field: "slots", reason: "slot_id_removed" });
          continue;
        }
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
        if (content.replacesSlotId === input.slotId) {
          refused.push({ slotId: input.slotId, field: "replacesSlotId", reason: "replaces_self" });
          continue;
        }
        if (content.replacesSlotId && !findSlot(snapshot, content.replacesSlotId) && !(parsed.slots ?? []).some((s) => s.slotId === content.replacesSlotId)) {
          refused.push({ slotId: input.slotId, field: "replacesSlotId", reason: "replaces_unknown" });
          continue;
        }
        // Review: two slots replacing each other would both be pulled by one approval -- the week would release neither.
        if (content.replacesSlotId) {
          const sent = (parsed.slots ?? []).find((s) => s.slotId === content.replacesSlotId);
          const targetReplaces = sent ? (sent.replacesSlotId ?? null) : (findSlot(snapshot, content.replacesSlotId)?.replacesSlotId ?? null);
          if (targetReplaces === input.slotId) {
            refused.push({ slotId: input.slotId, field: "replacesSlotId", reason: "replaces_cycle" });
            continue;
          }
        }
        upserts.push({ ...content, weekStart, slotId: input.slotId, createdAt: before?.createdAt ?? stamp(), updatedAt: stamp(), updatedBy: by });
        changed.push(input.slotId);
      }

      // BL-243 (ADR 0063 §2): ONE progress read per save, as the returned view always needed -- the channel's live slots, the
      // ones to remove and the ones sent. In the `packaged` stage an approval counts here as the view counts it (only while it
      // covers the slot's current package; a deleted video's package has none); with the package scan unavailable, the older,
      // stricter rule below. The removals' check and the returned view use the same read -- made after the slots' own (cheap)
      // checks.
      const channel = await channelState(channelId, snapshot, [...new Set([...current.keys(), ...toRemove, ...(parsed.slots ?? []).map((s) => s.slotId)])]);
      const views =
        stage === "packaged" && existing && !channel.packagesUnavailable
          ? new Map(planViewOf({ stage, channelId, meta: existing, slots: [...current.values()], decisions, progress: channel.progress, now, matches: matchesOf(snapshot, channel.progress) }).slots.map((view) => [view.slotId, view]))
          : null;
      // BL-242: else an approval that counts in the channel's stage stands on the slot (whatever its package now).
      const approvedNow = (slot: PublishingPlanSlot) => {
        const view = views?.get(slot.slotId);
        if (view) return view.approval === "approved";
        return existing !== null && approvalStandsOn(stage, existing.timeZone, contentOf(slot), decisionsFor(slot.slotId));
      };

      // BL-267 (ADR 0073 §5, plan §3.7, AC-WT-35): an agent never re-times a slot whose video has a date on YouTube (`slot_dated`);
      // only the owner or the Producer moves it.
      for (const upsert of upserts) {
        const before = current.get(upsert.slotId);
        if (!before || (before.date === upsert.date && before.publishAt === upsert.publishAt && existing?.timeZone === timeZone)) continue;
        const p = channel.progress.get(upsert.slotId);
        if (p && !isDeletedOnYoutube(p) && (p.publishAt || p.foreignPublishAt)) refused.push({ slotId: upsert.slotId, field: "publishAt", reason: "slot_dated" });
      }
      const removes: string[] = [];
      const vetoedRemoves: string[] = [];
      // Review #3: what the uploads say of the slots to remove (a slot whose video is on YouTube stays) -- the read above.
      const uploads = channel.progress;
      for (const slotId of toRemove) {
        const slot = current.get(slotId);
        const decision = slot && existing ? decisionStateOf(decisionsForStage(decisionsFor(slotId), stage), contentHashOf(existing.timeZone, contentOf(slot))) : null;
        const upload = uploads.get(slotId);
        // BL-243: a video deleted on YouTube is not on YouTube -- its vetoed slot may go.
        const uploaded = Boolean(upload && !isDeletedOnYoutube(upload) && (upload.videoId || ["uploading", "scheduled", "published"].includes(upload.status)));
        if (!slot) refused.push({ slotId, field: "removeSlotIds", reason: "unknown_slot" });
        else if (decision?.vetoed) {
          // BL-240 (ADR 0060): a vetoed slot may go, also one approved before the veto -- unless its video is on YouTube.
          if (uploaded) refused.push({ slotId, field: "removeSlotIds", reason: "slot_uploaded" });
          else if (seen.has(slotId)) refused.push({ slotId, field: "removeSlotIds", reason: "duplicate_slot" });
          else {
            removes.push(slotId);
            vetoedRemoves.push(slotId);
          }
        } else if (views?.has(slotId) ? views.get(slotId)!.approval === "approved" || views.get(slotId)!.changedAfterApproval !== null : decision && (decision.approved || decision.superseded))
          refused.push({ slotId, field: "removeSlotIds", reason: "slot_approved" });
        else if (uploaded) refused.push({ slotId, field: "removeSlotIds", reason: "slot_uploaded" });
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
        return { plan: await viewOf(channelId, snapshot, existing, channel), changed: [], unlocked: [], removed: [] };
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
      for (const slotId of vetoedRemoves) {
        await ports.audit({ channelId, weekStart, slotId, detail: { event: "publishing_plan.vetoed_slot_removed", at, weekStart, slotId, by } });
      }
      const after = await requirePlan(channelId, weekStart);
      // The same read, counted over the saved plan (no second scan).
      return { plan: await viewOf(channelId, after.snapshot, after.meta, stateFrom(channelId, after.snapshot, channel)), changed, unlocked, removed: removes };
    });
  }

  async function get(input: unknown): Promise<{ plan: PlanView }> {
    const { channelId, weekStart } = parseWithSchema(getPlanInputSchema, input, "publishing plan");
    await assertChannel(channelId);
    const { snapshot, meta } = await requirePlan(channelId, weekStart);
    return { plan: await viewOf(channelId, snapshot, meta) };
  }

  async function agentList(input: unknown): Promise<{ plans: PlanSummary[] }> {
    const { channelId, limit } = parseWithSchema(listPlansInputSchema, input, "publishing plans");
    await assertChannel(channelId);
    return { plans: (await list(channelId)).slice(0, limit ?? PLAN_LIST_DEFAULT_LIMIT) };
  }

  /**
   * The owner's decision (Web UI only; ADR 0051 §3-§6). Approve: every slot named exists, still has the content shown, is not
   * vetoed and not released -- or nothing is approved. Revoke: the slot is approved with the content shown. Veto / restore: the
   * slot exists and is not released. A decision that changes nothing writes nothing.
   */
  async function decide(channelId: string, weekStart: string, input: unknown, userId: string): Promise<{ plan: PlanView; decided: string[]; replacedVetoed: string[] }> {
    const { action, slots } = parseWithSchema(ownerDecisionInputSchema, input, "decision");
    return ports.withLock(() => decideLocked(channelId, weekStart, action, slots, userId));
  }

  /** decide() inside the write lock (BL-256: retime() approves the moved slot under the same lock). */
  async function decideLocked(channelId: string, weekStart: string, action: OwnerDecisionInput["action"], slots: OwnerDecisionInput["slots"], userId: string, options: { skipImpliedVeto?: boolean } = {}): Promise<{ plan: PlanView; decided: string[]; replacedVetoed: string[] }> {
    {
      const { snapshot, meta } = await requirePlan(channelId, weekStart);
      const state = await channelState(channelId, snapshot, slotsOf(snapshot, meta.weekStart).map((s) => s.slotId));
      const view = await viewOf(channelId, snapshot, meta, state);
      const byId = new Map(view.slots.map((s) => [s.slotId, s]));
      const refuse = (code: "publishing_plan_slot_not_found" | "publishing_plan_changed" | "publishing_plan_slot_vetoed" | "publishing_plan_slot_past" | "publishing_plan_slot_not_packaged", slotId: string, message: string) =>
        new DomainError({ code, message, details: { channelId, weekStart, slotId } });
      const targets: PlanView["slots"] = [];
      for (const named of slots) {
        const slot = byId.get(named.slotId);
        if (!slot) throw refuse("publishing_plan_slot_not_found", named.slotId, `No slot ${named.slotId} in this plan`);
        if (slot.released) throw refuse("publishing_plan_slot_past", named.slotId, `Slot ${named.slotId}'s time has passed`);
        // BL-242 (ADR 0062 §2, AC-WP-53): in the `packaged` stage a slot without a ready or uploaded package has nothing to approve.
        if (action === "approve" && slot.approval === "awaiting_package") throw refuse("publishing_plan_slot_not_packaged", named.slotId, `Slot ${named.slotId} has no ready package yet`);
        if (action === "approve" || action === "revoke") {
          if (named.contentHash !== slot.contentHash) throw refuse("publishing_plan_changed", named.slotId, `Slot ${named.slotId} changed since it was shown; reload the plan`);
          if (action === "approve" && slot.vetoed) throw refuse("publishing_plan_slot_vetoed", named.slotId, `Slot ${named.slotId} is vetoed; restore it first`);
          if (action === "revoke" && slot.approval !== "approved") throw refuse("publishing_plan_changed", named.slotId, `Slot ${named.slotId} is not approved`);
        }
        targets.push(slot);
      }
      const kind = ({ approve: "approved", revoke: "revoked", veto: "vetoed", restore: "restored" } as const)[action];
      const vetoPackageOf = (slot: PlanView["slots"][number]) =>
        stageOf(snapshot) !== "packaged"
          ? null
          : slot.package?.manifestSha256
            ? { video: slot.package.video, manifestSha256: slot.package.manifestSha256, videoId: slot.videoId }
            : (() => {
                // Round 3 (a): the fallback names the last approval's package only while no OTHER slot of the channel counts an
                // approval for that video number -- else it would remove the date the owner gave there.
                const last = lastApprovedPackageOf(decisionsForStage(decisionsOf(snapshot, weekStart).filter((d) => d.slotId === slot.slotId), "packaged"));
                return last && !(state.counting.get(last.video) ?? []).some((id) => id !== slot.slotId) ? last : null;
              })();
      const replacedVetoed: string[] = [];
      const effective = targets.filter((slot) =>
        action === "approve" ? slot.approval !== "approved" : action === "revoke" ? true : action === "veto" ? !slot.vetoed : Boolean(slot.vetoed)
      );
      if (effective.length > 0) {
        const device = await ports.deviceLabel();
        const at = stamp();
        // Review #7: one above the highest counter in the channel's document.
        const seq = Math.max(0, ...Object.values(snapshot.decisions).map((d) => d.seq ?? 0)) + 1;
        const records: PublishingPlanDecision[] = effective.map((slot) => ({
          seq,
          id: `pd_${ports.randomId()}`.slice(0, 40),
          weekStart,
          slotId: slot.slotId,
          kind,
          contentHash: slot.contentHash,
          snapshot: { ...contentOf(slot), timeZone: meta.timeZone },
          by: "owner",
          device,
          at,
          // BL-242: the fingerprint the shown hash was computed with (`packaged` stage only). R2: a veto names the slot's CURRENT package
          // (else the package of its last approval not revoked), so it can remove the date of that video wherever its row was made.
          ...(() => {
            const named = kind === "vetoed" ? vetoPackageOf(slot) : kind === "restored" ? null : slot.fingerprint;
            return named ? { package: { ...named } } : {};
          })(),
          // BL-267 (ADR 0073 §3, AC-WT-42): a new approval also names the media, so a packaging-only re-package keeps it.
          ...(() => {
            const media = kind === "approved" ? mediaOfProgress(state.progress.get(slot.slotId) ?? null) : null;
            return media ? { media } : {};
          })(),
        }));
        // BL-240 (ADR 0060): approving a slot that replaces another vetoes that one in the same decision -- unless it is already
        // vetoed, released or gone. It is the owner's own veto (restorable), recorded with the slot that replaced it.
        const implied: Array<{ record: PublishingPlanDecision; publishAtUtc: string }> = [];
        // BL-256 review 2: re-approving a slot the owner moved does not veto its replaced slot again (he may have restored it).
        // BL-267 (ADR 0073 §6, owner O4): no replacement concept any more -- an explicit date vetoes no other slot.
        void options;
        await ports.store.addDecisions(channelId, [...records, ...implied.map((i) => i.record)]);
        for (const record of records) {
          const slot = byId.get(record.slotId)!;
          await ports.audit({
            channelId,
            weekStart,
            slotId: record.slotId,
            detail: { event: `publishing_plan.${kind}`, at, decisionId: record.id, weekStart, slotId: record.slotId, contentHash: record.contentHash, publishAt: slot.publishAt, timeZone: meta.timeZone, publishAtUtc: slot.publishAtUtc, by: userId, device, ...(record.package ? { package: record.package } : {}) },
          });
        }
        for (const { record, publishAtUtc } of implied) {
          await ports.audit({
            channelId,
            weekStart: record.weekStart,
            slotId: record.slotId,
            detail: { event: "publishing_plan.vetoed", at, decisionId: record.id, weekStart: record.weekStart, slotId: record.slotId, contentHash: record.contentHash, publishAt: record.snapshot.publishAt, timeZone: record.snapshot.timeZone, publishAtUtc, by: userId, device, replacedBy: record.replacedBy },
          });
        }
        replacedVetoed.push(...implied.map((i) => i.record.slotId));
        // BL-248 (ADR 0066): the Producer's Inbox writer runs soon; it never throws and never holds the decision.
        ports.notifyOwnerDecision?.();
      }
      const after = await requirePlan(channelId, weekStart);
      return { plan: await viewOf(channelId, after.snapshot, after.meta), decided: effective.map((s) => s.slotId), replacedVetoed };
    }
  }

  /**
   * BL-256 (owner msgs 4380/4383): the owner moves a slot to another day of its week and/or another time. The slot must still have
   * the content the screen showed, not be vetoed or released, and its current time and the new one must both be at least 15 minutes
   * away (inside that window the plan-schedule pass neither writes nor removes a video's date). The slot keeps its length, note and
   * replaced slot. `approve`: the new content is approved in the same step (one approval decision, as the owner's own approve would
   * write); without it an approval the slot had no longer counts ("changed after approval", by the owner). An uploaded video's date
   * on YouTube changes only through an approval of the new time -- the plan-schedule pass, never this call.
   */
  async function retime(channelId: string, weekStart: string, input: unknown, userId: string): Promise<{ plan: PlanView; changed: boolean; approved: boolean }> {
    const parsed = parseWithSchema(ownerRetimeInputSchema, input, "slot time");
    return ports.withLock(async () => {
      const { snapshot, meta } = await requirePlan(channelId, weekStart);
      const state = await channelState(channelId, snapshot, slotsOf(snapshot, meta.weekStart).map((s) => s.slotId));
      const view = await viewOf(channelId, snapshot, meta, state);
      const slot = view.slots.find((s) => s.slotId === parsed.slotId);
      const details = { channelId, weekStart, slotId: parsed.slotId };
      if (!slot) throw new DomainError({ code: "publishing_plan_slot_not_found", message: `No slot ${parsed.slotId} in this plan`, details });
      if (slot.released) throw new DomainError({ code: "publishing_plan_slot_past", message: `Slot ${parsed.slotId}'s time has passed`, details });
      if (slot.vetoed) throw new DomainError({ code: "publishing_plan_slot_vetoed", message: `Slot ${parsed.slotId} is vetoed; restore it first`, details });
      if (parsed.contentHash !== slot.contentHash) throw new DomainError({ code: "publishing_plan_changed", message: `Slot ${parsed.slotId} changed since it was shown; reload the plan`, details });
      const now = ports.now().getTime();
      // Review 1: the latest time the video may come out -- the slot's, the approved time an agent's change still stands on, and the
      // date the uploaded video carries (the terms `released` uses): plan-schedule cannot change a date within 15 minutes.
      const previousAt = slot.changedAfterApproval ? instantOf(slot.changedAfterApproval.previous.publishAt, slot.changedAfterApproval.previous.timeZone)?.getTime() ?? Infinity : Infinity;
      const soonest = Math.min(Date.parse(slot.publishAtUtc), previousAt, slot.youtubePublishAt ? Date.parse(slot.youtubePublishAt) || Infinity : Infinity);
      if (soonest - now < RETIME_MARGIN_MS) {
        throw new DomainError({ code: "publishing_plan_slot_too_soon", message: `Slot ${parsed.slotId} comes out in less than 15 minutes; it can no longer be moved`, details });
      }
      const refused: PlanSaveRefusal[] = [];
      const weekEnd = addDays(meta.weekStart, 6);
      const instant = instantOf(parsed.publishAt, meta.timeZone);
      if (!isCalendarDate(parsed.date)) refused.push({ slotId: parsed.slotId, field: "date", reason: "date_invalid" });
      else if (parsed.date < meta.weekStart || parsed.date > weekEnd) refused.push({ slotId: parsed.slotId, field: "date", reason: "outside_week" });
      else if (!instant) refused.push({ slotId: parsed.slotId, field: "publishAt", reason: "publish_at_invalid" });
      else if (parsed.publishAt.slice(0, 10) !== parsed.date) refused.push({ slotId: parsed.slotId, field: "publishAt", reason: "date_mismatch" });
      // Review 4: an approved new time must still be ahead when the decision reaches the uploading computer (sync, the one-minute
      // pass): 30 minutes with approve, 15 without.
      else if (instant.getTime() - now < (parsed.approve ? RETIME_APPROVE_MARGIN_MS : RETIME_MARGIN_MS)) refused.push({ slotId: parsed.slotId, field: "publishAt", reason: "in_past" });
      if (refused.length > 0) throw refusedError(refused, weekStart);
      // BL-242: in the `packaged` stage a slot without a ready or uploaded package has nothing to approve -- refused before writing.
      if (parsed.approve && slot.approval === "awaiting_package") {
        throw new DomainError({ code: "publishing_plan_slot_not_packaged", message: `Slot ${parsed.slotId} has no ready package yet`, details });
      }
      const stored = findSlot(snapshot, parsed.slotId)!;
      const content = contentOf({ ...contentOf(stored), date: parsed.date, publishAt: parsed.publishAt });
      const moved = content.date !== stored.date || content.publishAt !== stored.publishAt;
      if (moved) {
        const at = stamp();
        // An approval of the old content would count again if an agent later saved the old time back (an approval stands while its
        // hash matches the slot): the owner moved away from it, so it is revoked first -- the approval standing now and the one an
        // agent's change left standing ("changed after approval").
        const device = await ports.deviceLabel();
        const seq = Math.max(0, ...Object.values(snapshot.decisions).map((d) => d.seq ?? 0)) + 1;
        // Every approval of the slot that no later revocation of the same content cancelled (whatever stage it counts in): any of
        // them would count again if the slot's content came back to it.
        const ordered = Object.values(snapshot.decisions).filter((d) => d.slotId === stored.slotId).sort(decisionOrder);
        const revoke: Array<{ contentHash: string; content: ReturnType<typeof contentOf>; timeZone: string; package: PublishingPlanPackageFingerprint | null }> = [];
        const seenHashes = new Set<string>();
        for (const record of [...ordered].reverse()) {
          if (record.kind !== "approved" && record.kind !== "revoked") continue;
          if (seenHashes.has(record.contentHash)) continue;
          seenHashes.add(record.contentHash);
          if (record.kind === "approved") revoke.push({ contentHash: record.contentHash, content: contentOf(record.snapshot), timeZone: record.snapshot.timeZone, package: record.package ?? null });
        }
        const revocations: PublishingPlanDecision[] = revoke.map((r) => ({
          seq,
          id: `pd_${ports.randomId()}`.slice(0, 40),
          weekStart,
          slotId: stored.slotId,
          kind: "revoked",
          contentHash: r.contentHash,
          snapshot: { ...r.content, timeZone: r.timeZone },
          by: "owner",
          device,
          at,
          ...(r.package ? { package: { ...r.package } } : {}),
        }));
        // The move first: should the revocations then fail, the old approvals no longer match the slot's content (nothing is dated by
        // them), rather than an unmoved slot losing its approval.
        await ports.store.savePlan(channelId, { weekStart, create: null, updatedAt: at, updatedBy: "owner", upserts: [{ ...content, weekStart, slotId: stored.slotId, createdAt: stored.createdAt, updatedAt: at, updatedBy: "owner" }], removes: [] });
        if (revocations.length > 0) await ports.store.addDecisions(channelId, revocations);
        await ports.audit({
          channelId,
          weekStart,
          slotId: stored.slotId,
          detail: { event: "publishing_plan.retimed", at, weekStart, slotId: stored.slotId, from: { date: stored.date, publishAt: stored.publishAt }, to: { date: content.date, publishAt: content.publishAt }, timeZone: meta.timeZone, wasApproved: slot.approval === "approved", changedAfterApproval: slot.changedAfterApproval !== null, revoked: revocations.map((r) => r.id), approve: parsed.approve, by: userId, device },
        });
      }
      if (!parsed.approve) {
        // BL-248: the revocations are owner decisions too -- the Producer's Inbox writer runs soon (never throws, never awaited).
        if (moved) ports.notifyOwnerDecision?.();
        const after = await requirePlan(channelId, weekStart);
        return { plan: await viewOf(channelId, after.snapshot, after.meta), changed: moved, approved: false };
      }
      // The approval names the slot as it is now (the hash the view computes after the move, with the package fingerprint).
      const fresh = await requirePlan(channelId, weekStart);
      const freshView = await viewOf(channelId, fresh.snapshot, fresh.meta);
      const target = freshView.slots.find((s) => s.slotId === parsed.slotId)!;
      const hadApproval = slot.approval === "approved" || slot.changedAfterApproval !== null;
      const decided = await decideLocked(channelId, weekStart, "approve", [{ slotId: target.slotId, contentHash: target.contentHash }], userId, { skipImpliedVeto: hadApproval });
      return { plan: decided.plan, changed: moved, approved: decided.plan.slots.find((s) => s.slotId === parsed.slotId)?.approval === "approved" };
    });
  }

  /**
   * BL-242 (ADR 0062 §1, AC-WP-50): the owner's approval stage of the channel (Web UI only). One change and one audit event when it
   * changes; the same stage again writes nothing.
   */
  async function setApprovalStage(channelId: string, input: unknown, userId: string): Promise<{ approvalStage: PublishingPlanApprovalStage; changed: boolean }> {
    // BL-267 (ADR 0073, plan §3.8): the approval stage is retired -- validated, nothing is written (an older build must not be put
    // into the `slot` stage by this one).
    parseWithSchema(approvalStageInputSchema, input, "approval stage");
    void channelId;
    void userId;
    return { approvalStage: DEFAULT_APPROVAL_STAGE, changed: false };
  }

  /**
   * BL-225 stage 3: every slot's decision for the uploads (`PlanSlotDecision`), by slot id. A released slot is `pending` (its time
   * has passed: nothing is scheduled or unscheduled by it any more); a slot id in two plans is `pending`.
   */
  async function slotDecisions(channelId: string): Promise<Map<string, PlanSlotDecision>> {
    const snapshot = await ports.store.read(channelId);
    const stage = stageOf(snapshot);
    const decisions = new Map<string, PlanSlotDecision>();
    // BL-242 R2: the decisions that name a video (a counting approval, a standing veto with its package), to settle per video number.
    const naming = new Map<string, { record: PublishingPlanDecision; kind: "approved" | "vetoed"; package: PublishingPlanPackageFingerprint }>();
    const seen = new Set<string>();
    // BL-242 R1 (ADR 0062 §3): in the `packaged` stage the uploads read the same package progress as the screen -- one read for the
    // channel's live slots (round 3); unreadable, it is empty: no slot is approved (fail closed), the vetoes still apply.
    const progress = stage === "packaged" ? (await channelState(channelId, snapshot, [], true)).progress : new Map<string, PlanSlotProgress>();
    const matches = matchesOf(snapshot, progress);
    for (const meta of Object.values(snapshot.plans)) {
      const planDecisions = decisionsOf(snapshot, meta.weekStart);
      const slots = slotsOf(snapshot, meta.weekStart);
      const view = planViewOf({ stage, channelId, meta, slots, decisions: planDecisions, progress, now: ports.now(), matches });
      for (const slot of view.slots) {
        if (seen.has(slot.slotId)) {
          // Review #2: an id in two plans schedules nothing, but a veto in either of them still stops it (only rows made with that id).
          const vetoed = decisions.get(slot.slotId)?.kind === "vetoed" || (!slot.released && slot.vetoed !== null);
          decisions.set(slot.slotId, vetoed ? { kind: "vetoed" } : { kind: "pending" });
          naming.delete(slot.slotId);
          continue;
        }
        seen.add(slot.slotId);
        if (stage === "packaged") {
          const ownDecisions = planDecisions.filter((d) => d.slotId === slot.slotId);
          if (slot.released) decisions.set(slot.slotId, { kind: "pending" });
          else if (slot.vetoed) {
            // R2: the veto names the package it recorded (absent on a veto from before BL-242: only rows made with this slot id).
            const veto = standingVetoOf(ownDecisions)!;
            decisions.set(slot.slotId, { kind: "vetoed", ...(veto.package ? { package: { ...veto.package } } : {}) });
            if (veto.package) naming.set(slot.slotId, { record: veto, kind: "vetoed", package: veto.package });
          } else if (slot.approval === "approved" && slot.fingerprint) {
            // R1: standing AND covering the slot's current package (the view's own rule).
            const record = standingPackageApprovalOf(decisionsForStage(ownDecisions, "packaged"), meta.timeZone, contentOf(slot))!;
            decisions.set(slot.slotId, { kind: "approved", publishAt: slot.publishAtUtc, package: { ...slot.fingerprint }, source: "owner", ...(record.media ? { media: { ...record.media } } : {}) });
            naming.set(slot.slotId, { record, kind: "approved", package: slot.fingerprint });
          } else if (slot.dating.source === "template") {
            // BL-267 (ADR 0073 §3, AC-WT-14/16): matches the template in force, package ready or uploaded, media allowed -- dated at
            // the slot's instant, naming the current package and its media (a packaging-only re-package keeps it, AC-WT-17).
            const p = progress.get(slot.slotId) ?? null;
            const fp = fingerprintOf(p);
            if (!fp) decisions.set(slot.slotId, { kind: "pending" });
            else {
              const media = mediaOfProgress(p);
              decisions.set(slot.slotId, { kind: "approved", publishAt: slot.publishAtUtc, package: { ...fp }, source: "template", ...(media ? { media } : {}) });
              // A template date has no owner record: it orders after every decision naming the same video (the newest word).
              const record = { id: `template:${slot.slotId}`, seq: Number.MAX_SAFE_INTEGER, at: ports.now().toISOString() } as PublishingPlanDecision;
              naming.set(slot.slotId, { record, kind: "approved", package: fp });
            }
          } else decisions.set(slot.slotId, { kind: "pending" });
          continue;
        }
        decisions.set(
          slot.slotId,
          slot.released ? { kind: "pending" } : slot.vetoed ? { kind: "vetoed" } : slot.approval === "approved" ? { kind: "approved", publishAt: slot.publishAtUtc, source: "owner" } : { kind: "pending" }
        );
      }
    }
    // BL-242 R2 (ADR 0062 §4): for a video number the newest decision naming it decides. A counting approval -> its date (an older
    // veto naming it loses its package: it reaches only rows made with its own slot id); a veto -> no date (an older approval naming
    // it is pending). Defensive: two counting approvals of one video number are both pending (a package names one slot).
    const byVideo = new Map<string, Array<[string, { record: PublishingPlanDecision; kind: "approved" | "vetoed" }]>>();
    for (const [slotId, entry] of naming) byVideo.set(entry.package.video, [...(byVideo.get(entry.package.video) ?? []), [slotId, entry]]);
    for (const group of byVideo.values()) {
      if (group.length < 2) continue;
      const approvals = group.filter(([, e]) => e.kind === "approved");
      const newest = [...group].sort(([, a], [, b]) => decisionOrder(a.record, b.record)).at(-1)!;
      for (const [slotId, entry] of group) {
        if (entry.kind === "approved" && (approvals.length > 1 || newest[0] !== slotId)) decisions.set(slotId, { kind: "pending" });
        if (entry.kind === "vetoed" && newest[0] !== slotId && newest[1].kind === "approved" && approvals.length === 1) decisions.set(slotId, { kind: "vetoed" });
      }
    }
    // BL-240 (ADR 0060): a vetoed slot an agent removed stays vetoed -- a package that still names it is never uploaded.
    for (const slotId of new Set(Object.values(snapshot.decisions).map((d) => d.slotId))) {
      if (!decisions.has(slotId) && removedVetoed(snapshot, slotId)) decisions.set(slotId, { kind: "vetoed" });
    }
    return decisions;
  }

  /**
   * BL-252 stage 2 (ADR 0068 amendment 1): what cross-posting reads -- the slots around now (from 36 h ago on) with their standing
   * package approval, kept as separate facts (approved / vetoed / released), because `slotDecisions` turns a released slot `pending`
   * while a social post goes out AT and after the slot's time. Fail closed: only the `packaged` stage counts (a slot-stage approval
   * names no package); an unreadable package scan approves nothing; a slot id in two plans and two approvals of one video number
   * approve nothing. Read-only; never a decision.
   */
  async function socialSlotStates(channelId: string): Promise<SocialSlotState[]> {
    // BL-267 (owner O10, ADR 0073 §3, AC-WT-37): one plan for YouTube and the social networks -- a slot authorizes its package's
    // `crossPost` when the plan dates it (the template with the media condition, or a standing explicit owner date), evaluated also
    // for slots up to 36 h past, bound to the slot's CURRENT manifest (the runner re-checks this same read before each call).
    const snapshot = await ports.store.read(channelId);
    const now = ports.now();
    const from = now.getTime() - SOCIAL_LOOKBACK_MS;
    const ids = new Set<string>();
    for (const meta of Object.values(snapshot.plans)) {
      const bare = planViewOf({ stage: "packaged", channelId, meta, slots: slotsOf(snapshot, meta.weekStart), decisions: decisionsOf(snapshot, meta.weekStart), progress: new Map(), now });
      for (const slot of bare.slots) if (Date.parse(slot.publishAtUtc) >= from) ids.add(slot.slotId);
    }
    if (ids.size === 0 || !ports.progress) return [];
    // Every live slot too: template positions are claimed across the channel (the first created takes one).
    for (const slot of Object.values(snapshot.slots)) ids.add(slot.slotId);
    const read = await ports.progress(channelId, "", [...ids].sort()).catch((): PlanProgressResult => ({ progress: new Map(), packagesUnavailable: true }));
    if (read.packagesUnavailable) return [];
    const matches = matchesOf(snapshot, read.progress);
    const out: SocialSlotState[] = [];
    const seen = new Map<string, number>();
    for (const meta of Object.values(snapshot.plans)) {
      const view = planViewOf({ stage: "packaged", channelId, meta, slots: slotsOf(snapshot, meta.weekStart), decisions: decisionsOf(snapshot, meta.weekStart), progress: read.progress, now, matches });
      for (const slot of view.slots) {
        if (Date.parse(slot.publishAtUtc) < from) continue;
        seen.set(slot.slotId, (seen.get(slot.slotId) ?? 0) + 1);
        const current = fingerprintOf(read.progress.get(slot.slotId) ?? null);
        // Fail closed: vetoed, not dated by the plan, or a date YouTube carries that this computer did not set -- nothing posts.
        const approved = slot.dating.source !== null && !slot.vetoed && !slot.foreignPublishAt && current !== null;
        out.push({ slotId: slot.slotId, weekStart: meta.weekStart, timeZone: meta.timeZone, publishAtUtc: slot.publishAtUtc, released: slot.released, vetoed: slot.vetoed !== null, approved, package: approved ? { ...current! } : null });
      }
    }
    const videos = new Map<string, number>();
    for (const s of out) if (s.approved && s.package) videos.set(s.package.video, (videos.get(s.package.video) ?? 0) + 1);
    return out.map((s) => ((seen.get(s.slotId) ?? 0) > 1 || (s.package && (videos.get(s.package.video) ?? 0) > 1) ? { ...s, approved: false, package: null } : s));
  }

  /** The approvals of a slot that no later revocation of the same content cancelled -- revoked by a move (as by retime). */
  function revocationsFor(snapshot: PublishingPlansSnapshot, slotId: string, weekStart: string, device: string | null, at: string, seq: number): PublishingPlanDecision[] {
    const ordered = Object.values(snapshot.decisions).filter((d) => d.slotId === slotId).sort(decisionOrder);
    const out: PublishingPlanDecision[] = [];
    const seenHashes = new Set<string>();
    for (const record of [...ordered].reverse()) {
      if (record.kind !== "approved" && record.kind !== "revoked") continue;
      if (seenHashes.has(record.contentHash)) continue;
      seenHashes.add(record.contentHash);
      if (record.kind !== "approved") continue;
      out.push({ seq, id: `pd_${ports.randomId()}`.slice(0, 40), weekStart, slotId, kind: "revoked", contentHash: record.contentHash, snapshot: { ...record.snapshot }, by: "owner", device, at, ...(record.package ? { package: { ...record.package } } : {}) });
    }
    return out;
  }

  /**
   * BL-267 (ADR 0073 §5, plan §3.7; owner TG 4630/4636): the owner or the Producer moves a live slot anywhere -- another day, time or
   * week, on or off the template -- keeping its id. When its video has a date on YouTube, the new date is written at once through
   * the `moveYoutube` port (every refusal before the plan changes). A move never gives a first date. `dryRun`: checked, nothing written.
   */
  async function move(channelId: string, input: unknown, by: "owner" | "producer", userId: string): Promise<PlanMoveResult> {
    const parsed = parseWithSchema(moveSlotInputSchema, input, "slot move");
    await assertChannel(channelId);
    return ports.withLock(async () => {
      const snapshot = await ports.store.read(channelId);
      const stored = findSlot(snapshot, parsed.slotId);
      const details = { channelId, slotId: parsed.slotId };
      const sourceMeta = stored ? snapshot.plans[stored.weekStart] : undefined;
      if (!stored || !sourceMeta) throw new DomainError({ code: "publishing_plan_slot_not_found", message: `No slot ${parsed.slotId} in this channel`, details });
      const state = await channelState(channelId, snapshot, [stored.slotId]);
      const view = (await viewOf(channelId, snapshot, sourceMeta, state)).slots.find((s) => s.slotId === stored.slotId)!;
      if (view.released) throw new DomainError({ code: "publishing_plan_slot_past", message: `Slot ${parsed.slotId}'s time has passed`, details });
      if (view.vetoed) throw new DomainError({ code: "publishing_plan_slot_vetoed", message: `Slot ${parsed.slotId} is vetoed; restore it first`, details });
      if (parsed.contentHash !== view.contentHash) throw new DomainError({ code: "publishing_plan_changed", message: `Slot ${parsed.slotId} changed since it was shown; reload the plan`, details });
      const nowMs = ports.now().getTime();
      const youtubeAt = view.foreignPublishAt ?? view.youtubePublishAt;
      const soonest = Math.min(Date.parse(view.publishAtUtc), youtubeAt ? Date.parse(youtubeAt) || Infinity : Infinity);
      if (soonest - nowMs < RETIME_MARGIN_MS) throw new DomainError({ code: "publishing_plan_slot_too_soon", message: `Slot ${parsed.slotId} comes out in less than 15 minutes; it can no longer be moved`, details });
      const targetMeta = snapshot.plans[parsed.toWeekStart];
      const timeZone = targetMeta?.timeZone ?? sourceMeta.timeZone;
      const refused: PlanSaveRefusal[] = [];
      const instant = instantOf(parsed.publishAt, timeZone);
      if (!isCalendarDate(parsed.toWeekStart) || !isMonday(parsed.toWeekStart)) refused.push({ slotId: parsed.slotId, field: "toWeekStart", reason: "week_start_not_monday" });
      else if (!isCalendarDate(parsed.date)) refused.push({ slotId: parsed.slotId, field: "date", reason: "date_invalid" });
      else if (parsed.date < parsed.toWeekStart || parsed.date > addDays(parsed.toWeekStart, 6)) refused.push({ slotId: parsed.slotId, field: "date", reason: "outside_week" });
      else if (!instant) refused.push({ slotId: parsed.slotId, field: "publishAt", reason: "publish_at_invalid" });
      else if (parsed.publishAt.slice(0, 10) !== parsed.date) refused.push({ slotId: parsed.slotId, field: "publishAt", reason: "date_mismatch" });
      else if (instant.getTime() - nowMs < RETIME_APPROVE_MARGIN_MS) refused.push({ slotId: parsed.slotId, field: "publishAt", reason: "in_past" });
      else if (instant.getTime() - nowMs > 52 * 7 * 86_400_000) refused.push({ slotId: parsed.slotId, field: "publishAt", reason: "beyond_horizon" });
      if (!refused.length && parsed.toWeekStart !== stored.weekStart && slotsOf(snapshot, parsed.toWeekStart).length >= PUBLISHING_PLAN_LIMITS.slots) refused.push({ slotId: parsed.slotId, field: "slots", reason: "too_many_slots" });
      if (refused.length > 0) throw refusedError(refused, parsed.toWeekStart);
      const targetUtc = instant!.toISOString();

      // The YouTube side, read before anything is written (plan §3.7 order).
      const progress = state.progress.get(stored.slotId) ?? null;
      const videoId = progress && !isDeletedOnYoutube(progress) ? progress.videoId : null;
      let effect: PlanMoveResult["youtube"]["effect"] = "none";
      let previous: string | null = youtubeAt ?? null;
      if (videoId) {
        const check = ports.moveYoutube ? await ports.moveYoutube.precheck(channelId, videoId) : { outcome: "refused" as const, code: "publishing_plan_move_not_here", reason: "no YouTube writer on this surface" };
        if (check.outcome === "refused") {
          const dated = Boolean(youtubeAt) || progress?.status === "published";
          // An undated video uploaded elsewhere only changes position (D1: a move never dates it anyway).
          if (!(check.code === "publishing_plan_move_not_here" && !dated)) {
            const code = check.code === "live_writes_disabled" || check.code === "data_api_reads_disabled" ? "publishing_plan_move_youtube_unavailable" : check.code;
            throw new DomainError({ code: code as "publishing_plan_move_not_here", message: `The move was refused: ${check.reason}`, details: { ...details, reason: check.code } });
          }
          effect = "plan_only";
        } else {
          effect = check.outcome;
          previous = check.youtubePublishAt;
        }
      }
      const from = { weekStart: stored.weekStart, date: stored.date, publishAt: stored.publishAt, publishAtUtc: view.publishAtUtc, timeZone: sourceMeta.timeZone };
      const to = { weekStart: parsed.toWeekStart, date: parsed.date, publishAt: parsed.publishAt, publishAtUtc: targetUtc, timeZone };
      const samePlace = stored.weekStart === parsed.toWeekStart && stored.publishAt === parsed.publishAt && timeZone === sourceMeta.timeZone;
      const youtubeWouldChange = effect === "moves" && (previous === null || Date.parse(previous) !== Date.parse(targetUtc));
      if (parsed.dryRun) return { plan: null, moved: false, dryRun: true, from, to, youtube: { effect: effect === "moves" && !youtubeWouldChange ? "none" : effect, previous } };

      const at = stamp();
      if (!samePlace) {
        const device = await ports.deviceLabel();
        const seq = Math.max(0, ...Object.values(snapshot.decisions).map((d) => d.seq ?? 0)) + 1;
        const slot: PublishingPlanSlot = {
          ...contentOf({ ...contentOf(stored), date: parsed.date, publishAt: parsed.publishAt }),
          weekStart: parsed.toWeekStart,
          slotId: stored.slotId,
          createdAt: stored.createdAt,
          updatedAt: at,
          updatedBy: by,
          movedFrom: { weekStart: stored.weekStart, publishAt: stored.publishAt, timeZone: sourceMeta.timeZone, at, by },
        };
        await ports.store.moveSlot(channelId, { fromWeekStart: stored.weekStart, slot, createTarget: targetMeta ? null : { weekStart: parsed.toWeekStart, timeZone, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by } });
        const revocations = revocationsFor(snapshot, stored.slotId, parsed.toWeekStart, device, at, seq);
        if (revocations.length > 0) await ports.store.addDecisions(channelId, revocations);
        await ports.audit({ channelId, weekStart: parsed.toWeekStart, slotId: stored.slotId, detail: { event: "publishing_plan.moved", at, from, to, revoked: revocations.map((r) => r.id), youtube: effect, by: by === "owner" ? userId : "producer", actor: by, device } });
        if (by === "owner") ports.notifyOwnerDecision?.();
      }
      let youtube: PlanMoveResult["youtube"] = { effect, previous };
      if (effect === "moves" && youtubeWouldChange && videoId && ports.moveYoutube) {
        const written = await ports.moveYoutube.write(channelId, videoId, stored.slotId, targetUtc, by).catch((error: unknown) => ({ result: "refused", reason: error instanceof Error ? error.message : String(error), publishAt: null }));
        youtube = { effect, previous, result: written.result === "verified" ? "verified" : "failed", ...(written.reason ? { reason: written.reason } : {}), publishAt: written.result === "verified" ? targetUtc : previous };
      }
      const after = await ports.store.read(channelId);
      const meta = after.plans[parsed.toWeekStart];
      return { plan: meta ? await viewOf(channelId, after, meta) : null, moved: !samePlace, dryRun: false, from, to, youtube };
    });
  }

  const template = createTemplateServices(ports, assertChannel);

  return {
    save,
    get,
    list: agentList,
    templateGet: template.get,
    templatePropose: template.propose,
    templateOwnerSave: template.ownerSave,
    templateOwnerDecide: template.ownerDecide,
    templateOwnerWithdraw: template.ownerWithdraw,
    slotDecisions,
    socialSlotStates,
    ownerList: async (channelId: string): Promise<{ plans: PlanSummary[]; waiting: number; approvalStage: PublishingPlanApprovalStage }> => {
      const plans = await list(channelId);
      const approvalStage = stageOf(await ports.store.read(channelId));
      return { plans, waiting: plans.reduce((sum, p) => sum + p.counts.needsApproval, 0), approvalStage };
    },
    setApprovalStage,
    ownerGet: async (channelId: string, weekStart: string): Promise<{ plan: PlanView }> => {
      const { snapshot, meta } = await requirePlan(channelId, weekStart);
      return { plan: await viewOf(channelId, snapshot, meta) };
    },
    decide,
    retime,
    move,
  };
}

export type PublishingPlansService = ReturnType<typeof createPublishingPlansService>;

/** What agents get (MCP): save, get, list, the template read (BL-267) -- never a decision (ADR 0051 §6, AC-WP-05, AC-WT-06). */
export type PublishingPlansAgentSurface = Pick<PublishingPlansService, "save" | "get" | "list" | "templateGet">;
export function agentSurface(service: PublishingPlansAgentSurface): PublishingPlansAgentSurface {
  return { save: (input, by) => service.save(input, by), get: (input) => service.get(input), list: (input) => service.list(input), templateGet: (channelId) => service.templateGet(channelId) };
}

/** What the owner's Web UI routes get: the plans, one plan, the decisions and (BL-242) the approval stage. */
export type PublishingPlansOwnerSurface = Pick<PublishingPlansService, "ownerList" | "ownerGet" | "decide" | "retime" | "setApprovalStage" | "templateGet" | "templateOwnerSave" | "templateOwnerDecide" | "templateOwnerWithdraw"> & {
  /** BL-267 (ADR 0073 §5): the owner's move -- always as the owner. */
  move(channelId: string, input: unknown, userId: string): Promise<PlanMoveResult>;
};
export function ownerSurface(service: Omit<PublishingPlansOwnerSurface, "move"> & Pick<PublishingPlansService, "move">): PublishingPlansOwnerSurface {
  return {
    move: (channelId, input, userId) => service.move(channelId, input, "owner", userId),
    templateGet: (channelId) => service.templateGet(channelId),
    templateOwnerSave: (channelId, input, userId) => service.templateOwnerSave(channelId, input, userId),
    templateOwnerDecide: (channelId, input, userId) => service.templateOwnerDecide(channelId, input, userId),
    templateOwnerWithdraw: (channelId, userId) => service.templateOwnerWithdraw(channelId, userId),
    ownerList: (channelId) => service.ownerList(channelId),
    ownerGet: (channelId, weekStart) => service.ownerGet(channelId, weekStart),
    decide: (channelId, weekStart, input, userId) => service.decide(channelId, weekStart, input, userId),
    retime: (channelId, weekStart, input, userId) => service.retime(channelId, weekStart, input, userId),
    setApprovalStage: (channelId, input, userId) => service.setApprovalStage(channelId, input, userId),
  };
}

/** BL-252 stage 2: what cross-posting reads (ADR 0068 amendment 1) -- never a save or a decision. */
export type PublishingPlansSocialSurface = Pick<PublishingPlansService, "socialSlotStates">;
export function socialSurface(service: PublishingPlansSocialSurface): PublishingPlansSocialSurface {
  return { socialSlotStates: (channelId) => service.socialSlotStates(channelId) };
}

/** BL-225 stage 3: what the uploads read (the slots' decisions) -- never a save or a decision. */
export type PublishingPlansUploadSurface = Pick<PublishingPlansService, "slotDecisions">;
export function uploadSurface(service: PublishingPlansUploadSurface): PublishingPlansUploadSurface {
  return { slotDecisions: (channelId) => service.slotDecisions(channelId) };
}

/** BL-267 (ADR 0073 §5, plan §3.10): what the Producer gets -- reads, its template proposal (stage 6 adds the move). Never a decision. */
export type PublishingPlansProducerSurface = Pick<PublishingPlansService, "get" | "list" | "templateGet" | "templatePropose"> & {
  /** BL-267 (ADR 0073 §5, owner TG 4630/4636): the Producer's move -- always as the Producer, immediate. */
  move(channelId: string, input: unknown): Promise<PlanMoveResult>;
};
export function producerSurface(service: Pick<PublishingPlansService, "get" | "list" | "templateGet" | "templatePropose" | "move">): PublishingPlansProducerSurface {
  return {
    get: (input) => service.get(input),
    list: (input) => service.list(input),
    templateGet: (channelId) => service.templateGet(channelId),
    templatePropose: (channelId, input) => service.templatePropose(channelId, input),
    move: (channelId, input) => service.move(channelId, input, "producer", "producer"),
  };
}
