import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/video-metadata/contracts";
import { parseVideoMetadataJsonBody } from "./parse-json-body";

test("parseVideoMetadataJsonBody returns parsed JSON payload", async () => {
  const request = new Request("http://localhost/api/video-metadata/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ videoId: "video-1" }),
  });

  const payload = await parseVideoMetadataJsonBody(request);

  assert.deepEqual(payload, { videoId: "video-1" });
});

test("parseVideoMetadataJsonBody maps malformed JSON to validation_failed", async () => {
  const request = new Request("http://localhost/api/video-metadata/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });

  await assert.rejects(
    () => parseVideoMetadataJsonBody(request),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "validation_failed");
      assert.equal(error.message, "Malformed JSON request body");
      assert.deepEqual(error.details, [
        {
          path: "",
          message: "Request body must be valid JSON",
          code: "invalid_json",
        },
      ]);
      return true;
    }
  );
});
