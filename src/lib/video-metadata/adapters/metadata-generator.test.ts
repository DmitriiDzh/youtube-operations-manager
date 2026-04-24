import assert from "node:assert/strict";
import test from "node:test";
import { createMetadataGenerator } from "./metadata-generator";
import { DomainError } from "../contracts";

const ORIGINAL_MODE = process.env.METADATA_GENERATOR_MODE;
const ORIGINAL_RAW_OUTPUT = process.env.METADATA_GENERATOR_RAW_OUTPUT;

function resetGeneratorEnv() {
  if (ORIGINAL_MODE === undefined) {
    delete process.env.METADATA_GENERATOR_MODE;
  } else {
    process.env.METADATA_GENERATOR_MODE = ORIGINAL_MODE;
  }

  if (ORIGINAL_RAW_OUTPUT === undefined) {
    delete process.env.METADATA_GENERATOR_RAW_OUTPUT;
  } else {
    process.env.METADATA_GENERATOR_RAW_OUTPUT = ORIGINAL_RAW_OUTPUT;
  }
}

test.afterEach(() => {
  resetGeneratorEnv();
});

test("metadata generator returns valid draft in rule-based mode", async () => {
  process.env.METADATA_GENERATOR_MODE = "rule-based";
  delete process.env.METADATA_GENERATOR_RAW_OUTPUT;

  const generator = createMetadataGenerator();

  const draft = await generator.generate({
    video: {
      videoId: "video-1",
      title: "Original title",
      description: "Original description",
      publishedAt: "2024-01-01T00:00:00Z",
    },
    transcript: { status: "available", text: "Transcript body" },
    editorialPrompt: "Hacé un título editorial",
  });

  assert.ok(draft.finalTitle.length > 0);
  assert.ok(draft.description.length > 0);
  assert.ok(draft.promptVersion.length > 0);

});

test("metadata generator rejects malformed raw-json as validation_failed", async () => {
  process.env.METADATA_GENERATOR_MODE = "raw-json";
  process.env.METADATA_GENERATOR_RAW_OUTPUT = JSON.stringify({
    finalTitle: "Only title",
  });

  const generator = createMetadataGenerator();

  await assert.rejects(
    () =>
      generator.generate({
        video: {
          videoId: "video-1",
          title: "Original title",
          description: "Original description",
          publishedAt: "2024-01-01T00:00:00Z",
        },
        transcript: { status: "unsupported", reason: "provider-missing" },
        editorialPrompt: "Prompt",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );

});
