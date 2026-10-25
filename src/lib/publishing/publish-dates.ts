// BL-182 stage 2 (FO-REQ-0023 §4 B3; owner msgs 2725/2727): the publish dates a selection of packages starts with. Each package
// gets its planned date at the channel's UTC publish time; a day that already has a published or scheduled video, or one taken by
// an earlier package of the selection, moves to the next free day, and so does a time 15 minutes away or less. A package without a
// planned date starts without one (it uploads private) until the owner picks one. Pure: the Content tab and its tests use it.

const DAY_MS = 86_400_000;
const PUBLISH_AT_MARGIN_MS = 15 * 60_000;

/** The instant of a UTC calendar day at a UTC "HH:MM". */
export function publishInstant(date: string, publishTimeUtc: string): string {
  return new Date(`${date}T${publishTimeUtc}:00.000Z`).toISOString();
}

export function assignPublishDates(args: {
  /** In upload order (planned date, then number). */
  selected: ReadonlyArray<{ key: string; plannedDate: string | null }>;
  /** UTC days that already have a published or scheduled video. */
  takenDays: ReadonlySet<string>;
  publishTimeUtc: string;
  now: Date;
}): Map<string, string | null> {
  const taken = new Set(args.takenDays);
  const dates = new Map<string, string | null>();
  for (const { key, plannedDate } of args.selected) {
    if (plannedDate === null) {
      dates.set(key, null);
      continue;
    }
    let day = Date.parse(`${plannedDate}T00:00:00.000Z`);
    const tooSoon = (d: number) => Date.parse(publishInstant(new Date(d).toISOString().slice(0, 10), args.publishTimeUtc)) <= args.now.getTime() + PUBLISH_AT_MARGIN_MS;
    while (taken.has(new Date(day).toISOString().slice(0, 10)) || tooSoon(day)) day += DAY_MS;
    const chosen = new Date(day).toISOString().slice(0, 10);
    taken.add(chosen);
    dates.set(key, chosen);
  }
  return dates;
}

/**
 * Whether a publish time is written after the upload (a `videos.update` the pool pays for). Since owner msgs 3510/3511 (2026-10-25,
 * FO-REQ-0040 item 4) every dated upload is inserted private without a date and gets its date last, after the thumbnail, the
 * playlist and a passing read-back -- no longer at insert when it is 6 h or more ahead (owner msg 2717, superseded).
 */
export function isDeferredPublishAt(publishAt: string | null): boolean {
  return publishAt !== null;
}

/**
 * The pool units one upload needs: the thumbnail (50), a playlist item (50 + 1 to check it is not there yet), a deferred publish
 * time (videos.update 50 + video-details' own 3 reads + the runner's read before and after it = 55), and about 45 reads (the
 * identity check per pass, the processing polls, the read-back, the sync after it). `videos.insert` itself comes from its own
 * bucket, not the pool.
 */
export function estimateUploadUnits(args: { playlist: boolean; deferredPublishAt: boolean }): number {
  return 50 + 45 + (args.playlist ? 51 : 0) + (args.deferredPublishAt ? 55 : 0);
}
