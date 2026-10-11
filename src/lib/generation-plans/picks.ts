import { pickTargetOf, type PlanItem, type PlanNoneFitsView, type PlanPickAction, type PlanPickMark, type PlanPickRecord, type PlanPickView } from "./contracts";

// ---------------------------------------------------------------------------
// BL-175 (FO-REQ-0018 §B, docs/roadmap/plans/VISUAL_REVIEW_PLAN.md §2.2/§2.3): the owner's picks ("this one of N") and "none
// fits" on an item. A pick is not a verdict: it writes no result row and no verdict history. Pure functions -- the services
// load the records, apply one action here, and store what it returns. The same rules serve the owner's own actions and the
// actions another computer sends (newer by the owner's time wins).
// ---------------------------------------------------------------------------

/** An item's active picks (oldest first) and its active "none fits" with the attempts it covered. */
export type ItemPickState = { picks: PlanPickView[]; noneFits: (PlanNoneFitsView & { covered: string[] }) | null };

const ms = (iso: string) => Date.parse(iso);

/** The active picks and "none fits" of each item that has any. */
export function pickStateOf(records: readonly PlanPickRecord[]): Map<string, ItemPickState> {
  const out = new Map<string, ItemPickState>();
  const state = (itemKey: string) => {
    let s = out.get(itemKey);
    if (!s) {
      s = { picks: [], noneFits: null };
      out.set(itemKey, s);
    }
    return s;
  };
  for (const r of records) {
    if (!r.active) continue;
    if (r.kind === "pick" && r.attemptRef !== null) state(r.itemKey).picks.push({ attemptRef: r.attemptRef, device: r.device, at: r.at, note: r.note });
    else if (r.kind === "none_fits") state(r.itemKey).noneFits = { note: r.note, device: r.device, at: r.at, attempts: r.covered.length, covered: [...r.covered] };
  }
  for (const s of out.values()) s.picks.sort((a, b) => ms(a.at) - ms(b.at) || a.attemptRef.localeCompare(b.attemptRef));
  return out;
}

/**
 * The flags of one attempt (§2.3): `picked` when it has an active pick; `notChosen` when it has no verdict, is not picked, and
 * its item is decided -- as many picks as its pick target, or an active "none fits" that covers it.
 */
export function pickFlagsOf(state: ReadonlyMap<string, ItemPickState>, items: ReadonlyArray<Pick<PlanItem, "itemKey" | "mode" | "targetCount" | "pickTarget">>) {
  const targets = new Map(items.map((i) => [i.itemKey, pickTargetOf(i)]));
  return (itemKey: string, attemptRef: string, hasVerdict: boolean): { picked: PlanPickMark | null; notChosen: boolean } => {
    const s = state.get(itemKey);
    if (!s) return { picked: null, notChosen: false };
    const pick = s.picks.find((p) => p.attemptRef === attemptRef);
    const picked = pick ? { device: pick.device, at: pick.at, note: pick.note } : null;
    if (picked || hasVerdict) return { picked, notChosen: false };
    const decided = s.picks.length >= (targets.get(itemKey) ?? 1) || (s.noneFits !== null && s.noneFits.covered.includes(attemptRef));
    return { picked: null, notChosen: decided };
  };
}

export type PickActionInput = { itemKey: string; attemptRef: string | null; action: PlanPickAction; note: string | null; device: string; at: string };

export type PickContext = {
  /** Every record of the item (active or not). */
  records: readonly PlanPickRecord[];
  /** The item's pick target (`pickTargetOf`). */
  target: number;
  /** The item's attempts in the owner's review queue now. */
  queueRefs: readonly string[];
  /** Attempts whose current owner verdict is `rejected`. */
  rejected: ReadonlySet<string>;
  /** Attempts the stage right before the owner review rejected (a pick of one overrides the validator). */
  validatorRejected: ReadonlySet<string>;
};

export type PickEvent = { kind: "owner_pick" | "owner_unpick" | "owner_none_fits"; details: Record<string, unknown> };

export type PickOutcome =
  | { outcome: "applied"; writes: PlanPickRecord[]; events: PickEvent[] }
  /** Already so (a repeated pick, an unpick of an attempt that is not picked): nothing to write. */
  | { outcome: "unchanged" }
  /** Something newer already decided it (another computer's later action): nothing to write. */
  | { outcome: "superseded"; reason: string }
  /** Not possible at all: an attempt that is not in the queue, a rejected one, a pick without an attempt. */
  | { outcome: "refused"; reason: "unknown_attempt" | "rejected" | "attempt_required" };

const newer = (a: string, b: string) => ms(a) > ms(b);

/**
 * One action on one item (§2.2). Withdrawals keep the record with `active` false and the action's time. A pick clears an
 * active "none fits"; with the item already at its pick target, its oldest picks make room (with a target of 1, the pick
 * moves); "none fits" withdraws the item's picks and covers the attempts the queue lists for it now.
 */
export function applyPickAction(input: PickActionInput, ctx: PickContext): PickOutcome {
  const { itemKey, at, device } = input;
  const records = ctx.records.filter((r) => r.itemKey === itemKey);
  const pickOf = (ref: string) => records.find((r) => r.kind === "pick" && r.attemptRef === ref);
  const noneFits = records.find((r) => r.kind === "none_fits");
  const activePicks = records.filter((r) => r.kind === "pick" && r.active).sort((a, b) => ms(a.at) - ms(b.at));
  const withdraw = (r: PlanPickRecord): PlanPickRecord => ({ ...r, active: false, at, device });
  const writes: PlanPickRecord[] = [];
  const events: PickEvent[] = [];

  switch (input.action) {
    case "pick": {
      const ref = input.attemptRef;
      if (ref === null) return { outcome: "refused", reason: "attempt_required" };
      if (!ctx.queueRefs.includes(ref)) return { outcome: "refused", reason: "unknown_attempt" };
      if (ctx.rejected.has(ref)) return { outcome: "refused", reason: "rejected" };
      const own = pickOf(ref);
      if (own?.active) return { outcome: "unchanged" };
      if (own && newer(own.at, at)) return { outcome: "superseded", reason: "withdrawn_later" };
      if (noneFits?.active && newer(noneFits.at, at)) return { outcome: "superseded", reason: "none_fits_later" };
      const room = [...activePicks];
      while (room.length >= Math.max(1, ctx.target)) {
        const oldest = room.shift() as PlanPickRecord;
        if (newer(oldest.at, at)) return { outcome: "superseded", reason: "picked_later" };
        writes.push(withdraw(oldest));
        events.push({ kind: "owner_unpick", details: { itemKey, attemptRef: oldest.attemptRef, device, reason: "moved" } });
      }
      if (noneFits?.active) {
        writes.push(withdraw(noneFits));
        events.push({ kind: "owner_none_fits", details: { itemKey, device, cleared: true } });
      }
      writes.push({ itemKey, kind: "pick", attemptRef: ref, active: true, note: input.note, device, at, covered: [] });
      events.push({ kind: "owner_pick", details: { itemKey, attemptRef: ref, device, ...(input.note ? { note: input.note } : {}), ...(ctx.validatorRejected.has(ref) ? { overridesValidator: true } : {}) } });
      return { outcome: "applied", writes, events };
    }
    case "unpick": {
      const ref = input.attemptRef;
      if (ref === null) return { outcome: "refused", reason: "attempt_required" };
      const own = pickOf(ref);
      if (!own?.active) return { outcome: "unchanged" };
      if (newer(own.at, at)) return { outcome: "superseded", reason: "picked_later" };
      return { outcome: "applied", writes: [withdraw(own)], events: [{ kind: "owner_unpick", details: { itemKey, attemptRef: ref, device, reason: "withdrawn" } }] };
    }
    case "none_fits": {
      if (noneFits && newer(noneFits.at, at)) return { outcome: "superseded", reason: "none_fits_later" };
      if (activePicks.some((p) => newer(p.at, at))) return { outcome: "superseded", reason: "picked_later" };
      for (const p of activePicks) {
        writes.push(withdraw(p));
        events.push({ kind: "owner_unpick", details: { itemKey, attemptRef: p.attemptRef, device, reason: "none_fits" } });
      }
      const covered = [...new Set(ctx.queueRefs)];
      writes.push({ itemKey, kind: "none_fits", attemptRef: null, active: true, note: input.note, device, at, covered });
      events.push({ kind: "owner_none_fits", details: { itemKey, device, ...(input.note ? { note: input.note } : {}), attempts: covered.length } });
      return { outcome: "applied", writes, events };
    }
    case "clear_none_fits": {
      if (!noneFits?.active) return { outcome: "unchanged" };
      if (newer(noneFits.at, at)) return { outcome: "superseded", reason: "none_fits_later" };
      return { outcome: "applied", writes: [withdraw(noneFits)], events: [{ kind: "owner_none_fits", details: { itemKey, device, cleared: true } }] };
    }
  }
}

/**
 * §2.2: an attempt is never both picked and rejected -- a `rejected` owner verdict on a picked attempt withdraws its pick, also
 * when the verdict was given before the pick on the other computer and arrives late (the rejection is the explicit word). The
 * withdrawal is dated no earlier than the pick, so the pick's own older actions stay superseded. Null when it is not picked.
 */
export function withdrawPickOnReject(records: readonly PlanPickRecord[], itemKey: string, attemptRef: string, at: string, device: string): { writes: PlanPickRecord[]; events: PickEvent[] } | null {
  const pick = records.find((r) => r.itemKey === itemKey && r.kind === "pick" && r.attemptRef === attemptRef && r.active);
  if (!pick) return null;
  const when = newer(pick.at, at) ? pick.at : at;
  return { writes: [{ ...pick, active: false, at: when, device }], events: [{ kind: "owner_unpick", details: { itemKey, attemptRef, device, reason: "rejected" } }] };
}

/** The plan as another computer's report carries it -- what `withSentPicks` needs of it. */
export type SharedPickPlan = {
  items: ReadonlyArray<Pick<PlanItem, "itemKey" | "mode" | "targetCount"> & { pickTarget?: number }>;
  picks?: ReadonlyArray<{ itemKey: string; attemptRef: string; device: string; at: string; note: string | null }>;
  noneFits?: ReadonlyArray<{ itemKey: string; note: string | null; device: string; at: string; attempts: number }>;
  /** The ids of the pick actions that device already weighed (applied or superseded). */
  handledPicks?: readonly string[];
};

/** A pick action this computer sent to another computer's plan (the report's `picks`). */
export type SentPickAction = { pickId: string; itemKey: string; attemptRef: string | null; action: PlanPickAction; note: string | null; at: string };

/**
 * BL-175 (VISUAL_REVIEW_PLAN.md §2.6): another computer's plan as THIS computer shows it -- the pick actions sent from here that
 * the owning computer has not weighed yet (`handledPicks`) are played over its state with the same rules (`applyPickAction`), and
 * each entry's `picked` / `notChosen` follow. `pickSent` marks an attempt picked from here and on its way. Pure (the review
 * screen, the plan card and this computer's badge all read it). With nothing pending, the entries come back as they are.
 */
export function withSentPicks<E extends { itemKey: string; attemptRef: string; verdict: { result: string } | null; picked?: PlanPickMark; notChosen?: boolean }>(
  plan: SharedPickPlan,
  review: readonly E[],
  sent: readonly SentPickAction[],
  device: string
): Array<E & { pickSent?: true }> {
  const handled = new Set(plan.handledPicks ?? []);
  const pending = sent.filter((a) => !handled.has(a.pickId)).sort((a, b) => ms(a.at) - ms(b.at));
  if (pending.length === 0) return [...review];
  let records: PlanPickRecord[] = [
    ...(plan.picks ?? []).map((p): PlanPickRecord => ({ itemKey: p.itemKey, kind: "pick", attemptRef: p.attemptRef, active: true, note: p.note, device: p.device, at: p.at, covered: [] })),
    // What a "none fits" there covers: the item's entries it shows as not chosen (no picks can stand beside it).
    ...(plan.noneFits ?? []).map((n): PlanPickRecord => ({ itemKey: n.itemKey, kind: "none_fits", attemptRef: null, active: true, note: n.note, device: n.device, at: n.at, covered: review.filter((e) => e.itemKey === n.itemKey && e.notChosen === true).map((e) => e.attemptRef) })),
  ];
  const sentPicks = new Set<string>();
  const key = (itemKey: string, ref: string) => `${itemKey}\u0000${ref}`;
  for (const a of pending) {
    const item = plan.items.find((i) => i.itemKey === a.itemKey);
    if (!item) continue;
    const own = review.filter((e) => e.itemKey === a.itemKey);
    const outcome = applyPickAction(
      { itemKey: a.itemKey, attemptRef: a.attemptRef, action: a.action, note: a.note, device, at: a.at },
      {
        records: records.filter((r) => r.itemKey === a.itemKey),
        target: pickTargetOf(item),
        queueRefs: own.map((e) => e.attemptRef),
        rejected: new Set(own.filter((e) => e.verdict?.result === "rejected").map((e) => e.attemptRef)),
        validatorRejected: new Set(),
      }
    );
    if (outcome.outcome !== "applied") continue;
    const same = (x: PlanPickRecord, w: PlanPickRecord) => x.itemKey === w.itemKey && x.kind === w.kind && (x.attemptRef ?? "") === (w.attemptRef ?? "");
    records = [...records.filter((r) => !outcome.writes.some((w) => same(r, w))), ...outcome.writes];
    for (const w of outcome.writes) {
      if (w.kind !== "pick" || w.attemptRef === null) continue;
      if (w.active) sentPicks.add(key(w.itemKey, w.attemptRef));
      else sentPicks.delete(key(w.itemKey, w.attemptRef));
    }
  }
  const flags = pickFlagsOf(pickStateOf(records), plan.items);
  return review.map((e) => {
    const { picked: _picked, notChosen: _notChosen, ...rest } = e;
    void _picked;
    void _notChosen;
    const mark = flags(e.itemKey, e.attemptRef, e.verdict !== null);
    return {
      ...rest,
      ...(mark.picked ? { picked: mark.picked } : {}),
      ...(mark.notChosen ? { notChosen: true } : {}),
      ...(mark.picked && sentPicks.has(key(e.itemKey, e.attemptRef)) ? { pickSent: true as const } : {}),
    } as E & { pickSent?: true };
  });
}
