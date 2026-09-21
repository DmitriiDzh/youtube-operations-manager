import assert from "node:assert/strict";
import test from "node:test";
import { getLiveWritesEnabled, setLiveWritesEnabled } from "@/lib/db";
import {
  classifyYoutubeWriteError,
  createYoutubeWriteExecutor,
  performYoutubeWrite,
  type MinimalYoutubeWriteClient,
} from "./write-executor.youtube";
import { DomainError, type PreparedPayload } from "../contracts";

// Fixtures derived independently from the official YouTube Data API v3 documentation
// (developers.google.com/youtube/v3/docs/videos/update and .../videos/docs/errors),
// verified 2026-09-18 -- not copied from this adapter's own implementation. Error shape
// (`{ response: { status, data: { error: { errors: [{ reason }] } } } }`) matches the
// existing convention already used for googleapis errors elsewhere in this repository
// (see src/lib/playlist-management/services.ts's classifyYoutubeMutationError and its
// tests).

function googleApiError(status: number, reason?: string, message?: string) {
  return {
    response: {
      status,
      data: {
        error: {
          message: message ?? `error ${status}`,
          errors: reason ? [{ reason }] : [],
        },
      },
    },
    message: message ?? `error ${status}`,
  };
}

const preparedPayload: PreparedPayload = {
  videoId: "v1",
  snippet: {
    title: "New Title",
    description: "New Description",
    categoryId: "10",
    tags: ["jazz", "cuba"],
    defaultLanguage: "es",
    defaultAudioLanguage: "es",
  },
  localizations: {
    es: { title: "New Title", description: "New Description" },
    de: { title: "Titel DE", description: "Beschreibung DE" },
  },
};

// --- classifyYoutubeWriteError -----------------------------------------------------

test("classifyYoutubeWriteError: a 403 quotaExceeded is permanent AND systemic (AC-QUOTA-02)", () => {
  const result = classifyYoutubeWriteError(googleApiError(403, "quotaExceeded"));
  assert.deepEqual(result, {
    outcome: "FAILED",
    detail: `error 403`,
    classification: "permanent",
    systemic: true,
  });
});

test("classifyYoutubeWriteError: documented 400 badRequest reasons are permanent, not systemic", () => {
  for (const reason of ["invalidTitle", "invalidDescription", "invalidCategoryId", "defaultLanguageNotSet", "invalidVideoMetadata"]) {
    const result = classifyYoutubeWriteError(googleApiError(400, reason));
    assert.equal(result.outcome, "FAILED");
    assert.equal((result as { classification: string }).classification, "permanent");
    assert.equal((result as { systemic?: boolean }).systemic, undefined);
  }
});

// (independent review, second cycle): Google's documented guidance treats a 403 rate-limit
// reason the same as 429 -- transient, not a permanent authorization/quota problem. Previously
// fell through into the generic 400/401/403/404 "permanent" bucket, so a legitimate throttling
// condition killed otherwise-valid writes outright instead of being retried.
test("classifyYoutubeWriteError: 403 rateLimitExceeded/userRateLimitExceeded is transient, not permanent", () => {
  for (const reason of ["rateLimitExceeded", "userRateLimitExceeded"]) {
    const result = classifyYoutubeWriteError(googleApiError(403, reason));
    assert.equal(result.outcome, "FAILED");
    assert.equal((result as { classification: string }).classification, "transient");
    assert.equal((result as { systemic?: boolean }).systemic, undefined);
  }
});

test("classifyYoutubeWriteError: 403 forbidden (non-quota) is permanent, not systemic", () => {
  const result = classifyYoutubeWriteError(googleApiError(403, "forbidden"));
  assert.equal(result.outcome, "FAILED");
  assert.equal((result as { classification: string }).classification, "permanent");
  assert.equal((result as { systemic?: boolean }).systemic, undefined);
});

test("classifyYoutubeWriteError: 404 videoNotFound is permanent", () => {
  const result = classifyYoutubeWriteError(googleApiError(404, "videoNotFound"));
  assert.equal(result.outcome, "FAILED");
  assert.equal((result as { classification: string }).classification, "permanent");
});

test("classifyYoutubeWriteError: 401 (auth failure) is permanent", () => {
  const result = classifyYoutubeWriteError(googleApiError(401));
  assert.equal(result.outcome, "FAILED");
  assert.equal((result as { classification: string }).classification, "permanent");
});

test("classifyYoutubeWriteError: 408/429/5xx are transient (Google's documented general retry guidance; matches AC-RETRY-01/03's HTTP 503 fixture)", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const result = classifyYoutubeWriteError(googleApiError(status));
    assert.equal(result.outcome, "FAILED", `status ${status} should be FAILED`);
    assert.equal((result as { classification: string }).classification, "transient", `status ${status} should be transient`);
  }
});

test("classifyYoutubeWriteError: no HTTP response at all (timeout/connection reset) is UNKNOWN, never a direct-retry FAILED (DEC-OQ-6/§0.F)", () => {
  const result = classifyYoutubeWriteError(new Error("ETIMEDOUT"));
  assert.equal(result.outcome, "UNKNOWN");
});

test("classifyYoutubeWriteError: an unrecognized HTTP status is UNKNOWN, never guessed as permanent or transient", () => {
  const result = classifyYoutubeWriteError(googleApiError(418));
  assert.equal(result.outcome, "UNKNOWN");
});

// --- performYoutubeWrite (full request/response pipeline, mocked client only) -----

test("performYoutubeWrite: sends the exact prepared payload to videos.update, preserving id/snippet/localizations, and never bypasses the barrier (it has none -- that is attemptWrite's job)", async () => {
  const calls: unknown[] = [];
  const client: MinimalYoutubeWriteClient = {
    videos: {
      update: (async (params: unknown) => {
        calls.push(params);
        return { data: {} };
      }) as MinimalYoutubeWriteClient["videos"]["update"],
    },
  };

  const result = await performYoutubeWrite(client, preparedPayload);

  assert.deepEqual(result, { outcome: "SUCCESS" });
  assert.equal(calls.length, 1);
  const sent = calls[0] as { part: string[]; requestBody: { id: string; snippet: unknown; localizations: unknown } };
  assert.deepEqual(sent.part, ["snippet", "localizations"]);
  assert.equal(sent.requestBody.id, "v1");
  assert.deepEqual(sent.requestBody.snippet, preparedPayload.snippet);
  assert.deepEqual(sent.requestBody.localizations, preparedPayload.localizations);
});

test("performYoutubeWrite: RISK-11 defense-in-depth -- read-only snippet fields are stripped even if a payload somehow contained them", async () => {
  const calls: unknown[] = [];
  const client: MinimalYoutubeWriteClient = {
    videos: {
      update: (async (params: unknown) => {
        calls.push(params);
        return { data: {} };
      }) as MinimalYoutubeWriteClient["videos"]["update"],
    },
  };

  const contaminatedPayload: PreparedPayload = {
    ...preparedPayload,
    snippet: {
      ...preparedPayload.snippet,
      publishedAt: "2026-01-01T00:00:00.000Z",
      channelId: "UC_TEST",
      channelTitle: "Tropico Jazz",
      thumbnails: { default: { url: "https://example.com/v1.jpg" } },
      liveBroadcastContent: "none",
      localized: { title: "x", description: "y" },
    },
  };

  await performYoutubeWrite(client, contaminatedPayload);

  const sent = calls[0] as { requestBody: { snippet: Record<string, unknown> } };
  for (const readOnlyField of ["publishedAt", "channelId", "channelTitle", "thumbnails", "liveBroadcastContent", "localized"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(sent.requestBody.snippet, readOnlyField), false);
  }
  assert.equal(sent.requestBody.snippet.title, preparedPayload.snippet.title);
});

test("performYoutubeWrite: a thrown googleapis error is classified, not propagated raw", async () => {
  const client: MinimalYoutubeWriteClient = {
    videos: {
      update: (async () => {
        throw googleApiError(403, "quotaExceeded");
      }) as MinimalYoutubeWriteClient["videos"]["update"],
    },
  };

  const result = await performYoutubeWrite(client, preparedPayload);
  assert.equal(result.outcome, "FAILED");
  assert.equal((result as { systemic?: boolean }).systemic, true);
});

// --- The mandatory live-write barrier (attemptWrite) -------------------------------

test("attemptWrite: the barrier rejects every call before the client is ever touched -- no real credentials or endpoints involved", async () => {
  let clientConstructed = false;
  const executor = createYoutubeWriteExecutor({
    async getClient() {
      clientConstructed = true;
      throw new Error("must never be reached -- the barrier must fire first");
    },
  });

  await assert.rejects(
    () => executor.attemptWrite(preparedPayload),
    (error: unknown) => error instanceof DomainError && error.code === "live_writes_disabled"
  );
  assert.equal(clientConstructed, false, "the barrier must reject before deps.getClient() is ever called");
});

test("attemptWrite: the barrier fires regardless of payload content (not gated by dryRun, a request field, or any payload shape)", async () => {
  const executor = createYoutubeWriteExecutor({
    async getClient(): Promise<MinimalYoutubeWriteClient> {
      throw new Error("must never be reached");
    },
  });

  for (const payload of [preparedPayload, { videoId: "v1", snippet: {}, localizations: {} }, {}, null, undefined]) {
    await assert.rejects(
      () => executor.attemptWrite(payload),
      (error: unknown) => error instanceof DomainError && error.code === "live_writes_disabled"
    );
  }
});

test("attemptWrite: with the persisted live-writes setting on, the barrier lets the call through to the client (Layer 2 mirror of the off case)", async () => {
  const alreadyEnabled = await getLiveWritesEnabled();
  assert.equal(alreadyEnabled, false, "sanity check -- every process boot forces this off; a prior test left it on");

  await setLiveWritesEnabled(true);
  try {
    let clientConstructed = false;
    const executor = createYoutubeWriteExecutor({
      async getClient(): Promise<MinimalYoutubeWriteClient> {
        clientConstructed = true;
        return { videos: { update: (async () => ({ data: {} })) as unknown as MinimalYoutubeWriteClient["videos"]["update"] } };
      },
    });

    await executor.attemptWrite(preparedPayload);
    assert.equal(clientConstructed, true, "the barrier must let the call through once the setting is on");
  } finally {
    await setLiveWritesEnabled(false);
  }
});
