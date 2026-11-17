import { DomainError, isDomainError } from "@/lib/shared-domain";
import {
  clampTimeoutSeconds,
  WAIT_CLI_HINT,
  WAIT_MAX_FAILED_READS,
  WAIT_POLL_MS,
  WAIT_TARGETS,
  WAIT_UNTIL,
  WaitNotFoundError,
  type WaitInput,
  type WaitObservation,
  type WaitOutcome,
  type WaitPort,
  type WaitResult,
  type WaitScope,
  type WaitTarget,
} from "./contracts";

// BL-271 (docs/roadmap/plans/WAIT_TOOLS_PLAN.md §3.1, ADR 0075): the one wait core. Pure: the ports (one read per target), the clock,
// the sleep, the server's stop signal and the "a restart is under way" read are injected (src/composition/wait-targets.ts).

export type OperationWaitDependencies = {
  /** One read per target; a target left out (its module disabled or missing) answers `target_unavailable` (AGENTS.md §M). */
  ports: Partial<Record<WaitTarget, WaitPort>>;
  now: () => number;
  /** Resolves after `ms`, or at once when `signal` is aborted (never rejects): shared-async's sleep. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Aborted when this process received its stop signal (SIGTERM/SIGINT). */
  shutdownSignal: () => AbortSignal;
  /** Whether a restart of this server is under way right now (a cheap read; a failure counts as "no"). */
  restarting: () => Promise<boolean>;
  /** Poll intervals (tests shorten them). */
  pollMs?: Partial<Record<WaitTarget, number>>;
};

function invalid(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError({ code: "invalid_request", message, details });
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const optionalString = (fields: Record<string, unknown>, name: string, max: number): string | undefined => {
  const value = fields[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw invalid(`${name} must be a string of 1-${max} characters`, { field: name });
  return value;
};

/** The input checked again (the endpoints' schemas give the shape; this is the rule every endpoint shares). */
export function parseWaitInput(raw: unknown): WaitInput {
  const fields = record(raw);
  const target = fields.target;
  if (typeof target !== "string" || !(WAIT_TARGETS as readonly string[]).includes(target)) {
    throw invalid(`target must be one of ${WAIT_TARGETS.join(", ")}`, { field: "target" });
  }
  const id = optionalString(fields, "id", 128);
  if (id === undefined) throw invalid("id is required", { field: "id" });
  const channelId = optionalString(fields, "channelId", 64);
  const storyboardId = optionalString(fields, "storyboardId", 64);
  const until = optionalString(fields, "until", 16);
  const allowed = WAIT_UNTIL[target as WaitTarget];
  if (until !== undefined && !(allowed ?? []).includes(until)) {
    throw invalid(allowed ? `until must be one of ${allowed.join(", ")} for ${target}` : `${target} takes no until`, { field: "until" });
  }
  if ((target === "translation_request" || target === "storyboard_review" || target === "storyboard_render") && channelId === undefined) {
    throw invalid(`${target} needs channelId`, { field: "channelId" });
  }
  if (target === "storyboard_render" && storyboardId === undefined) throw invalid("storyboard_render needs storyboardId", { field: "storyboardId" });
  if (fields.timeoutSeconds !== undefined && (typeof fields.timeoutSeconds !== "number" || !Number.isFinite(fields.timeoutSeconds))) {
    throw invalid("timeoutSeconds must be a number (it is clamped to 1-240)", { field: "timeoutSeconds" });
  }
  return {
    target: target as WaitTarget,
    id,
    ...(channelId !== undefined ? { channelId } : {}),
    ...(storyboardId !== undefined ? { storyboardId } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(typeof fields.timeoutSeconds === "number" ? { timeoutSeconds: fields.timeoutSeconds } : {}),
  };
}

/** Errors a port passes through unchanged: they are answers, not failed reads. */
const PASS_THROUGH = new Set(["no_restart_request", "invalid_request", "CHANNEL_NOT_ACTIVE"]);

export function createOperationWait(deps: OperationWaitDependencies) {
  const notFound = (input: WaitInput) =>
    new DomainError({ code: "not_found", message: `No ${input.target} with this id on this computer.`, details: { target: input.target, id: input.id } });

  return {
    /**
     * Waits until the target is final, the timeout passes, the server stops or a restart starts -- whichever comes first. Reads at
     * once (a target already final returns without any sleep), then every poll interval.
     */
    async waitFor(raw: unknown, scope: WaitScope): Promise<WaitResult> {
      const input = parseWaitInput(raw);
      const port = deps.ports[input.target];
      if (!port) throw new DomainError({ code: "target_unavailable", message: `Waiting on ${input.target} is not available on this server.`, details: { target: input.target } });
      const timeoutMs = clampTimeoutSeconds(input.timeoutSeconds) * 1000;
      const pollMs = deps.pollMs?.[input.target] ?? WAIT_POLL_MS[input.target];
      const signal = deps.shutdownSignal();
      const started = deps.now();
      const deadline = started + timeoutMs;
      let last: WaitObservation | null = null;
      let failures = 0;

      const result = (observation: WaitObservation, override?: { final: false; outcome: WaitOutcome }): WaitResult => {
        const final = override ? false : observation.final;
        return {
          target: input.target,
          id: observation.id,
          final,
          outcome: override?.outcome ?? observation.outcome,
          status: observation.status,
          snapshot: observation.snapshot,
          waitedSeconds: Math.round((deps.now() - started) / 1000),
          ...(final ? {} : { nextCallHint: WAIT_CLI_HINT }),
        };
      };

      // Pinned after the first observation: `restart current` and an upload's video code resolve once, so the wait follows THAT
      // request / upload row to its end (a cancelled current request ends cancelled, a newer upload of the same video does not take
      // over); a pinned id that later reads as missing is a failed read.
      let target = input;
      for (;;) {
        let observation: WaitObservation | null = null;
        try {
          observation = await port(target, scope);
          failures = 0;
        } catch (error) {
          if (isDomainError(error) && PASS_THROUGH.has(error.code)) throw error;
          // Never seen: a missing id (or another channel's) -- answered at once. Seen before and gone now: a failed read (a document
          // that could not be read looks empty), retried at the next poll.
          if (error instanceof WaitNotFoundError && last === null) throw notFound(input);
          failures += 1;
          if (failures >= WAIT_MAX_FAILED_READS) {
            throw new DomainError({ code: "target_unavailable", message: `${input.target} could not be read ${failures} times in a row.`, details: { target: input.target, id: input.id } });
          }
        }
        if (observation) {
          last = observation;
          if (target.id !== observation.id) target = { ...input, id: observation.id };
          if (observation.final) return result(observation);
          // Answers that end the call at once although the operation is not finished (plan §3.2).
          if (observation.outcome === "blocked" || observation.outcome === "not_in_review") return result(observation);
          if (input.target !== "restart" && (await deps.restarting().catch(() => false))) return result(observation, { final: false, outcome: "restarting" });
        }
        if (signal.aborted) return stopped();
        const remaining = deadline - deps.now();
        if (remaining <= 0) {
          if (last) return result(last, { final: false, outcome: "still_running" });
          throw new DomainError({ code: "target_unavailable", message: `${input.target} could not be read before the timeout.`, details: { target: input.target, id: input.id } });
        }
        await deps.sleep(Math.min(pollMs, remaining), signal);
        if (signal.aborted) return stopped();
      }

      function stopped(): WaitResult {
        if (last) return result(last, { final: false, outcome: "server_stopping" });
        return { target: input.target, id: input.id, final: false, outcome: "server_stopping", status: "unknown", snapshot: {}, waitedSeconds: Math.round((deps.now() - started) / 1000), nextCallHint: WAIT_CLI_HINT };
      }
    },
  };
}

export type OperationWait = ReturnType<typeof createOperationWait>;
