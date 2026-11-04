import { parseWithSchema } from "@/lib/shared-domain";
import type { PublishingPlanDecision, PublishingPlanMeta, PublishingPlanPackageFingerprint, PublishingPlanSlot, PublishingPlansSnapshot } from "@/lib/sync-gateway";
import { isValidIanaTimezone } from "@/lib/zoned-time";
import { DEFAULT_APPROVAL_STAGE, DomainError, isDeletedOnYoutube, PUBLISHING_PLAN_LIMITS, type PlanSaveRefusal, type PlanSlotDecision, type PlanSlotProgress, type PlanSummary, type PlanView, type PublishingPlanActor, type PublishingPlanApprovalStage, type PublishingPlansPorts, type ReplacedSlot } from "./contracts";
import { addDays, approvalStandsOn, contentHashOf, contentOf, decisionsForStage, decisionStateOf, instantOf, isCalendarDate, isMonday, planViewOf, slotViewOf, standingPackageApprovalOf, standingVetoOf, decisionOrder, lastApprovedPackageOf } from "./model";
import { approvalStageInputSchema, getPlanInputSchema, listPlansInputSchema, ownerDecisionInputSchema, PLAN_LIST_DEFAULT_LIMIT, savePlanInputSchema } from "./schemas";

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

  /** BL-242 (ADR 0062 §1): the channel's approval stage; a document without one is in `packaged`. */
  const stageOf = (snapshot: PublishingPlansSnapshot): PublishingPlanApprovalStage => snapshot.approvalStage ?? DEFAULT_APPROVAL_STAGE;

  function slotsOf(snapshot: PublishingPlansSnapshot, weekStart: string): PublishingPlanSlot[] {
    return Object.values(snapshot.slots).filter((s) => s.weekStart === weekStart);
  }
  function decisionsOf(snapshot: PublishingPlansSnapshot, weekStart: string): PublishingPlanDecision[] {
    return Object.values(snapshot.decisions).filter((d) => d.weekStart === weekStart);
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
      const progress = ports.progress ? ((await ports.progress(channelId, slot.weekStart, [slotId])).get(slotId) ?? null) : null;
      const view = slotViewOf({ stage: stageOf(snapshot), meta, slot, decisions: decisionsOf(snapshot, slot.weekStart).filter((d) => d.slotId === slotId), progress, now: ports.now() });
      out.set(slotId, { slotId, weekStart: slot.weekStart, publishAt: slot.publishAt, video: view.package?.video ?? null, vetoed: view.vetoed !== null, released: view.released, found: true });
    }
    return out;
  }

  type ChannelState = { progress: Map<string, PlanSlotProgress>; counting: Map<string, string[]> };

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
    let progress = new Map<string, PlanSlotProgress>();
    if (ports.progress && ids.size > 0) {
      const read = ports.progress(channelId, "", [...ids].sort());
      progress = failClosed ? await read.catch(() => new Map<string, PlanSlotProgress>()) : await read;
    }
    const counting = new Map<string, string[]>();
    if (stage === "packaged") {
      for (const meta of Object.values(snapshot.plans)) {
        const view = planViewOf({ stage, channelId, meta, slots: slotsOf(snapshot, meta.weekStart), decisions: decisionsOf(snapshot, meta.weekStart), progress, now });
        for (const slot of view.slots) {
          if (slot.vetoed || slot.released || slot.approval !== "approved" || !slot.fingerprint) continue;
          counting.set(slot.fingerprint.video, [...(counting.get(slot.fingerprint.video) ?? []), slot.slotId]);
        }
      }
    }
    return { progress, counting };
  }

  async function viewOf(channelId: string, snapshot: PublishingPlansSnapshot, meta: PublishingPlanMeta, known?: ChannelState): Promise<PlanView> {
    const slots = slotsOf(snapshot, meta.weekStart);
    const state = known ?? (await channelState(channelId, snapshot, slots.map((s) => s.slotId)));
    const replaced = await replacedOf(channelId, snapshot, slots.flatMap((s) => (s.replacesSlotId ? [s.replacesSlotId] : [])));
    const view = planViewOf({ stage: stageOf(snapshot), channelId, meta, slots, decisions: decisionsOf(snapshot, meta.weekStart), progress: state.progress, now: ports.now(), replaced });
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
      // BL-242: an approval that counts in the channel's stage stands on the slot (the `packaged` stage: whatever its package now).
      const stage = stageOf(snapshot);
      const approvedNow = (slot: PublishingPlanSlot) => existing !== null && approvalStandsOn(stage, existing.timeZone, contentOf(slot), decisionsFor(slot.slotId));

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

      const removes: string[] = [];
      const vetoedRemoves: string[] = [];
      // Review #3: what the uploads say of the slots to remove (a slot whose video is on YouTube stays).
      const toRemove = [...new Set(parsed.removeSlotIds ?? [])];
      const uploads = toRemove.length > 0 && ports.progress ? await ports.progress(channelId, weekStart, toRemove) : new Map();
      for (const slotId of toRemove) {
        const slot = current.get(slotId);
        const state = slot && existing ? decisionStateOf(decisionsForStage(decisionsFor(slotId), stage), contentHashOf(existing.timeZone, contentOf(slot))) : null;
        const upload = uploads.get(slotId);
        // BL-243: a video deleted on YouTube is not on YouTube -- its vetoed slot may go.
        const uploaded = Boolean(upload && !isDeletedOnYoutube(upload) && (upload.videoId || ["uploading", "scheduled", "published"].includes(upload.status)));
        if (!slot) refused.push({ slotId, field: "removeSlotIds", reason: "unknown_slot" });
        else if (state?.vetoed) {
          // BL-240 (ADR 0060): a vetoed slot may go, also one approved before the veto -- unless its video is on YouTube.
          if (uploaded) refused.push({ slotId, field: "removeSlotIds", reason: "slot_uploaded" });
          else if (seen.has(slotId)) refused.push({ slotId, field: "removeSlotIds", reason: "duplicate_slot" });
          else {
            removes.push(slotId);
            vetoedRemoves.push(slotId);
          }
        } else if (state && (state.approved || state.superseded)) refused.push({ slotId, field: "removeSlotIds", reason: "slot_approved" });
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
      for (const slotId of vetoedRemoves) {
        await ports.audit({ channelId, weekStart, slotId, detail: { event: "publishing_plan.vetoed_slot_removed", at, weekStart, slotId, by } });
      }
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
    return ports.withLock(async () => {
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
        }));
        // BL-240 (ADR 0060): approving a slot that replaces another vetoes that one in the same decision -- unless it is already
        // vetoed, released or gone. It is the owner's own veto (restorable), recorded with the slot that replaced it.
        const implied: Array<{ record: PublishingPlanDecision; publishAtUtc: string }> = [];
        if (action === "approve") {
          for (const slot of effective) {
            const target = slot.replaces;
            if (!target?.found || target.vetoed || target.released || implied.some((i) => i.record.slotId === target.slotId)) continue;
            const targetSlot = findSlot(snapshot, target.slotId);
            const targetMeta = targetSlot ? snapshot.plans[targetSlot.weekStart] : undefined;
            if (!targetSlot || !targetMeta) continue;
            const content = contentOf(targetSlot);
            implied.push({
              record: {
                seq,
                id: `pd_${ports.randomId()}`.slice(0, 40),
                weekStart: targetSlot.weekStart,
                slotId: targetSlot.slotId,
                kind: "vetoed",
                contentHash: contentHashOf(targetMeta.timeZone, content),
                snapshot: { ...content, timeZone: targetMeta.timeZone },
                by: "owner",
                device,
                at,
                replacedBy: slot.slotId,
              },
              publishAtUtc: (instantOf(targetSlot.publishAt, targetMeta.timeZone) ?? new Date(0)).toISOString(),
            });
          }
        }
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
      }
      const after = await requirePlan(channelId, weekStart);
      return { plan: await viewOf(channelId, after.snapshot, after.meta), decided: effective.map((s) => s.slotId), replacedVetoed };
    });
  }

  /**
   * BL-242 (ADR 0062 §1, AC-WP-50): the owner's approval stage of the channel (Web UI only). One change and one audit event when it
   * changes; the same stage again writes nothing.
   */
  async function setApprovalStage(channelId: string, input: unknown, userId: string): Promise<{ approvalStage: PublishingPlanApprovalStage; changed: boolean }> {
    const { stage } = parseWithSchema(approvalStageInputSchema, input, "approval stage");
    return ports.withLock(async () => {
      const before = stageOf(await ports.store.read(channelId));
      if (before === stage) return { approvalStage: stage, changed: false };
      await ports.store.setApprovalStage(channelId, stage);
      const device = await ports.deviceLabel();
      await ports.audit({ channelId, weekStart: null, slotId: null, detail: { event: "publishing_plan.approval_stage", at: stamp(), from: before, to: stage, by: userId, device } });
      return { approvalStage: stage, changed: true };
    });
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
    for (const meta of Object.values(snapshot.plans)) {
      const planDecisions = decisionsOf(snapshot, meta.weekStart);
      const slots = slotsOf(snapshot, meta.weekStart);
      const view = planViewOf({ stage, channelId, meta, slots, decisions: planDecisions, progress, now: ports.now() });
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
            decisions.set(slot.slotId, { kind: "approved", publishAt: slot.publishAtUtc, package: { ...slot.fingerprint } });
            naming.set(slot.slotId, { record, kind: "approved", package: slot.fingerprint });
          } else decisions.set(slot.slotId, { kind: "pending" });
          continue;
        }
        decisions.set(
          slot.slotId,
          slot.released ? { kind: "pending" } : slot.vetoed ? { kind: "vetoed" } : slot.approval === "approved" ? { kind: "approved", publishAt: slot.publishAtUtc } : { kind: "pending" }
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

  return {
    save,
    get,
    list: agentList,
    slotDecisions,
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
  };
}

export type PublishingPlansService = ReturnType<typeof createPublishingPlansService>;

/** What agents get (MCP): save, get, list -- never a decision (ADR 0051 §6, AC-WP-05). */
export type PublishingPlansAgentSurface = Pick<PublishingPlansService, "save" | "get" | "list">;
export function agentSurface(service: PublishingPlansAgentSurface): PublishingPlansAgentSurface {
  return { save: (input, by) => service.save(input, by), get: (input) => service.get(input), list: (input) => service.list(input) };
}

/** What the owner's Web UI routes get: the plans, one plan, the decisions and (BL-242) the approval stage. */
export type PublishingPlansOwnerSurface = Pick<PublishingPlansService, "ownerList" | "ownerGet" | "decide" | "setApprovalStage">;
export function ownerSurface(service: PublishingPlansOwnerSurface): PublishingPlansOwnerSurface {
  return {
    ownerList: (channelId) => service.ownerList(channelId),
    ownerGet: (channelId, weekStart) => service.ownerGet(channelId, weekStart),
    decide: (channelId, weekStart, input, userId) => service.decide(channelId, weekStart, input, userId),
    setApprovalStage: (channelId, input, userId) => service.setApprovalStage(channelId, input, userId),
  };
}

/** BL-225 stage 3: what the uploads read (the slots' decisions) -- never a save or a decision. */
export type PublishingPlansUploadSurface = Pick<PublishingPlansService, "slotDecisions">;
export function uploadSurface(service: PublishingPlansUploadSurface): PublishingPlansUploadSurface {
  return { slotDecisions: (channelId) => service.slotDecisions(channelId) };
}
