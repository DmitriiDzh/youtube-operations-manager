import { createGoogleOAuthClient } from "@/lib/auth";
import { createYoutubeAnalyticsClient, queryVideoAnalyticsReport } from "@/lib/youtube-read-gateway";
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
  };
}
