// Shared between this module's own contracts.ts and decisions-manager.tsx's UI ("use client") --
// the client must offer only the transitions the server actually allows, without maintaining a
// second, hand-copied table that can drift (the same duplication class as the Phase 9 Part II
// merge-review's finding #10, `market-velocity-format.ts`). Deliberately zero imports of its own
// (no `node:crypto`/db chain) so a client component can import it directly without pulling in
// `contracts.ts`'s own heavier dependency chain.
export type ExperimentStatus = "proposed" | "approved" | "running" | "concluded" | "abandoned";

export const EXPERIMENT_STATUS_TRANSITIONS: Record<ExperimentStatus, readonly ExperimentStatus[]> = {
  proposed: ["approved", "abandoned"],
  approved: ["running", "abandoned"],
  running: ["concluded", "abandoned"],
  concluded: [],
  abandoned: [],
};

export const EXPERIMENT_OUTCOME_RECORDABLE_STATUSES: readonly ExperimentStatus[] = [
  "running",
  "concluded",
  "abandoned",
];

export const EXPERIMENT_STATUS_LABELS: Record<ExperimentStatus, string> = {
  proposed: "Proposed",
  approved: "Approved",
  running: "Running",
  concluded: "Concluded",
  abandoned: "Abandoned",
};
