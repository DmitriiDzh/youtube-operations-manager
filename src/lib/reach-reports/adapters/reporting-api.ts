import { createGoogleOAuthClient } from "@/lib/auth";
import {
  createYoutubeReportingClient,
  downloadReportCsv,
  ensureReportingJob,
  listJobReports,
  parseReportingCsv,
} from "@/lib/youtube-read-gateway";
import type { ReachReportsDependencies } from "../services";
import type { ResolvedCredentials } from "../contracts";

async function createAuthorizedClient(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({ access_token: credentials.accessToken, refresh_token: credentials.refreshToken });
  return createYoutubeReportingClient(oauth2 as never);
}

export function createReachReportsApiAdapter(): ReachReportsDependencies["reportingApi"] {
  return {
    async ensureJob({ credentials, reportTypeId, name }) {
      return ensureReportingJob(await createAuthorizedClient(credentials), { reportTypeId, name });
    },
    async listReports({ credentials, jobId }) {
      return listJobReports(await createAuthorizedClient(credentials), { jobId });
    },
    async downloadAndParse({ credentials, downloadUrl }) {
      const client = await createAuthorizedClient(credentials);
      return parseReportingCsv(await downloadReportCsv(client, downloadUrl));
    },
  };
}
