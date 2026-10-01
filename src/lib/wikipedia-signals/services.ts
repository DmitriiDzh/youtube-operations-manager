import { DomainError } from "@/lib/shared-domain";

// ---------------------------------------------------------------------------
// Phase 13 slice 13.8 (docs/roadmap/plans/PHASE_13_PLAN.md) -- an interest signal from OUTSIDE
// YouTube: the daily page views of Wikipedia articles the operator links to a Research topic. Its
// own feature module (AGENTS.md §M): it knows topics only by id, market-intelligence knows nothing of
// it, and turning it off (Settings → Wikipedia reads) affects nothing else. Wikimedia data is CC0,
// not YouTube API data, so it may be kept and summarized freely.
// ---------------------------------------------------------------------------

export type TopicWikipediaArticle = { linkId: string; topicId: string; project: string; article: string; createdAt: string };

export type TopicWikipediaSignal = TopicWikipediaArticle & {
  /** Daily views, oldest first, for the last `WIKIPEDIA_SIGNAL_DAYS` days we have. */
  daily: { date: string; views: number }[];
  last30DaysViews: number | null;
  previous30DaysViews: number | null;
};

export const WIKIPEDIA_SIGNAL_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type WikipediaSignalsDeps = {
  idGenerator: () => string;
  clock: { now: () => Date };
  insertLink(input: { id: string; topicId: string; project: string; article: string; createdVia: string }): Promise<void>;
  deleteLink(id: string): Promise<boolean>;
  listLinks(topicId: string | null): Promise<{ id: string; topicId: string; project: string; article: string; createdAt: Date }[]>;
  upsertPageviews(rows: { project: string; article: string; date: string; views: number }[]): Promise<void>;
  listPageviews(args: { project: string; article: string; sinceDate: string }): Promise<{ date: string; views: number }[]>;
  latestPageviewDate(args: { project: string; article: string }): Promise<string | null>;
  fetchPageviews(args: { project: string; article: string; startDate: string; endDate: string }): Promise<{ date: string; views: number }[]>;
};

const PROJECT_RE = /^[a-z]{2,3}(-[a-z]+)?\.wikipedia$/;

/** Accepts a plain title ("Ambient music") or a Wikipedia URL; returns the canonical project/article. */
export function parseArticleReference(input: { project?: string; article: string }): { project: string; article: string } {
  const raw = input.article.trim();
  const url = /^https?:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i.exec(raw);
  const project = url ? `${url[1].toLowerCase()}.wikipedia` : (input.project ?? "en.wikipedia").trim().toLowerCase();
  let article = url ? decodeURIComponent(url[2]) : raw;
  article = article.replace(/ /g, "_");
  if (!PROJECT_RE.test(project)) {
    throw new DomainError({ code: "validation_failed", message: `Not a Wikipedia project: ${project} (e.g. en.wikipedia)` });
  }
  if (article.length === 0 || article.length > 255 || /[#<>[\]{}|]/.test(article)) {
    throw new DomainError({ code: "validation_failed", message: "Give a Wikipedia article title or URL" });
  }
  return { project, article };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function sumBetween(daily: { date: string; views: number }[], fromInclusive: string, toInclusive: string): number | null {
  const inRange = daily.filter((d) => d.date >= fromInclusive && d.date <= toInclusive);
  return inRange.length === 0 ? null : inRange.reduce((sum, d) => sum + d.views, 0);
}

export function createWikipediaSignalsServices(deps: WikipediaSignalsDeps) {
  return {
    async linkArticle(input: { topicId: string; project?: string; article: string }, ctx: { createdVia: string }) {
      const { project, article } = parseArticleReference(input);
      const id = deps.idGenerator();
      try {
        await deps.insertLink({ id, topicId: input.topicId, project, article, createdVia: ctx.createdVia });
      } catch (error) {
        const text = `${String(error)} ${String((error as { cause?: unknown } | null)?.cause ?? "")}`;
        // The link's FK onto the topic is the existence check -- this module never reads the
        // market-intelligence tables itself (AGENTS.md §M).
        if (/FOREIGN KEY/i.test(text)) {
          throw new DomainError({ code: "validation_failed", message: "No such topic" });
        }
        if (/UNIQUE/i.test(text)) {
          throw new DomainError({ code: "validation_failed", message: "This article is already linked to the topic" });
        }
        throw error;
      }
      return { linkId: id, topicId: input.topicId, project, article };
    },

    /** The link must belong to `topicId` (the route's own path) -- never delete another topic's link. */
    async unlinkArticle(linkId: string, topicId: string) {
      const belongs = (await deps.listLinks(topicId)).some((l) => l.id === linkId);
      if (!belongs || !(await deps.deleteLink(linkId))) {
        throw new DomainError({ code: "validation_failed", message: "No such Wikipedia link" });
      }
    },

    /** The links of one topic with their stored series -- no network call. */
    async listTopicSignals(topicId: string): Promise<TopicWikipediaSignal[]> {
      const now = deps.clock.now();
      const yesterday = isoDay(new Date(now.getTime() - MS_PER_DAY));
      const d30 = isoDay(new Date(now.getTime() - 30 * MS_PER_DAY));
      const d31 = isoDay(new Date(now.getTime() - 31 * MS_PER_DAY));
      const d60 = isoDay(new Date(now.getTime() - 60 * MS_PER_DAY));
      const since = isoDay(new Date(now.getTime() - WIKIPEDIA_SIGNAL_DAYS * MS_PER_DAY));
      const links = await deps.listLinks(topicId);
      return Promise.all(
        links.map(async (link) => {
          const daily = await deps.listPageviews({ project: link.project, article: link.article, sinceDate: since });
          return {
            linkId: link.id,
            topicId: link.topicId,
            project: link.project,
            article: link.article,
            createdAt: link.createdAt.toISOString(),
            daily,
            last30DaysViews: sumBetween(daily, d30, yesterday),
            previous30DaysViews: sumBetween(daily, d60, d31),
          };
        })
      );
    },

    /**
     * Fetches whatever is missing up to yesterday (UTC; Wikimedia publishes a day after it ends) for
     * every linked article -- at most `WIKIPEDIA_SIGNAL_DAYS` back. Idempotent; one article's failure
     * never stops the others.
     */
    async collectAll(): Promise<{ articles: number; failed: number }> {
      const now = deps.clock.now();
      const end = isoDay(new Date(now.getTime() - MS_PER_DAY));
      const earliest = isoDay(new Date(now.getTime() - WIKIPEDIA_SIGNAL_DAYS * MS_PER_DAY));
      const seen = new Set<string>();
      let failed = 0;
      for (const link of await deps.listLinks(null)) {
        const key = `${link.project}|${link.article}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const latest = await deps.latestPageviewDate({ project: link.project, article: link.article });
          const start = latest && latest >= earliest ? isoDay(new Date(Date.parse(`${latest}T00:00:00Z`) + MS_PER_DAY)) : earliest;
          if (start > end) continue;
          const rows = await deps.fetchPageviews({ project: link.project, article: link.article, startDate: start, endDate: end });
          await deps.upsertPageviews(rows.map((r) => ({ project: link.project, article: link.article, ...r })));
        } catch {
          failed += 1;
        }
      }
      return { articles: seen.size, failed };
    },
  };
}

export type WikipediaSignalsServices = ReturnType<typeof createWikipediaSignalsServices>;
