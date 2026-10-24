import { NextResponse } from "next/server";
import { z } from "zod";
import type { HistoryOptions, SpendFilter, SpendHistoryPage, SpendInputs, SpendSummary } from "@/lib/spend-analytics";

// BL-219 (docs/roadmap/plans/SERVERS_ANALYTICS_PLAN.md): Servers → «Аналитика». Read-only (AC-SA-08): it reads the cost runs of every
// computer and this computer's session / job facts, and never calls RunPod, Gemini or YouTube. Signed-in owner only.

export type SpendAnalyticsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  readInputs: () => Promise<SpendInputs>;
  summary: (inputs: SpendInputs, filter: SpendFilter, now: Date) => SpendSummary;
  history: (inputs: SpendInputs, filter: SpendFilter, options: HistoryOptions, now: Date) => SpendHistoryPage;
  now: () => Date;
  /** Every stored channel's title, for the channel names in the summary. */
  channelTitles: () => Promise<Array<{ channelId: string; title: string }>>;
};

const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const filterSchema = z
  .object({
    days: z.enum(["7", "30", "90", "all"]).default("30"),
    channelId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    device: z.enum(["all", "this"]).default("all"),
    who: z.enum(["all", "owner", "factory", "agent"]).default("all"),
    tz: z.string().max(64).refine(validTimeZone, "an IANA time zone").default("UTC"),
    kind: z.enum(["all", "runpod", "gemini"]).default("all"),
    errors: z.enum(["0", "1"]).default("0"),
    cursor: z.string().regex(/^\d{1,6}$/).optional(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

function parse(request: Request) {
  const query = Object.fromEntries(new URL(request.url).searchParams.entries());
  const parsed = filterSchema.safeParse(query);
  if (!parsed.success) return { error: NextResponse.json({ error: "validation_failed", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 }) };
  const q = parsed.data;
  const filter: SpendFilter = { days: q.days === "all" ? null : (Number(q.days) as 7 | 30 | 90), channelId: q.channelId ?? null, device: q.device, who: q.who, tz: q.tz };
  return { filter, options: { kind: q.kind, errorsOnly: q.errors === "1", cursor: q.cursor ?? null, day: q.day ?? null } satisfies HistoryOptions };
}

export function createSpendAnalyticsHandlers(deps: SpendAnalyticsRouteDeps) {
  async function guarded(request: Request, run: (parsed: { filter: SpendFilter; options: HistoryOptions }, inputs: SpendInputs) => unknown | Promise<unknown>): Promise<Response> {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const parsed = parse(request);
    if ("error" in parsed) return parsed.error!;
    try {
      return NextResponse.json(await run(parsed, await deps.readInputs()));
    } catch (error) {
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  }
  return {
    summary: (request: Request) =>
      guarded(request, async ({ filter }, inputs) => ({ ...deps.summary(inputs, filter, deps.now()), channels: await deps.channelTitles().catch(() => []) })),
    history: (request: Request) => guarded(request, ({ filter, options }, inputs) => deps.history(inputs, filter, options, deps.now())),
  };
}
