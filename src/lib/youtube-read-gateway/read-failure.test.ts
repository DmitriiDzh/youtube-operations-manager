import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { failureKind } from "./read-failure";

// BL-171 (docs/roadmap/plans/VIDEO_COMMENTS_PLAN.md §2 "Failures", AC-VC-07/12): the shared rules, now in the read gateway. The analytics
// steps' own tests cover the Analytics answers unchanged; here the one widening -- every category's reads switch stops a run -- and the
// Data API answers the comments meet.

const googleError = (status: number, reason: string) => Object.assign(new Error(`HTTP ${status} ${reason}`), { response: { status, data: { error: { errors: [{ reason }] } } } });

test("read-failure: every reads-switched-off code stops the run, as Analytics' did", () => {
  for (const code of ["analytics_reads_disabled", "data_api_reads_disabled", "reporting_reads_disabled"] as const) {
    assert.equal(failureKind(new DomainError({ code, message: "off" })), "stop", code);
  }
});

test("read-failure: Data API answers -- quota and 401 stop, 5xx/429/no answer defer, a 404 or a video's own 403 is an attempt", () => {
  assert.equal(failureKind(new DomainError({ code: "youtube_quota_exceeded", message: "quota" })), "stop");
  assert.equal(failureKind(googleError(403, "quotaExceeded")), "stop");
  assert.equal(failureKind(googleError(401, "authError")), "stop");
  assert.equal(failureKind(googleError(503, "backendError")), "defer");
  assert.equal(failureKind(googleError(429, "rateLimitExceeded")), "defer");
  assert.equal(failureKind(new Error("socket hang up")), "defer");
  assert.equal(failureKind(googleError(404, "videoNotFound")), "attempt");
  assert.equal(failureKind(googleError(403, "forbidden")), "attempt");
});
