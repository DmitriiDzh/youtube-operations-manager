import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/video-metadata/contracts";
import { createTranscriptPostHandler } from "./route";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/video-metadata/transcript", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeMalformedRequest() {
  return new Request("http://localhost/api/video-metadata/transcript", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
}

test("transcript route returns transcript payload on happy path", async () => {
  const handler = createTranscriptPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      getTranscript: async () => ({
        transcript: {
          status: "available",
          text: "hola mundo",
          language: "es",
        },
      }),
    },
  });

  const response = await handler(makeRequest({ videoId: "video-1" }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    transcript: {
      status: "available",
      text: "hola mundo",
      language: "es",
    },
  });
});

test("transcript route keeps unavailable diagnostic contract unchanged", async () => {
  const handler = createTranscriptPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      getTranscript: async () => ({
        transcript: {
          status: "unavailable",
          reason: "rate-limited",
          diagnostic: {
            stage: "captions-list",
            httpStatus: 429,
            apiReason: "ratelimitexceeded",
            retriable: true,
          },
        },
      }),
    },
  });

  const response = await handler(makeRequest({ videoId: "video-1" }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    transcript: {
      status: "unavailable",
      reason: "rate-limited",
      diagnostic: {
        stage: "captions-list",
        httpStatus: 429,
        apiReason: "ratelimitexceeded",
        retriable: true,
      },
    },
  });
});

test("transcript route returns 401 when session is missing", async () => {
  const handler = createTranscriptPostHandler({
    getSession: async () => null,
    core: {
      getTranscript: async () => ({ transcript: { status: "available", text: "unused" } }),
    },
  });

  const response = await handler(makeRequest({ videoId: "video-1" }));
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(payload, { error: "Unauthorized" });
});

test("transcript route maps validation errors to 400", async () => {
  const handler = createTranscriptPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      getTranscript: async () => {
        throw new DomainError({
          code: "validation_failed",
          message: "Invalid transcript input",
          details: [{ path: "videoId", code: "too_small" }],
        });
      },
    },
  });

  const response = await handler(makeRequest({}));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error, "validation_failed");
  assert.equal(payload.message, "Invalid transcript input");
});

test("transcript route maps malformed JSON bodies to 400", async () => {
  const handler = createTranscriptPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      getTranscript: async () => ({ transcript: { status: "available", text: "unused" } }),
    },
  });

  const response = await handler(makeMalformedRequest());
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, {
    error: "validation_failed",
    message: "Malformed JSON request body",
    details: [
      {
        path: "",
        message: "Request body must be valid JSON",
        code: "invalid_json",
      },
    ],
  });
});
