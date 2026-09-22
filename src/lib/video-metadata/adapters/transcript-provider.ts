import { createGoogleOAuthClient } from "@/lib/auth";
import { createYoutubeClient } from "@/lib/youtube-read-gateway";
import type {
  ResolvedCredentials,
  TranscriptDiagnostic,
  TranscriptDiagnosticStage,
  TranscriptResult,
  TranscriptUnavailableReason,
} from "../contracts";

type OAuthClientLike = {
  setCredentials(payload: { access_token: string; refresh_token?: string }): void;
};

type CaptionItem = {
  id?: string;
  snippet?: { language?: string };
};

type YoutubeClientLike = {
  captions: {
    list(args: {
      part: string[];
      videoId: string;
    }): Promise<{ data: { items?: CaptionItem[] } }>;
    download(
      args: { id: string; tfmt: "srt" },
      options: { responseType: "arraybuffer" }
    ): Promise<{ data: ArrayBuffer | Buffer | string }>;
  };
};

type TranscriptProviderDeps = {
  provider?: string;
  createOAuthClient?: () => OAuthClientLike;
  createYoutubeClient?: (oauth: OAuthClientLike) => YoutubeClientLike;
};

const RATE_LIMIT_REASONS = new Set(["ratelimitexceeded", "userratelimitexceeded", "quotaexceeded"]);
const PERMISSIONS_REASONS = new Set([
  "insufficientpermissions",
  "insufficientpermission",
  "autherror",
  "accessnotconfigured",
]);
const CAPTIONS_NOT_DOWNLOADABLE_REASONS = new Set([
  "captionnotfound",
  "cannotdownload",
  "captionsdisabled",
]);
const TRANSIENT_API_REASONS = new Set(["backenderror", "internalerror"]);

function normalizeSrt(text: string) {
  return text
    .replace(/^\d+$/gm, "")
    .replace(/^\d\d:\d\d:\d\d,\d{3}\s+-->\s+\d\d:\d\d:\d\d,\d{3}$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeTranscriptPayload(payload: ArrayBuffer | Buffer | string) {
  if (typeof payload === "string") return payload;
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(payload)).toString("utf8");
  }
  return payload.toString("utf8");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function sanitizeReason(value: unknown) {
  if (typeof value !== "string") return undefined;
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 80);

  return sanitized.length > 0 ? sanitized : undefined;
}

function extractHttpStatus(error: unknown) {
  const root = asRecord(error);
  const directStatus = root?.status;
  if (typeof directStatus === "number" && Number.isInteger(directStatus)) {
    return directStatus;
  }

  const response = asRecord(root?.response);
  const responseStatus = response?.status;
  if (typeof responseStatus === "number" && Number.isInteger(responseStatus)) {
    return responseStatus;
  }

  return undefined;
}

function extractApiReason(error: unknown) {
  const root = asRecord(error);
  const response = asRecord(root?.response);
  const data = asRecord(response?.data);
  const dataError = asRecord(data?.error);

  const candidateReasons = [
    Array.isArray(dataError?.errors)
      ? asRecord(dataError.errors[0])?.reason
      : undefined,
    asRecord(root?.error)?.reason,
    root?.reason,
  ];

  for (const candidate of candidateReasons) {
    const sanitized = sanitizeReason(candidate);
    if (sanitized) return sanitized;
  }

  return undefined;
}

function mapUnavailableReason(args: {
  stage: TranscriptDiagnosticStage;
  apiReason?: string;
  httpStatus?: number;
}): { reason: TranscriptUnavailableReason; retriable: boolean } {
  const apiReason = args.apiReason;
  if (apiReason) {
    if (RATE_LIMIT_REASONS.has(apiReason)) {
      return { reason: "rate-limited", retriable: true };
    }

    if (PERMISSIONS_REASONS.has(apiReason)) {
      return { reason: "permissions-insufficient", retriable: false };
    }

    if (CAPTIONS_NOT_DOWNLOADABLE_REASONS.has(apiReason)) {
      return { reason: "captions-not-downloadable", retriable: false };
    }

    if (apiReason === "forbidden") {
      return {
        reason:
          args.stage === "captions-download"
            ? "captions-not-downloadable"
            : "permissions-insufficient",
        retriable: false,
      };
    }

    if (TRANSIENT_API_REASONS.has(apiReason)) {
      return { reason: "api-error", retriable: true };
    }
  }

  if (args.httpStatus === 429) {
    return { reason: "rate-limited", retriable: true };
  }

  if (typeof args.httpStatus === "number" && args.httpStatus >= 500 && args.httpStatus <= 599) {
    return { reason: "api-error", retriable: true };
  }

  if (args.httpStatus === 403) {
    return {
      reason:
        args.stage === "captions-download"
          ? "captions-not-downloadable"
          : "permissions-insufficient",
      retriable: false,
    };
  }

  return { reason: "unknown", retriable: false };
}

function classifyTranscriptError(args: {
  stage: TranscriptDiagnosticStage;
  error: unknown;
}): Extract<TranscriptResult, { status: "unavailable" }> {
  const httpStatus = extractHttpStatus(args.error);
  const apiReason = extractApiReason(args.error);
  const mapped = mapUnavailableReason({
    stage: args.stage,
    apiReason,
    httpStatus,
  });

  const diagnostic: TranscriptDiagnostic = {
    stage: args.stage,
    ...(typeof httpStatus === "number" ? { httpStatus } : {}),
    ...(apiReason ? { apiReason } : {}),
    retriable: mapped.retriable,
  };

  return {
    status: "unavailable",
    reason: mapped.reason,
    diagnostic,
  };
}

export function createTranscriptProvider(deps: TranscriptProviderDeps = {}) {
  const provider = deps.provider ?? process.env.YOUTUBE_TRANSCRIPT_PROVIDER ?? "youtube-captions";
  const createOAuthClient =
    deps.createOAuthClient ?? (() => createGoogleOAuthClient() as unknown as OAuthClientLike);
  const createYoutube =
    deps.createYoutubeClient ??
    ((oauth: OAuthClientLike) =>
      createYoutubeClient(oauth as unknown as Parameters<typeof createYoutubeClient>[0]) as
        unknown as YoutubeClientLike);

  return {
    async getTranscript(args: {
      credentials: ResolvedCredentials;
      videoId: string;
    }): Promise<TranscriptResult> {
      if (provider !== "youtube-captions") {
        return {
          status: "unsupported",
          reason: "provider-missing",
        };
      }

      const oauth2 = createOAuthClient();
      oauth2.setCredentials({
        access_token: args.credentials.accessToken,
        refresh_token: args.credentials.refreshToken,
      });

      const youtube = createYoutube(oauth2);

      let listRes: Awaited<ReturnType<YoutubeClientLike["captions"]["list"]>>;
      try {
        listRes = await youtube.captions.list({
          part: ["snippet"],
          videoId: args.videoId,
        });
      } catch (error) {
        return classifyTranscriptError({ stage: "captions-list", error });
      }

      const caption = listRes.data.items?.[0];
      if (!caption?.id) {
        return {
          status: "unavailable",
          reason: "no-captions",
        };
      }

      let downloadRes: Awaited<ReturnType<YoutubeClientLike["captions"]["download"]>>;
      try {
        downloadRes = await youtube.captions.download(
          {
            id: caption.id,
            tfmt: "srt",
          },
          {
            responseType: "arraybuffer",
          }
        );
      } catch (error) {
        return classifyTranscriptError({ stage: "captions-download", error });
      }

      const rawText = decodeTranscriptPayload(downloadRes.data);
      const normalizedText = normalizeSrt(rawText);

      if (!normalizedText) {
        return {
          status: "unavailable",
          reason: "no-captions",
        };
      }

      return {
        status: "available",
        text: normalizedText,
        language: caption.snippet?.language ?? undefined,
      };
    },
  };
}
