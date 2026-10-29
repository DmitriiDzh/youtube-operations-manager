import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { createSpeechSurface, type SpeechProviderPort } from "./speech";

// BL-236 (ADR 0057): the one speech surface routes by provider (create) and by the job id's prefix (get), lists both providers
// newest first, and refuses an unknown provider instead of guessing. Providers are fakes.

function fake(prefix: string, calls: string[]): () => SpeechProviderPort {
  return () => ({
    status: async () => ({ enabled: prefix === "gm_" }),
    createJob: async (input, actor) => {
      calls.push(`${prefix}create ${JSON.stringify(input)} ${actor}`);
      return { job: { jobId: `${prefix}1` } };
    },
    getJob: async (jobId) => ({ job: { jobId } }),
    listJobs: async () => [{ jobId: `${prefix}a`, createdAt: prefix === "gm_" ? "2026-10-29T10:00:00Z" : "2026-10-29T11:00:00Z" }],
    ownsJobId: (jobId) => jobId.startsWith(prefix),
  });
}

test("routes a create by provider without passing `provider` on; a get by the id's prefix; lists newest first; status side by side", async () => {
  const calls: string[] = [];
  const surface = createSpeechSurface({ gemini: fake("gm_", calls), elevenlabs: fake("el_", calls) });
  assert.deepEqual(await surface.createJob({ provider: "elevenlabs", channelId: "UC1", voice: "Sumire", text: "hi" }, "factory"), { provider: "elevenlabs", job: { jobId: "el_1" } });
  assert.deepEqual(calls, ['el_create {"channelId":"UC1","voice":"Sumire","text":"hi"} factory']);
  assert.deepEqual(await surface.getJobs({ jobId: "gm_9" }), { provider: "gemini", job: { jobId: "gm_9" } });
  assert.deepEqual(((await surface.getJobs({})).jobs as Array<{ jobId: string }>).map((j) => j.jobId), ["el_a", "gm_a"]);
  assert.deepEqual(await surface.getStatus(), { providers: { gemini: { enabled: true }, elevenlabs: { enabled: false } } });
});

test("an unknown provider is validation_failed; an unknown job id is not found", async () => {
  const surface = createSpeechSurface({ gemini: fake("gm_", []) });
  for (const promise of [surface.createJob({ provider: "openai", text: "x" }, "factory"), surface.getJobs({ provider: "openai" })]) {
    await assert.rejects(promise, (error) => isDomainError(error) && error.code === "validation_failed");
  }
  await assert.rejects(surface.getJobs({ jobId: "zz_1" }), (error) => isDomainError(error) && error.code === "gemini_job_not_found");
  await assert.rejects(surface.createJob({ provider: "elevenlabs", text: "x" }, "factory"), (error) => isDomainError(error) && error.code === "voice_registry_unavailable");
});
