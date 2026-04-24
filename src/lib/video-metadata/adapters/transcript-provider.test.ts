import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedCredentials } from "../contracts";
import { createTranscriptProvider } from "./transcript-provider";

function makeCredentials(): ResolvedCredentials {
  return {
    credentialRef: { userId: "user-1" },
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenExpiry: 111,
    scopeSet: new Set(["https://www.googleapis.com/auth/youtube.readonly"]),
  };
}

type TranscriptProviderStubs = {
  list: () => Promise<{ data: { items?: Array<{ id?: string; snippet?: { language?: string } }> } }>;
  download: () => Promise<{ data: ArrayBuffer | Buffer | string }>;
};

function makeProvider(stubs: TranscriptProviderStubs) {
  return createTranscriptProvider({
    provider: "youtube-captions",
    createOAuthClient: () => ({
      setCredentials: () => undefined,
    }),
    createYoutubeClient: () => ({
      captions: {
        list: async () => stubs.list(),
        download: async () => stubs.download(),
      },
    }),
  });
}

test("transcript provider maps empty captions list to no-captions", async () => {
  const provider = makeProvider({
    list: async () => ({ data: { items: [] } }),
    download: async () => ({ data: Buffer.from("unused") }),
  });

  const result = await provider.getTranscript({
    credentials: makeCredentials(),
    videoId: "video-1",
  });

  assert.deepEqual(result, {
    status: "unavailable",
    reason: "no-captions",
  });
});

test("transcript provider maps captions.list quota errors as rate-limited retriable", async () => {
  const provider = makeProvider({
    list: async () => {
      throw {
        response: {
          status: 403,
          data: {
            error: {
              errors: [{ reason: "quotaExceeded" }],
            },
          },
          headers: { authorization: "Bearer should-never-leak" },
          config: { url: "https://www.googleapis.com/youtube/v3/captions" },
        },
      };
    },
    download: async () => ({ data: Buffer.from("unused") }),
  });

  const result = await provider.getTranscript({
    credentials: makeCredentials(),
    videoId: "video-1",
  });

  assert.deepEqual(result, {
    status: "unavailable",
    reason: "rate-limited",
    diagnostic: {
      stage: "captions-list",
      httpStatus: 403,
      apiReason: "quotaexceeded",
      retriable: true,
    },
  });
});

test("transcript provider maps captions.download forbidden as captions-not-downloadable", async () => {
  const provider = makeProvider({
    list: async () => ({
      data: {
        items: [{ id: "caption-1", snippet: { language: "es" } }],
      },
    }),
    download: async () => {
      throw {
        response: {
          status: 403,
          data: {
            error: {
              errors: [{ reason: "forbidden" }],
            },
          },
        },
      };
    },
  });

  const result = await provider.getTranscript({
    credentials: makeCredentials(),
    videoId: "video-1",
  });

  assert.deepEqual(result, {
    status: "unavailable",
    reason: "captions-not-downloadable",
    diagnostic: {
      stage: "captions-download",
      httpStatus: 403,
      apiReason: "forbidden",
      retriable: false,
    },
  });
});

test("transcript provider maps list auth errors as permissions-insufficient", async () => {
  const provider = makeProvider({
    list: async () => {
      throw {
        response: {
          status: 403,
          data: {
            error: {
              errors: [{ reason: "insufficientPermissions" }],
            },
          },
        },
      };
    },
    download: async () => ({ data: Buffer.from("unused") }),
  });

  const result = await provider.getTranscript({
    credentials: makeCredentials(),
    videoId: "video-1",
  });

  assert.deepEqual(result, {
    status: "unavailable",
    reason: "permissions-insufficient",
    diagnostic: {
      stage: "captions-list",
      httpStatus: 403,
      apiReason: "insufficientpermissions",
      retriable: false,
    },
  });
});

test("transcript provider maps 5xx errors as retriable api-error", async () => {
  const provider = makeProvider({
    list: async () => {
      throw {
        response: {
          status: 503,
          data: {
            error: {
              errors: [{ reason: "backendError" }],
            },
          },
        },
      };
    },
    download: async () => ({ data: Buffer.from("unused") }),
  });

  const result = await provider.getTranscript({
    credentials: makeCredentials(),
    videoId: "video-1",
  });

  assert.deepEqual(result, {
    status: "unavailable",
    reason: "api-error",
    diagnostic: {
      stage: "captions-list",
      httpStatus: 503,
      apiReason: "backenderror",
      retriable: true,
    },
  });
});

test("transcript provider keeps unknown as safe fallback and sanitizes apiReason", async () => {
  const provider = makeProvider({
    list: async () => {
      throw {
        response: {
          status: 418,
          data: {
            error: {
              errors: [{ reason: "token=SECRET&scope=*" }],
            },
          },
        },
        config: {
          headers: { authorization: "Bearer SECRET" },
          url: "https://private.example/internal",
        },
      };
    },
    download: async () => ({ data: Buffer.from("unused") }),
  });

  const result = await provider.getTranscript({
    credentials: makeCredentials(),
    videoId: "video-1",
  });

  assert.deepEqual(result, {
    status: "unavailable",
    reason: "unknown",
    diagnostic: {
      stage: "captions-list",
      httpStatus: 418,
      apiReason: "tokensecretscope",
      retriable: false,
    },
  });
});

test("transcript provider maps empty normalized SRT to no-captions", async () => {
  const provider = makeProvider({
    list: async () => ({
      data: {
        items: [{ id: "caption-1", snippet: { language: "es" } }],
      },
    }),
    download: async () => ({
      data: Buffer.from("1\n00:00:00,100 --> 00:00:01,000\n\n", "utf8"),
    }),
  });

  const result = await provider.getTranscript({
    credentials: makeCredentials(),
    videoId: "video-1",
  });

  assert.deepEqual(result, {
    status: "unavailable",
    reason: "no-captions",
  });
});

test("transcript provider returns unsupported when provider is not youtube-captions", async () => {
  const provider = createTranscriptProvider({ provider: "disabled" });
  const result = await provider.getTranscript({
    credentials: makeCredentials(),
    videoId: "video-1",
  });

  assert.deepEqual(result, {
    status: "unsupported",
    reason: "provider-missing",
  });
});
