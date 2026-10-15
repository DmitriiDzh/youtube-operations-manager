import { YOUTUBE_READ_SCOPE } from "@/lib/auth";
import type { ResolvedCredentials } from "./contracts";
import { API_DATA_RETENTION_DAYS } from "@/lib/youtube-data-policy/contracts";
import {
  createTrafficDetailServices,
  listStoredTrafficDetailsInputSchema,
  type ListStoredTrafficDetailsResult,
  type StoredTrafficDetailsVideo,
  type StoredTrafficDetailsWeek,
  type TrafficDetailDependencies,
  type TrafficDetailSpec,
  type TrafficDetailValue,
} from "./traffic-source-details";

/**
 * BL-191 (FO-REQ-0026 relaying PRD-REQ-0013, docs/roadmap/plans/SUGGESTED_SOURCES_PLAN.md): the videos that suggested each own video
 * ("Suggested videos", traffic source `RELATED_VIDEO`), per video over its first 90 days and per channel week -- the `RELATED_VIDEO`
 * configuration of the shared traffic-source details (`traffic-source-details.ts`, BL-169's schedule and failure rules), plus:
 * - `source: ours | external`, decided when read: `ours` is a synced video of any channel connected on this computer (our own title and
 *   channel come with it);
 * - the title and channel of an `external` video, looked up with Data API `videos.list` at the end of a collection run and kept 30 days
 *   (another channel's data, III.E.4.d; the retention purge deletes the row, a read ignores an older one).
 */

export const VIDEO_SUGGESTED_SUBJECT_PREFIX = "suggested:";
export const WEEK_SUGGESTED_SUBJECT_PREFIX = "suggested-week:";
export const SUGGESTED_SOURCE_SPEC: TrafficDetailSpec = {
  sourceType: "RELATED_VIDEO",
  videoPrefix: VIDEO_SUGGESTED_SUBJECT_PREFIX,
  weekPrefix: WEEK_SUGGESTED_SUBJECT_PREFIX,
  label: "suggested sources",
};
/** At most this many ids are looked up per collection run (10 `videos.list` calls of 50). */
export const MAX_TITLE_LOOKUPS_PER_RUN = 500;
const RETENTION_MS = API_DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export const listStoredSuggestedSourcesInputSchema = listStoredTrafficDetailsInputSchema("suggesting videos");

export type SuggestedSourceRow = {
  videoId: string;
  views: number | null;
  estimatedMinutesWatched: number | null;
  source: "ours" | "external";
  /** Null when not known: an external video without a title row from the last 30 days (or one YouTube did not return). */
  title: string | null;
  channelId: string | null;
  channelTitle: string | null;
};
export type StoredSuggestedSourcesVideo = Omit<StoredTrafficDetailsVideo, "rows"> & { sources: SuggestedSourceRow[] };
export type StoredSuggestedSourcesWeek = Omit<StoredTrafficDetailsWeek, "rows"> & { sources?: SuggestedSourceRow[] };
export type ListStoredSuggestedSourcesResult =
  | { channelId: string; videos: StoredSuggestedSourcesVideo[] }
  | {
      channelId: string;
      startDate: string;
      endDate: string;
      groupBy: "total" | "week";
      weeks: StoredSuggestedSourcesWeek[];
      /** Only with `groupBy: "total"`: each suggesting video summed over the weeks that were read (a sum of weekly top-25 lists). */
      sources?: SuggestedSourceRow[];
    };

type VideoInfo = { videoId: string; title: string | null; channelId: string | null; channelTitle: string | null };

export type SuggestedSourceDependencies = TrafficDetailDependencies & {
  /** The synced videos of any connected channel among `videoIds`: ours. */
  ownVideos: { findByIds(videoIds: string[]): Promise<VideoInfo[]> };
  titles: {
    /** Every distinct suggesting id stored for the channel. */
    listStoredSourceIds(channelId: string): Promise<string[]>;
    /** The title rows of `videoIds` fetched at or after `since`. */
    listFresh(videoIds: string[], since: Date): Promise<VideoInfo[]>;
    save(rows: VideoInfo[], at: Date): Promise<void>;
  };
  /** The Data API background reserve (`isBackgroundReadAllowed("data")`). */
  dataReserve: { isBackgroundReadAllowed(service: "data"): Promise<boolean> };
  dataApi: { getPublicVideoTitles(args: { credentials: ResolvedCredentials; videoIds: string[] }): Promise<Array<{ videoId: string; title: string; channelId: string | null; channelTitle: string | null }>> };
};

export function createSuggestedSourceServices(deps: SuggestedSourceDependencies) {
  const engine = createTrafficDetailServices(SUGGESTED_SOURCE_SPEC, deps, listStoredSuggestedSourcesInputSchema);

  /**
   * The channel's stored suggesting ids that are not ours and have no title row from the last 30 days, at most
   * MAX_TITLE_LOOKUPS_PER_RUN, looked up with `videos.list`; an id it did not return is saved with null fields so it is not asked again
   * within the 30 days. Only within the Data API background reserve; any failure ends the lookups and is not raised (the rows stay, the
   * titles come on a later run).
   */
  async function lookUpExternalTitles(credentialRef: unknown, channelId: string): Promise<number> {
    try {
      const ids = await deps.titles.listStoredSourceIds(channelId);
      if (ids.length === 0) return 0;
      const now = deps.clock.now();
      const [own, fresh] = await Promise.all([deps.ownVideos.findByIds(ids), deps.titles.listFresh(ids, new Date(now.getTime() - RETENTION_MS))]);
      const known = new Set([...own, ...fresh].map((row) => row.videoId));
      const wanted = ids.filter((id) => !known.has(id)).slice(0, MAX_TITLE_LOOKUPS_PER_RUN);
      if (wanted.length === 0) return 0;
      if (!(await deps.dataReserve.isBackgroundReadAllowed("data"))) return 0;
      const credentials = await deps.authResolver.resolve({ credentialRef, requiredScopes: [YOUTUBE_READ_SCOPE] });
      const found = new Map((await deps.dataApi.getPublicVideoTitles({ credentials, videoIds: wanted })).map((row) => [row.videoId, row]));
      await deps.titles.save(
        wanted.map((videoId) => found.get(videoId) ?? { videoId, title: null, channelId: null, channelTitle: null }),
        deps.clock.now()
      );
      return wanted.length;
    } catch {
      return 0;
    }
  }

  async function classify(rows: TrafficDetailValue[]): Promise<SuggestedSourceRow[]> {
    const ids = [...new Set(rows.map((row) => row.detail))];
    if (ids.length === 0) return [];
    const [own, fresh] = await Promise.all([
      deps.ownVideos.findByIds(ids),
      deps.titles.listFresh(ids, new Date(deps.clock.now().getTime() - RETENTION_MS)),
    ]);
    const ownOf = new Map(own.map((row) => [row.videoId, row]));
    const titleOf = new Map(fresh.map((row) => [row.videoId, row]));
    return rows.map(({ detail, views, estimatedMinutesWatched }) => {
      const mine = ownOf.get(detail);
      const info = mine ?? titleOf.get(detail);
      return {
        videoId: detail,
        views,
        estimatedMinutesWatched,
        source: mine ? "ours" : "external",
        title: info?.title ?? null,
        channelId: info?.channelId ?? null,
        channelTitle: info?.channelTitle ?? null,
      };
    });
  }

  return {
    /**
     * `createTrafficDetailServices().collectDue` for `RELATED_VIDEO` (BL-169's schedule, cap and failure rules), then the titles of the
     * channel's external suggesting videos that have none (`titlesLookedUp` ids). A run the Analytics part stops (`stop`, a video's
     * `defer`) raises as before and looks nothing up.
     */
    async collectDueSuggestedSources(input: unknown): Promise<{ attempted: number; collected: number; failed: number; titlesLookedUp: number }> {
      const result = await engine.collectDue(input);
      const { credentialRef, channelId } = input as { credentialRef: unknown; channelId: string };
      return { ...result, titlesLookedUp: await lookUpExternalTitles(credentialRef, channelId) };
    },

    /** `createTrafficDetailServices().listStored`, with each row's `source`, title and channel. Local only. */
    async listStoredSuggestedSources(input: unknown): Promise<ListStoredSuggestedSourcesResult> {
      const result: ListStoredTrafficDetailsResult = await engine.listStored(input);
      if ("videos" in result) {
        return {
          channelId: result.channelId,
          videos: await Promise.all(result.videos.map(async ({ rows, ...video }) => ({ ...video, sources: await classify(rows) }))),
        };
      }
      const { rows, weeks, ...base } = result;
      return {
        ...base,
        weeks: await Promise.all(
          weeks.map(async ({ rows: weekRows, ...week }) => ({ ...week, ...(weekRows ? { sources: await classify(weekRows) } : {}) }))
        ),
        ...(rows ? { sources: await classify(rows) } : {}),
      };
    },
  };
}

export type SuggestedSourceServices = ReturnType<typeof createSuggestedSourceServices>;

/** The background gate (BL-169's AC-ST-13): while less than the configured reserve of the Analytics quota is left, nothing is queried. */
export function gateSuggestedSourceCollection(
  guard: { isBackgroundReadAllowed(service: "analytics"): Promise<boolean> },
  collect: SuggestedSourceServices["collectDueSuggestedSources"]
): SuggestedSourceServices["collectDueSuggestedSources"] {
  return async (input) =>
    (await guard.isBackgroundReadAllowed("analytics")) ? collect(input) : { attempted: 0, collected: 0, failed: 0, titlesLookedUp: 0 };
}
