import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { CloudCredentialSection } from "./contracts";
import { createCloudCredentialsTransfer, type CredentialSectionPort } from "./services";

// BL-134 (review): a file carrying a Hugging Face token is all or nothing like the others -- every section is checked with its
// provider BEFORE any is stored, and a message names the section's own provider.

const PASSWORD = "long enough passphrase";
const FAST = { N: 2 ** 10, r: 8, p: 1 };

function section(name: string, stored: string[], opts: { refuseCheck?: boolean } = {}): CredentialSectionPort {
  return {
    exportSecret: async () => ({ secret: name === "huggingface" ? { token: "hf_x" } : name === "gemini" ? { apiKey: "AIza" } : { runpodApiKey: "rpa" }, hints: {} }),
    check: async (secret) => {
      if (opts.refuseCheck) throw new DomainError({ code: "hf_token_invalid", message: "Hugging Face did not accept the stored token (HTTP 401)." });
      return secret;
    },
    store: async () => {
      stored.push(name);
      return { stored: name };
    },
  };
}

test("a refused Hugging Face token stores nothing -- RunPod and Gemini stay untouched -- and the message names Hugging Face", async () => {
  const exportedFrom = createCloudCredentialsTransfer({
    sections: { runpod: section("runpod", []), gemini: section("gemini", []), huggingface: section("huggingface", []) } as Record<CloudCredentialSection, CredentialSectionPort>,
    clock: { now: () => new Date("2026-10-18T00:00:00Z") },
    passwordScrypt: FAST,
  });
  const { file } = await exportedFrom.exportFile({ password: PASSWORD });
  assert.deepEqual(file.sections, ["runpod", "gemini", "huggingface"]);

  const stored: string[] = [];
  const importer = createCloudCredentialsTransfer({
    sections: { runpod: section("runpod", stored), gemini: section("gemini", stored), huggingface: section("huggingface", stored, { refuseCheck: true }) } as Record<CloudCredentialSection, CredentialSectionPort>,
    clock: { now: () => new Date("2026-10-18T00:00:00Z") },
    passwordScrypt: FAST,
  });
  await assert.rejects(importer.importFile({ file, password: PASSWORD }), (e: unknown) => e instanceof DomainError && e.code === "hf_token_invalid" && e.message.startsWith("Hugging Face:"));
  assert.deepEqual(stored, []);
});
