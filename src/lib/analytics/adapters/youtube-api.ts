import { createGoogleOAuthClient } from "@/lib/auth";
import {
  createYoutubeClient,
  createYoutubeAnalyticsClient,
  getPublicVideoTitles,
  queryChannelAnalyticsReport,
  queryChannelBreakdownReport,
  queryVideoAnalyticsReport,
} from "@/lib/youtube-read-gateway";
import type { ResolvedCredentials } from "../contracts";

async function createAuthorizedClient(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
  });

  return createYoutubeAnalyticsClient(oauth2);
}

export function createAnalyticsYoutubeApiAdapter() {
  return {
    /** BL-191: titles of other people's videos that suggested ours (Data API `videos.list`, through the read gateway). */
    async getPublicVideoTitles(args: { credentials: ResolvedCredentials; videoIds: string[] }) {
      const oauth2 = createGoogleOAuthClient();
      oauth2.setCredentials({ access_token: args.credentials.accessToken, refresh_token: args.credentials.refreshToken });
      return getPublicVideoTitles(await createYoutubeClient(oauth2), args.videoIds);
    },

    async queryVideoAnalyticsReport(args: {
      credentials: ResolvedCredentials;
      channelId: string;
      videoId: string;
      startDate: string;
      endDate: string;
      metricNames: readonly string[];
    }) {
      const youtubeAnalytics = await createAuthorizedClient(args.credentials);
      return queryVideoAnalyticsReport(youtubeAnalytics, {
        channelId: args.channelId,
        videoId: args.videoId,
        startDate: args.startDate,
        endDate: args.endDate,
        metricNames: args.metricNames,
      });
    },

    async queryChannelAnalyticsReport(args: {
      credentials: ResolvedCredentials;
      channelId: string;
      startDate: string;
      endDate: string;
      metricNames: readonly string[];
    }) {
      const youtubeAnalytics = await createAuthorizedClient(args.credentials);
      return queryChannelAnalyticsReport(youtubeAnalytics, {
        channelId: args.channelId,
        startDate: args.startDate,
        endDate: args.endDate,
        metricNames: args.metricNames,
      });
    },

    async queryChannelBreakdownReport(args: {
      credentials: ResolvedCredentials;
      channelId: string;
      startDate: string;
      endDate: string;
      dimensions?: string;
      metricNames: readonly string[];
      filters?: string;
      maxResults?: number;
      sort?: string;
    }) {
      const youtubeAnalytics = await createAuthorizedClient(args.credentials);
      return queryChannelBreakdownReport(youtubeAnalytics, {
        channelId: args.channelId,
        startDate: args.startDate,
        endDate: args.endDate,
        dimensions: args.dimensions,
        metricNames: args.metricNames,
        filters: args.filters,
        maxResults: args.maxResults,
        sort: args.sort,
      });
    },
  };
}
