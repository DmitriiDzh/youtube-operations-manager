import { createFactoryMediaDeps } from "@/app/api/mcp/factory-media-deps";
import { createGeminiMediaCore, geminiInputHashes } from "@/lib/gemini-media";
import { createMediaGenerationCore } from "@/lib/media-generation";
import { createJobInputSchema as geminiCreateJobSchema } from "@/lib/gemini-media/schemas";
import { createSystemTopicCore, type SystemApprovalAction, type SystemTopicCore } from "@/lib/system-topic";
import { gpuAvailabilityInput, startSessionInput } from "@/mcp/factory-server";

/**
 * BL-228 (SYSTEM_TOPIC_PLAN.md §5 as amended, ADR 0053 Amendment 1; FO-RESP-0043 Q5, owner msg 3607): the two paid actions an owner
 * may approve through the System topic, composed at the app layer (AGENTS.md §M: system-topic imports no media module). Each one is
 * the SAME schema and service code as its Factory MCP tool -- `factory_media_start_session` (and the free test action
 * `factory_media_get_gpu_availability`, FO-RESP-0045) through the factory media wiring, and `factory_gemini_create_job` through the
 * Gemini core -- so the owner's factory and Gemini limits stay the ceiling. On top: the Manager's own estimate and per-approval cap.
 */

const round2 = (value: number) => Math.round(value * 100) / 100;
const MEDIA_CAP_USD = 2;
const GEMINI_CAP_USD = 1;

type FactoryMediaSettings = {
  factorySessionsEnabled: boolean;
  limits: { maxUsdPerSession: number; maxMinutesPerSession: number; maxUsdPerDay: number; maxUsdPerMonth: number };
  spentOrReservedUsd: { today: number; thisMonth: number };
  gpu: { onDemandPricePerHr: number | null };
};

/** The inputs this composition needs, injectable for its tests. */
export type SystemApprovalServices = {
  mediaSettings(): Promise<FactoryMediaSettings>;
  startSession(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Withdraws a session the factory started (a pending one ends at no cost): the factory stop path. */
  endSession(sessionId: string): Promise<unknown>;
  /** The registry template's own GPU price cap, or null (no template, none set). */
  templateMaxPricePerHr(templateId: string): Promise<number | null>;
  gpuAvailability(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Each input file's SHA-256 (throws when one cannot be read). */
  geminiInputHashes(args: Record<string, unknown>): Promise<Record<string, string>>;
  geminiCreateJob(args: Record<string, unknown>, actor: string): Promise<Record<string, unknown>>;
};

export function productionApprovalServices(): SystemApprovalServices {
  return {
    mediaSettings: async () => (await createFactoryMediaDeps().getSettings()).settings as FactoryMediaSettings,
    startSession: (args) => createFactoryMediaDeps().startSession(args as Parameters<ReturnType<typeof createFactoryMediaDeps>["startSession"]>[0]),
    endSession: (sessionId) => createFactoryMediaDeps().endSession({ sessionId }),
    templateMaxPricePerHr: async (templateId) => {
      const template = (await createMediaGenerationCore().listWorkflowTemplates()).find((t) => t.templateId === templateId);
      return template?.gpu?.maxPricePerHr ?? null;
    },
    gpuAvailability: (args) => createFactoryMediaDeps().gpuAvailability(args as Parameters<ReturnType<typeof createFactoryMediaDeps>["gpuAvailability"]>[0]),
    geminiInputHashes: (args) => geminiInputHashes(args as Parameters<typeof geminiInputHashes>[0]),
    geminiCreateJob: (args, actor) => createGeminiMediaCore().createJob(args, actor) as Promise<Record<string, unknown>>,
  };
}

const issueText = (issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) =>
  issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join(".") || "(args)"}: ${issue.message}`)
    .join("; ");

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createSystemApprovalActions(services: SystemApprovalServices): Record<string, SystemApprovalAction> {
  const mediaStart: SystemApprovalAction = {
    capUsd: MEDIA_CAP_USD,
    parse(args) {
      const parsed = startSessionInput.safeParse(args);
      if (!parsed.success) return { ok: false, error: issueText(parsed.error.issues) };
      const input = parsed.data;
      // FO-RESP-0043 Q5: a session approved here must have its own caps and must stop by itself.
      if (input.maxMinutes === undefined) return { ok: false, error: "maxMinutes is required" };
      if (input.maxUsd === undefined) return { ok: false, error: "maxUsd is required" };
      if (input.releaseWhenDone !== true) return { ok: false, error: "releaseWhenDone must be true" };
      if (input.maxUsd > MEDIA_CAP_USD) return { ok: false, error: `maxUsd $${input.maxUsd} is over the $${MEDIA_CAP_USD} cap` };
      return { ok: true, args: input as Record<string, unknown> };
    },
    async check(args) {
      const settings = await services.mediaSettings();
      const maxMinutes = Number(args.maxMinutes);
      const maxUsd = Number(args.maxUsd);
      // Review 5: the highest rate this session may land on -- its own GPU price cap, else its template's, else the saved price.
      const own = (args.gpu as { maxPricePerHr?: number | null } | undefined)?.maxPricePerHr ?? null;
      const fromTemplate = own === null && typeof args.templateId === "string" ? await services.templateMaxPricePerHr(args.templateId) : null;
      const price = own ?? fromTemplate ?? settings.gpu.onDemandPricePerHr;
      if (price === null) return { estimateUsd: null, refusal: "the GPU's price is unknown (Servers → Setup)" };
      const estimateUsd = round2((price * maxMinutes) / 60);
      const limits = settings.limits;
      const refusal = !settings.factorySessionsEnabled
        ? "factory sessions are switched off (Servers → Setup)"
        : maxMinutes > limits.maxMinutesPerSession
          ? `${maxMinutes} min is over the factory's ${limits.maxMinutesPerSession} min per session`
          : maxUsd > limits.maxUsdPerSession
            ? `$${maxUsd} is over the factory's $${limits.maxUsdPerSession} per session`
            : round2(settings.spentOrReservedUsd.today + maxUsd) > limits.maxUsdPerDay
              ? `the factory's day would reach $${round2(settings.spentOrReservedUsd.today + maxUsd)} (limit $${limits.maxUsdPerDay})`
              : round2(settings.spentOrReservedUsd.thisMonth + maxUsd) > limits.maxUsdPerMonth
                ? `the factory's month would reach $${round2(settings.spentOrReservedUsd.thisMonth + maxUsd)} (limit $${limits.maxUsdPerMonth})`
                : null;
      return { estimateUsd, refusal };
    },
    async run(args) {
      try {
        const result = await services.startSession(args);
        // A start held by a limit would stay pending for the owner in Servers -- a second, duplicate request. It is withdrawn.
        if (result.approved === false) {
          const reason = String(result.heldBy ?? "a limit");
          const sessionId = (result.session as { sessionId?: unknown } | undefined)?.sessionId;
          if (typeof sessionId !== "string") return { ok: false, error: `held by a limit: ${reason}; the session id is unknown, so it was not withdrawn` };
          try {
            await services.endSession(sessionId);
          } catch (error) {
            return { ok: false, error: `held by a limit: ${reason}; withdrawing session ${sessionId} failed: ${errorText(error)}` };
          }
          return { ok: false, error: `held by a limit: ${reason}; the session was withdrawn` };
        }
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },
    summary: (args) => `channel ${String(args.channelId)}, ${String(args.maxMinutes)} min${args.templateId ? `, template ${String(args.templateId)}` : ""}; maxUsd $${String(args.maxUsd)} is the hard bound`,
  };

  const geminiCreate: SystemApprovalAction = {
    capUsd: GEMINI_CAP_USD,
    parse(args) {
      const parsed = geminiCreateJobSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: issueText(parsed.error.issues) };
      if (parsed.data.dryRun === true) return { ok: false, error: "dryRun cannot be approved" };
      return { ok: true, args: parsed.data as Record<string, unknown> };
    },
    async check(args) {
      // The Gemini module's own price estimate and limits (its dry-run: nothing stored, nothing sent).
      const dry = await services.geminiCreateJob({ ...args, dryRun: true }, "owner (System)");
      const estimateUsd = typeof dry.estimateUsd === "number" ? dry.estimateUsd : null;
      const refusal = dry.refusal && typeof dry.refusal === "object" ? String((dry.refusal as { message?: unknown }).message ?? "refused by the Gemini limits") : null;
      return { estimateUsd, refusal: dry.allowed === false && !refusal ? "refused by the Gemini limits" : refusal };
    },
    async run(args, actor) {
      try {
        return { ok: true, result: await services.geminiCreateJob(args, actor) };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },
    summary: (args) => `channel ${String(args.channelId)}, ${String(args.kind)} ${String(args.model)}`,
    // Review 6: the approval is bound to the exact input files (frames, references).
    inputHashes: (args) => services.geminiInputHashes(args),
  };

  // FO-RESP-0045: a free action for the acceptance test -- the same flow (topic approve + Web Confirm, once, 2 h), no charge.
  const gpuAvailability: SystemApprovalAction = {
    capUsd: 0,
    parse(args) {
      const parsed = gpuAvailabilityInput.safeParse(args);
      return parsed.success ? { ok: true, args: parsed.data as Record<string, unknown> } : { ok: false, error: issueText(parsed.error.issues) };
    },
    check: async () => ({ estimateUsd: 0, refusal: null }),
    async run(args) {
      try {
        return { ok: true, result: await services.gpuAvailability(args) };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },
    summary: (args) => (Object.keys(args).length === 0 ? "(no arguments; free, a read)" : `${JSON.stringify(args)} (free, a read)`),
  };

  return { factory_media_start_session: mediaStart, factory_gemini_create_job: geminiCreate, factory_media_get_gpu_availability: gpuAvailability };
}

/** The process's System topic core with the real actions (the routes and the scan loop). */
export function getSystemTopicCore(): SystemTopicCore {
  return createSystemTopicCore(createSystemApprovalActions(productionApprovalServices()));
}
