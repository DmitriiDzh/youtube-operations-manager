// The one set of tolerant readers for vendor JSON (RunPod, ComfyUI, transcript providers, ...): a missing
// or mistyped field is a default, never a throw (AGENTS.md §M, Phase 14 review round 13 -- previously two
// private copies with different null semantics).

/** The value as an object (arrays excluded), or `{}` -- for readers that go on to pick fields. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The value as an object, or `null` -- for readers that must know whether an object was there at all. */
export function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
