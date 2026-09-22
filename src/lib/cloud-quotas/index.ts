import { createCloudConnectionCore } from "@/lib/cloud-connection";
import {
  fetchDailyQuotaLimit,
  fetchDailyQuotaUsage,
  fetchLatestMinuteUsage,
  fetchPerMinuteQuotaLimit,
  type FetchLike,
} from "./adapters/monitoring-client";
import { createCloudQuotasServices } from "./services";

// Google's own OAuth client ID convention: "{project_number}-{random}.apps.googleusercontent.com"
// -- the project owner pointed this out directly (2026-09-22, Telegram: "он уже зашит в
// GOOGLE_CLIENT_ID, зачем мне присылать сам код в терминал, используй это поле") rather than
// asking for a separate project number to be configured. Confirmed correct by the spike this
// session: `131970858038` (this env's actual prefix) returned real quota data from both services.
export function deriveGoogleCloudProjectNumber(clientId: string | undefined): string | null {
  if (!clientId) return null;
  const match = clientId.match(/^(\d+)-/);
  return match ? match[1] : null;
}

// Same discipline as `src/lib/ai-connections/index.ts`'s `productionFetch` -- the only place a
// bare global `fetch` reference is allowed in this module.
const productionFetch: FetchLike = (url, init) => fetch(url, init);

export function createCloudQuotasCore() {
  return createCloudQuotasServices({
    cloudConnection: createCloudConnectionCore(),
    monitoringClient: { fetchDailyQuotaLimit, fetchDailyQuotaUsage, fetchPerMinuteQuotaLimit, fetchLatestMinuteUsage },
    fetchImpl: productionFetch,
    projectNumber: deriveGoogleCloudProjectNumber(process.env.GOOGLE_CLIENT_ID),
  });
}

export type { CloudQuotaStatus, PerMinuteQuotaStatus, QuotaService, ServiceQuotaStatus } from "./contracts";
