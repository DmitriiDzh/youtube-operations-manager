import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../video-metadata/contracts";
import { callYoutubeApi, classifyYoutubeReadError, wrapYoutubeClientForQuotaClassification } from "./error-classification";

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

test("classifyYoutubeReadError: a real 403 quotaExceeded becomes a youtube_quota_exceeded DomainError", () => {
  assert.throws(
    () => classifyYoutubeReadError(googleApiError(403, "quotaExceeded")),
    (error: unknown) => error instanceof DomainError && error.code === "youtube_quota_exceeded"
  );
});

test("classifyYoutubeReadError: the older dailyLimitExceeded reason is also classified as quota exceeded", () => {
  assert.throws(
    () => classifyYoutubeReadError(googleApiError(403, "dailyLimitExceeded")),
    (error: unknown) => error instanceof DomainError && error.code === "youtube_quota_exceeded"
  );
});

// The most important negative case: a DIFFERENT 403 reason (e.g. a genuine permission problem)
// must re-throw completely unchanged, never misclassified as a quota problem -- an agent or user
// told "wait for the quota reset" for an actual permissions error would take the wrong action.
test("classifyYoutubeReadError: a non-quota 403 (e.g. forbidden) re-throws the ORIGINAL error unchanged", () => {
  const original = googleApiError(403, "forbidden");
  assert.throws(
    () => classifyYoutubeReadError(original),
    (error: unknown) => error === original
  );
});

test("classifyYoutubeReadError: a 404 notFound re-throws the original error unchanged", () => {
  const original = googleApiError(404, "videoNotFound");
  assert.throws(
    () => classifyYoutubeReadError(original),
    (error: unknown) => error === original
  );
});

test("classifyYoutubeReadError: a non-Google-shaped error (e.g. a plain network failure) re-throws unchanged", () => {
  const original = new Error("ECONNRESET");
  assert.throws(
    () => classifyYoutubeReadError(original),
    (error: unknown) => error === original
  );
});

test("classifyYoutubeReadError: never includes a reset timestamp -- the Analytics API's own reset boundary was never verified, and a wrong one is worse than none", () => {
  try {
    classifyYoutubeReadError(googleApiError(403, "quotaExceeded"));
    assert.fail("expected classifyYoutubeReadError to throw");
  } catch (error) {
    assert.ok(error instanceof DomainError);
    const details = error.details as { resetAt?: unknown } | undefined;
    assert.equal(details?.resetAt, undefined);
  }
});

test("callYoutubeApi: a successful call passes its result through unchanged", async () => {
  const result = await callYoutubeApi(async () => "ok");
  assert.equal(result, "ok");
});

test("callYoutubeApi: a quotaExceeded thrown by the wrapped call is classified", async () => {
  await assert.rejects(
    () =>
      callYoutubeApi(async () => {
        throw googleApiError(403, "quotaExceeded");
      }),
    (error: unknown) => error instanceof DomainError && error.code === "youtube_quota_exceeded"
  );
});

test("callYoutubeApi: a non-quota error thrown by the wrapped call propagates unchanged", async () => {
  const original = googleApiError(500, undefined, "internal error");
  await assert.rejects(
    () =>
      callYoutubeApi(async () => {
        throw original;
      }),
    (error: unknown) => error === original
  );
});

// --- wrapYoutubeClientForQuotaClassification -----------------------------------------------
// Owner instruction, 2026-09-22, Telegram, after an earlier version wrapped each of the ~15
// individual call sites instead: "у нас же один шлюз который взаимодействует с API, он и может
// и обрабатывать / переводить это сообщение". This is the single choke point
// (`createYoutubeClient`/`createYoutubeAnalyticsClient`) applying classification once, to a
// fake client shaped like the real nested `youtube_v3.Youtube`/`youtubeAnalytics_v2.Youtubeanalytics`
// (resource sub-objects with methods), never a real googleapis client.

// **Matches the real `googleapis` client's own property shape, not an arbitrary plain object.**
// Found live (2026-09-22): the real `youtube_v3.Youtube` client defines each resource
// (`.channels`, `.videos`, etc.) as a NON-CONFIGURABLE, NON-WRITABLE own property -- an earlier
// version of `wrapYoutubeClientForQuotaClassification` used `new Proxy(client, {get...})`
// directly, which throws `TypeError: 'get' on proxy: property '...' is a read-only and
// non-configurable data property...` for exactly this shape. A plain-object fixture (the
// original version of this fixture) does NOT trigger that invariant, which is exactly why the
// bug wasn't caught until a live check against the real client -- this fixture is deliberately
// built with `Object.defineProperty` to reproduce the real constraint and prevent a regression.
function fakeYoutubeLikeClient(overrides: {
  listResult?: unknown;
  listError?: unknown;
}) {
  const client = {};
  Object.defineProperty(client, "videos", {
    value: {
      async list() {
        if (overrides.listError) throw overrides.listError;
        return overrides.listResult ?? { data: { items: [] } };
      },
    },
    writable: false,
    configurable: false,
    enumerable: true,
  });
  Object.defineProperty(client, "channels", {
    value: {
      async list() {
        return { data: { items: [{ id: "UC_untouched" }] } };
      },
    },
    writable: false,
    configurable: false,
    enumerable: true,
  });
  return client as { videos: { list(): Promise<unknown> }; channels: { list(): Promise<unknown> } };
}

test("wrapYoutubeClientForQuotaClassification: a successful call's result passes through unchanged", async () => {
  const client = wrapYoutubeClientForQuotaClassification(
    fakeYoutubeLikeClient({ listResult: { data: { items: [{ id: "vid1" }] } } })
  );
  const result = await client.videos.list();
  assert.deepEqual(result, { data: { items: [{ id: "vid1" }] } });
});

test("wrapYoutubeClientForQuotaClassification: a quotaExceeded thrown by ANY resource's method is classified, with no per-call-site wrapping needed", async () => {
  const client = wrapYoutubeClientForQuotaClassification(
    fakeYoutubeLikeClient({ listError: googleApiError(403, "quotaExceeded") })
  );
  await assert.rejects(
    () => client.videos.list(),
    (error: unknown) => error instanceof DomainError && error.code === "youtube_quota_exceeded"
  );
});

test("wrapYoutubeClientForQuotaClassification: a non-quota error from one resource's method propagates unchanged, and does not affect other resources", async () => {
  const original = googleApiError(404, "videoNotFound");
  const client = wrapYoutubeClientForQuotaClassification(fakeYoutubeLikeClient({ listError: original }));

  await assert.rejects(
    () => client.videos.list(),
    (error: unknown) => error === original
  );
  // A different, untouched resource on the SAME wrapped client still works normally.
  const channelsResult = await client.channels.list();
  assert.deepEqual(channelsResult, { data: { items: [{ id: "UC_untouched" }] } });
});
