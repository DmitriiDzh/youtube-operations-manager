import { parseWithSchema } from "@/lib/shared-domain";
import {
  PLAN_PASS_QUIET_MS,
  PLAN_WAVE_SLACK_MS,
  REVIEW_NOTIFY_BACKFILL_FROM,
  REVIEW_NOTIFY_LEDGER_KEEP_MS,
  REVIEW_NOTIFY_TEMP_MAX_AGE_MS,
  REVIEW_NOTIFY_WINDOW_MS,
  type SourceResult,
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

/** The first finite of the candidates (review N8: a damaged stored time never becomes NaN, which would throw on toISOString). */
const firstFinite = (...values: number[]) => values.find((v) => Number.isFinite(v)) ?? 0;

function itemsOf<T>(result: SourceResult<T>, name: string, errors: string[]): T[] {
  if (Array.isArray(result)) return result;
  errors.push(...result.errors.map((e) => `${name}: ${e}`));
  return result.items;
}

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
  let rerun = false;
  let lastLogged: string | null = null;
  let lastPruneAt = 0;

  const readSettings = async () => parseStoredSettings(await ports.settings.read());
  const readState = async () => parseStoredState(await ports.state.read());
  const writeState = (state: ReviewNotifyState) => ports.state.write(JSON.stringify(state));

  /**
   * ADR 0066 §4 (review B1): the default (never set) is ON only on macOS with the workspace's `00 YT Producer` folder present -- the
   * Mac the Producer runs on. Syncthing also creates that folder on the other computer, so the folder alone would make two writers.
   * Once the default was on here it is sticky: the folder and its Inbox live on the same disk, so a disconnected disk reads as "Inbox
   * missing, retry" -- never as "off", which would start again later and drop the decisions made meanwhile (§8). Only the owner's
   * explicit `false` turns a writer off; a computer whose default was never on never becomes sticky.
   */
  async function effective(settings: ReviewNotifySettings, state: ReviewNotifyState) {
    const folder = await ports.inbox.producerFolderExists().catch(() => false);
    const defaultEnabled = ports.platform() === "darwin" && folder;
    const defaultInboxPath = await ports.inbox.defaultPath().catch(() => null);
    const sticky = state.defaultOnSeen && state.activeSince !== null;
    const enabled = settings.enabled ?? (defaultEnabled || sticky);
    return { defaultEnabled, defaultInboxPath, enabled, waitingForFolder: settings.enabled === null && !defaultEnabled && sticky, inboxPath: settings.inboxPath ?? defaultInboxPath };
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

  /**
   * Writes one pass. Review N6: its entry ids are stored in the state BEFORE the file is written and dropped after the ledger rows,
   * so a crash in between is finished as exactly that pass on the next run (never a second file repeating its entries).
   */
  async function writePass(inbox: string, feed: PlanReviewFeed, entries: readonly PlanReviewEntry[], pending: Record<string, string[]>, now: Date, written: string[], errors: string[]) {
    const ids = entries.map((e) => e.entryId);
    const passId = planPassId(ids);
    const fileName = reviewFileName("plan", feed.planId, passId);
    try {
      pending[feed.planId] = ids;
      await savePending(pending);
      const outcome = await ports.inbox.writeOnce(inbox, fileName, renderPlanPass(feed, entries, passId));
      await ports.ledger.record(
        ids.map((id) => ({ key: planLedgerKey(id), kind: "plan" as const, fileName })),
        now
      );
      delete pending[feed.planId];
      await savePending(pending);
      if (outcome === "written") written.push(fileName);
    } catch (error) {
      errors.push(`${fileName}: ${message(error)}`);
    }
  }

  async function savePending(pending: Record<string, string[]>) {
    const latest = await readState();
    await writeState({ ...latest, pendingPasses: { ...pending } });
  }

  async function writePlans(inbox: string, feeds: readonly PlanReviewFeed[], since: number, now: Date, written: string[], errors: string[]) {
    const pending = { ...(await readState()).pendingPasses };
    for (const feed of mergePlanFeeds(feeds)) {
      // An interrupted pass first, exactly as it was (only its entries the ledger does not have yet).
      const interrupted = pending[feed.planId];
      if (interrupted) {
        const seen = await ports.ledger.has(interrupted.map(planLedgerKey));
        const ids = new Set(interrupted.filter((id) => !seen.has(planLedgerKey(id))));
        const entries = feed.entries.filter((e) => ids.has(e.entryId));
        if (ids.size === 0 || entries.length !== ids.size) {
          // Already recorded, or its entries are gone from the sources: nothing left to finish.
          delete pending[feed.planId];
          await savePending(pending);
        } else {
          await writePass(inbox, feed, entries, pending, now, written, errors);
          if (pending[feed.planId]) continue;
        }
      }
      const inWindow = feed.entries.filter((e) => msOf(e.at) >= since);
      if (inWindow.length === 0) continue;
      const seen = await ports.ledger.has(inWindow.map((e) => planLedgerKey(e.entryId)));
      const fresh = inWindow.filter((e) => !seen.has(planLedgerKey(e.entryId)));
      if (!planPassReady(fresh, feed.waveFinishedAt, now)) continue;
      await writePass(inbox, feed, fresh, pending, now, written, errors);
    }
  }

  async function runTick(): Promise<ReviewNotifyTickResult> {
    const now = ports.now();
    const settings = await readSettings();
    let state = await readState();
    const { enabled, inboxPath, defaultEnabled } = await effective(settings, state);

    if (!enabled) {
      // Off: nothing is read, written or recorded (AC-RN-11). The next time it goes on starts from then (§6). An old error is
      // cleared (review N10): it says nothing about a writer that is off.
      if (state.activeSince !== null || state.lastError !== null || state.defaultOnSeen) {
        await writeState({ ...state, activeSince: null, singlesFloor: null, defaultOnSeen: false, lastError: null, lastTickAt: now.toISOString() });
      }
      logErrors([]);
      return { ran: false, written: [], errors: [] };
    }
    if (settings.enabled === null && defaultEnabled && !state.defaultOnSeen) {
      state = { ...state, defaultOnSeen: true };
      await writeState(state);
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
      // Review N5: temporary files a crash left behind (older than 1 h) go first.
      await ports.inbox.sweepTemp(inboxPath, new Date(now.getTime() - REVIEW_NOTIFY_TEMP_MAX_AGE_MS)).catch((error: unknown) => errors.push(`temporary files: ${message(error)}`));
      const windowStart = now.getTime() - REVIEW_NOTIFY_WINDOW_MS;
      // Review N8: a damaged floor falls back to the enable time, then to the window start.
      const singlesSince = Math.max(firstFinite(msOf(state.singlesFloor), msOf(state.activeSince), windowStart), windowStart);
      const plansSince = Math.max(firstFinite(msOf(state.activeSince), windowStart), windowStart);
      for (const source of ports.decisionSources) {
        try {
          // AC-RN-17: one source (or one channel of it) failing never stops the others.
          await writeSingles(inboxPath, itemsOf(await source.list(new Date(singlesSince).toISOString()), source.name, errors), singlesSince, now, written, errors);
        } catch (error) {
          errors.push(`${source.name}: ${message(error)}`);
        }
      }
      const feeds: PlanReviewFeed[] = [];
      for (const source of ports.planSources) {
        try {
          feeds.push(...itemsOf(await source.list(new Date(plansSince).toISOString()), source.name, errors));
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
      defaultOnSeen: state.defaultOnSeen,
      backfillDone: true,
      lastTickAt: now.toISOString(),
      lastError: errors[0] ?? null,
      ...(written.length > 0 ? { lastFile: written[written.length - 1], lastWrittenAt: now.toISOString(), writtenCount: latest.writtenCount + written.length } : {}),
    });
    return { ran: true, written, errors };
  }

  return {
    /**
     * One run; never two at once. A call while one runs (a nudge after a decision recorded mid-run) asks for one more run right
     * after it, so that decision is not left to the next 30 s tick (review N9); the caller gets the run that follows.
     */
    tick(): Promise<ReviewNotifyTickResult> {
      if (running) {
        rerun = true;
        return running;
      }
      running = (async () => {
        let result: ReviewNotifyTickResult;
        do {
          rerun = false;
          result = await runTick();
        } while (rerun);
        return result;
      })().finally(() => {
        running = null;
      });
      return running;
    },

    async view(): Promise<ReviewNotifyView> {
      const settings = await readSettings();
      const state = await readState();
      const eff = await effective(settings, state);
      return {
        enabled: eff.enabled,
        waitingForFolder: eff.waitingForFolder,
        enabledSetting: settings.enabled,
        defaultEnabled: eff.defaultEnabled,
        inboxPath: eff.inboxPath,
        inboxPathSetting: settings.inboxPath,
        defaultInboxPath: eff.defaultInboxPath,
        inboxExists: eff.inboxPath ? await ports.inbox.isDirectory(eff.inboxPath).catch(() => false) : false,
        activeSince: state.activeSince,
        lastTickAt: state.lastTickAt,
        lastError: eff.enabled ? state.lastError : null,
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
