import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../video-metadata/contracts";
import { callYoutubeApi, classifyYoutubeReadError } from "./error-classification";

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
