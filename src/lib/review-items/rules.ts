// BL-272 (ADR 0076): the rule two owner review queues share -- the clips for review (ADR 0061) and the master still images.
// A shared module (AGENTS.md §M): it knows no feature module; each queue passes its own records.

/** The fields of a decision record the rule reads. */
export type DecidingCandidate = { id: string; at: string; by: "owner" | "producer"; kind: string };

const byTimeThenId = (a: DecidingCandidate, b: DecidingCandidate) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);

/**
 * ADR 0061 §5: the record that decides an item -- the EARLIEST owner decision (by time, then id) among `ownerKinds`; without one,
 * the earliest Producer `withdrawn`; null while pending. A later owner decision made offline on the other computer is kept in the
 * document but does not count. `records` are the item's own records (the caller filters by item).
 */
export function earliestDecidingRecord<T extends DecidingCandidate>(records: readonly T[], ownerKinds: readonly string[]): T | null {
  const owner = records.filter((d) => d.by === "owner" && ownerKinds.includes(d.kind)).sort(byTimeThenId);
  if (owner.length > 0) return owner[0];
  const withdrawn = records.filter((d) => d.by === "producer" && d.kind === "withdrawn").sort(byTimeThenId);
  return withdrawn[0] ?? null;
}
