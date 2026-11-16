import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// BL-263 (SHORT_VIDEO_CODE_PLAN.md §6.2, ADR 0071 §4; AGENTS.md §M): where `factory_release_recode` keeps its journals and which of them
// are unfinished -- shared by the recode (publishing, which writes them) and the video list (video-projects, which must refuse a given
// S or a new link while a recode of that code is half-done, and show leftover journals to the Operator). Neither module reaches into
// the other. A journal is `<app data>/release-recode/<channel>/<video>-<ms>.json`.

export const RELEASE_RECODE_JOURNAL_SCHEMA = "ytm-release-recode-journal/1";
/** The recode's steps in order; a journal whose `done` holds all of them (or `completed: true`) is finished, never undone. */
export const RELEASE_RECODE_STEPS = ["files", "manifest", "records", "folder", "rows", "storyboards"] as const;

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

export function releaseRecodeJournalDir(appDataDir: string, channelId: string): string {
  return path.join(appDataDir, "release-recode", safe(channelId));
}

export function releaseRecodeJournalPath(appDataDir: string, channelId: string, video: string, at: Date): string {
  return path.join(releaseRecodeJournalDir(appDataDir, channelId), `${safe(video)}-${at.getTime()}.json`);
}

/** Whether a journal describes a finished recode (marked completed, or every step done): it is cleared, never undone. */
export function isFinishedRecodeJournal(journal: { done?: readonly string[]; completed?: boolean }): boolean {
  if (journal.completed === true) return true;
  const done = new Set(journal.done ?? []);
  return RELEASE_RECODE_STEPS.every((step) => done.has(step));
}

export type PendingRecodeJournal = { journal: string; video: string; newCode: string; startedAt: string | null; done: string[] };

/** The channel's unfinished journals (a crashed recode the next real call undoes). An unreadable journal counts as unfinished. */
export async function listPendingRecodeJournals(appDataDir: string, channelId: string): Promise<PendingRecodeJournal[]> {
  const dir = releaseRecodeJournalDir(appDataDir, channelId);
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: PendingRecodeJournal[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const file = path.join(dir, name);
    let parsed: { video?: unknown; newCode?: unknown; startedAt?: unknown; done?: unknown; completed?: unknown } = {};
    try {
      parsed = JSON.parse(await readFile(file, "utf8")) as typeof parsed;
    } catch {
      parsed = {};
    }
    const done = Array.isArray(parsed.done) ? parsed.done.filter((d): d is string => typeof d === "string") : [];
    if (isFinishedRecodeJournal({ done, completed: parsed.completed === true })) continue;
    out.push({
      journal: file,
      video: typeof parsed.video === "string" ? parsed.video : name.replace(/-\d+\.json$/, ""),
      newCode: typeof parsed.newCode === "string" ? parsed.newCode : "",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
      done,
    });
  }
  return out;
}
