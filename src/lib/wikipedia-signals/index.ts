import { randomUUID } from "node:crypto";
import {
  deleteTopicWikipediaArticle,
  getLatestWikipediaPageviewDate,
  insertTopicWikipediaArticle,
  listTopicWikipediaArticles,
  listWikipediaPageviews,
  upsertWikipediaPageviews,
} from "@/lib/db";
import { getDailyArticlePageviews } from "@/lib/wikipedia-gateway";
import { createWikipediaSignalsServices } from "./services";

export * from "./services";

/** Every 6 hours from the web server's scheduler; a run only fetches days not stored yet. */
export const WIKIPEDIA_COLLECTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function createWikipediaSignalsCore() {
  return createWikipediaSignalsServices({
    idGenerator: randomUUID,
    clock: { now: () => new Date() },
    insertLink: (input) => insertTopicWikipediaArticle(input),
    deleteLink: (id) => deleteTopicWikipediaArticle(id),
    listLinks: (topicId) => listTopicWikipediaArticles(topicId),
    upsertPageviews: (rows) => upsertWikipediaPageviews(rows),
    listPageviews: (args) => listWikipediaPageviews(args),
    latestPageviewDate: (args) => getLatestWikipediaPageviewDate(args),
    fetchPageviews: (args) => getDailyArticlePageviews(args),
  });
}
