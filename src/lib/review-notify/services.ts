import { parseWithSchema } from "@/lib/shared-domain";
import {
  PLAN_PASS_QUIET_MS,
  PLAN_WAVE_SLACK_MS,
  REVIEW_NOTIFY_BACKFILL_FROM,
  REVIEW_NOTIFY_LEDGER_KEEP_MS,
  REVIEW_NOTIFY_WINDOW_MS,
  type PlanReviewEntry,
  type PlanReviewFeed,
  type ReviewDecisionNotice,
  type ReviewNotifyPorts,
  type ReviewNotifySettings,
  type ReviewNotifyState,
  type ReviewNotifyTickResult,
  type ReviewNotifyView,
} from "./contracts";
import { planLedgerKey, planPassId, renderDecisionNotice, renderPlanPass, reviewFileName, singleLedgerKey } from "./render";
import { parseStoredSettings, parseStoredState, reviewNotifySettingsInputSchema } from "./schemas";

// BL-248 (REVIEW_NOTIFY_PLAN.md, ADR 0066): the writer. One tick: when the switch is on and the Inbox folder is there, every owner
// decision of the sources not yet in the ledger gets its file (written once, atomically), then its ledger row; a plan's entries are
// written together as one review pass when a wave finished or the plan has been quiet for 5 minutes. A failure (a source, the
// folder, one file) is logged and retried next tick; it never reaches the owner's decision, which was recorded long before.

const LEDGER_PRUNE_EVERY_MS = 60 * 60_000;

const msOf = (iso: string | null | undefined) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : NaN;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Merges the feeds of one plan from several sources: entries by id, every wave-finished time, the first known title / video. */
export function mergePlanFeeds(feeds: readonly PlanReviewFeed[]): PlanReviewFeed[] {
  const byPlan = new Map<string, PlanReviewFeed>();
  for (const feed of feeds) {
    const known = byPlan.get(feed.planId);
    if (!known) {
      byPlan.set(feed.planId, { ...feed, entries: [...feed.entries], waveFinishedAt: [...feed.waveFinishedAt] });
      continue;
    }
    const ids = new Set(known.entries.map((e) => e.entryId));
    for (const entry of feed.entries) if (!ids.has(entry.entryId)) known.entries.push(entry);
    known.waveFinishedAt.push(...feed.waveFinishedAt);
    known.title ??= feed.title;
    known.video ??= feed.video;
    known.channelName ??= feed.channelName;
  }
  return [...byPlan.values()];
}

/**
 * Whether a plan's unseen entries form a pass now (REVIEW_NOTIFY_PLAN.md §3): a wave finished at or after the earliest of them
 * (2 s slack), or the newest is at least 5 minutes old.
 */
export function planPassReady(entries: readonly Pick<PlanReviewEntry, "at">[], waveFinishedAt: readonly string[], now: Date): boolean {
  if (entries.length === 0) return false;
  const times = entries.map((e) => msOf(e.at)).filter((ms) => Number.isFinite(ms));
  if (times.length === 0) return true;
  const earliest = Math.min(...times);
  const newest = Math.max(...times);
  if (waveFinishedAt.some((at) => msOf(at) >= earliest - PLAN_WAVE_SLACK_MS)) return true;
  return now.getTime() - newest >= PLAN_PASS_QUIET_MS;
}

export function createReviewNotify(ports: ReviewNotifyPorts) {
  let running: Promise<ReviewNotifyTickResult> | null = null;
  let lastLogged: string | null = null;
  let lastPruneAt = 0;

  const readSettings = async () => parseStoredSettings(await ports.settings.read());
  const readState = async () => parseStoredState(await ports.state.read());
  const writeState = (state: ReviewNotifyState) => ports.state.write(JSON.stringify(state));

  async function effective(settings: ReviewNotifySettings) {
    const defaultEnabled = await ports.inbox.producerFolderExists().catch(() => false);
    const defaultInboxPath = await ports.inbox.defaultPath().catch(() => null);
    return { defaultEnabled, defaultInboxPath, enabled: settings.enabled ?? defaultEnabled, inboxPath: settings.inboxPath ?? defaultInboxPath };
  }

  /** The same error every 30 s (T9 not mounted) is logged once, until it changes. */
  function logErrors(errors: readonly string[]) {
    const text = errors.length > 0 ? errors.join(" | ") : null;
    if (text !== null && text !== lastLogged) ports.log("review_notify.failed", { errors });
    lastLogged = text;
  }

  async function writeSingles(inbox: string, notices: readonly ReviewDecisionNotice[], since: number, now: Date, written: string[], errors: string[]) {
    const inWindow = notices.filter((n) => msOf(n.decidedAt) >= since);
    if (inWindow.length === 0) return;
    const seen = await ports.ledger.has(inWindow.map(singleLedgerKey));
    const fresh = inWindow.filter((n) => !seen.has(singleLedgerKey(n))).sort((a, b) => msOf(a.decidedAt) - msOf(b.decidedAt));
    for (const notice of fresh) {
      const fileName = reviewFileName(notice.kind, notice.itemId, notice.decisionId);
      try {
        const outcome = await ports.inbox.writeOnce(inbox, fileName, renderDecisionNotice(notice));
        await ports.ledger.record([{ key: singleLedgerKey(notice), kind: notice.kind, fileName }], now);
        if (outcome === "written") written.push(fileName);
      } catch (error) {
        errors.push(`${fileName}: ${message(error)}`);
      }
    }
  }

  async function writePlans(inbox: string, feeds: readonly PlanReviewFeed[], since: number, now: Date, written: string[], errors: string[]) {
    for (const feed of mergePlanFeeds(feeds)) {
      const inWindow = feed.entries.filter((e) => msOf(e.at) >= since);
      if (inWindow.length === 0) continue;
      const seen = await ports.ledger.has(inWindow.map((e) => planLedgerKey(e.entryId)));
      const fresh = inWindow.filter((e) => !seen.has(planLedgerKey(e.entryId)));
      if (!planPassReady(fresh, feed.waveFinishedAt, now)) continue;
      const passId = planPassId(fresh.map((e) => e.entryId));
      const fileName = reviewFileName("plan", feed.planId, passId);
      try {
        const outcome = await ports.inbox.writeOnce(inbox, fileName, renderPlanPass(feed, fresh, passId));
        await ports.ledger.record(
          fresh.map((e) => ({ key: planLedgerKey(e.entryId), kind: "plan" as const, fileName })),
          now
        );
        if (outcome === "written") written.push(fileName);
      } catch (error) {
        errors.push(`${fileName}: ${message(error)}`);
      }
    }
  }

  async function runTick(): Promise<ReviewNotifyTickResult> {
    const now = ports.now();
    const settings = await readSettings();
    let state = await readState();
    const { enabled, inboxPath } = await effective(settings);

    if (!enabled) {
      // Off: nothing is read, written or recorded (AC-RN-11). The next time it goes on starts from then (§6).
      if (state.activeSince !== null) await writeState({ ...state, activeSince: null, singlesFloor: null, lastTickAt: now.toISOString() });
      logErrors([]);
      return { ran: false, written: [], errors: [] };
    }
    if (state.activeSince === null) {
      // §6: the first time on, single decisions from the backfill start; a later enable from now. Plans always from now.
      state = { ...state, activeSince: now.toISOString(), singlesFloor: state.backfillDone ? now.toISOString() : REVIEW_NOTIFY_BACKFILL_FROM, backfillDone: true };
      await writeState(state);
    }

    const written: string[] = [];
    const errors: string[] = [];
    const inboxThere = inboxPath ? await ports.inbox.isDirectory(inboxPath).catch(() => false) : false;
    if (!inboxPath || !inboxThere) {
      // AC-RN-10: nothing written, nothing recorded -- the next tick with the folder there writes them all.
      errors.push(inboxPath ? `the Producer's Inbox folder is not there: ${inboxPath}` : "no Producer Inbox folder: set it in Settings → AI agent → «Будить Продюсера»");
    } else {
      const windowStart = now.getTime() - REVIEW_NOTIFY_WINDOW_MS;
      const singlesSince = Math.max(msOf(state.singlesFloor), windowStart);
      const plansSince = Math.max(msOf(state.activeSince), windowStart);
      for (const source of ports.decisionSources) {
        try {
          // AC-RN-17: one source failing never stops the others.
          await writeSingles(inboxPath, await source.list(new Date(singlesSince).toISOString()), singlesSince, now, written, errors);
        } catch (error) {
          errors.push(`${source.name}: ${message(error)}`);
        }
      }
      const feeds: PlanReviewFeed[] = [];
      for (const source of ports.planSources) {
        try {
          feeds.push(...(await source.list(new Date(plansSince).toISOString())));
        } catch (error) {
          errors.push(`${source.name}: ${message(error)}`);
        }
      }
      try {
        await writePlans(inboxPath, feeds, plansSince, now, written, errors);
      } catch (error) {
        errors.push(`plans: ${message(error)}`);
      }
      if (now.getTime() - lastPruneAt >= LEDGER_PRUNE_EVERY_MS) {
        lastPruneAt = now.getTime();
        await ports.ledger.prune(new Date(now.getTime() - REVIEW_NOTIFY_LEDGER_KEEP_MS)).catch((error: unknown) => errors.push(`ledger: ${message(error)}`));
      }
    }

    logErrors(errors);
    const latest = await readState();
    await writeState({
      ...latest,
      activeSince: state.activeSince,
      singlesFloor: state.singlesFloor,
      backfillDone: true,
      lastTickAt: now.toISOString(),
      lastError: errors[0] ?? null,
      ...(written.length > 0 ? { lastFile: written[written.length - 1], lastWrittenAt: now.toISOString(), writtenCount: latest.writtenCount + written.length } : {}),
    });
    return { ran: true, written, errors };
  }

  return {
    /** One run; a run already going is joined, never started twice (the loop and a nudge). */
    tick(): Promise<ReviewNotifyTickResult> {
      if (!running) {
        running = runTick().finally(() => {
          running = null;
        });
      }
      return running;
    },

    async view(): Promise<ReviewNotifyView> {
      const settings = await readSettings();
      const state = await readState();
      const eff = await effective(settings);
      return {
        enabled: eff.enabled,
        enabledSetting: settings.enabled,
        defaultEnabled: eff.defaultEnabled,
        inboxPath: eff.inboxPath,
        inboxPathSetting: settings.inboxPath,
        defaultInboxPath: eff.defaultInboxPath,
        inboxExists: eff.inboxPath ? await ports.inbox.isDirectory(eff.inboxPath).catch(() => false) : false,
        activeSince: state.activeSince,
        lastTickAt: state.lastTickAt,
        lastError: state.lastError,
        lastFile: state.lastFile,
        lastWrittenAt: state.lastWrittenAt,
        writtenCount: state.writtenCount,
      };
    },

    /** The owner's settings (Web UI only): a field left out keeps its value. */
    async updateSettings(input: unknown): Promise<ReviewNotifyView> {
      const parsed = parseWithSchema(reviewNotifySettingsInputSchema, input, "review notify settings");
      const current = await readSettings();
      const next: ReviewNotifySettings = {
        enabled: parsed.enabled === undefined ? current.enabled : parsed.enabled,
        inboxPath: parsed.inboxPath === undefined ? current.inboxPath : parsed.inboxPath,
      };
      await ports.settings.write(JSON.stringify(next));
      return this.view();
    },
  };
}

export type ReviewNotify = ReturnType<typeof createReviewNotify>;
