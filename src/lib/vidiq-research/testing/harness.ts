import { createKeyFile, type KeyFileAccess } from "@/lib/device-key-file";
import { createDeviceSecrets, createMemoryDeviceSecretStore } from "@/lib/device-secrets";
import { DomainError } from "@/lib/shared-domain";
import { createVidiqGateway } from "@/lib/vidiq-gateway";
import { startFakeVidiqServer, type FakeVidiqServer } from "@/lib/vidiq-gateway/testing/fake-server";
import { createMemoryVidiqStore } from "../memory-store";
import { createVidiqResearchServices, serialLock } from "../services";

// BL-278 stage 1: the module wired to in-memory stores and a real gateway whose `fetch` is the in-process fake vidIQ server (no
// socket). Tests only.

export const SENTINEL_KEY = "vq_SENTINEL_7f3a9c";

export async function createVidiqHarness(options: { now?: Date; timeoutMs?: number } = {}) {
  const fake: FakeVidiqServer = await startFakeVidiqServer({ acceptKey: SENTINEL_KEY });
  let keyFileText: string | null = null;
  const keyAccess: KeyFileAccess = {
    async read() {
      return keyFileText;
    },
    async write(content) {
      keyFileText = JSON.stringify(content);
    },
    async remove() {
      keyFileText = null;
    },
    randomBytes: (size) => Buffer.alloc(size, 7),
  };
  const secretRows = createMemoryDeviceSecretStore();
  const secret = createDeviceSecrets({ store: secretRows, keyFile: createKeyFile(keyAccess, (detail) => new DomainError({ code: "encryption_key_not_configured", message: detail })) }).slot("vidiq");
  const store = createMemoryVidiqStore();
  const clock = { at: options.now ?? new Date("2026-11-26T15:00:00Z") };
  const logs: string[] = [];
  const gatewayOutcomes: string[] = [];
  /** The gateway's own clock (its 1 h tool-list cache): real time plus an offset a test may move forward. */
  const gatewayClock = { offsetMs: 0 };
  // Both timeouts are only a backstop for a broken test (the fake answers at once, or never when a test scripts a hang);
  // `timeoutMs` is the tools/call timeout a timeout test shortens.
  const gateway = createVidiqGateway({ endpoint: fake.url, fetch: fake.fetch, timeoutMs: options.timeoutMs ?? 30_000, connectTimeoutMs: 120_000, now: () => Date.now() + gatewayClock.offsetMs, recordOutcome: async (outcome) => void gatewayOutcomes.push(outcome) });
  const services = createVidiqResearchServices({
    store,
    secret,
    gateway,
    clock: { now: () => new Date(clock.at.getTime()) },
    withLock: serialLock(),
    log: (line) => void logs.push(line),
  });
  return {
    fake,
    store,
    secret,
    secretRows,
    keyFileText: () => keyFileText,
    clock,
    logs,
    gatewayOutcomes,
    gatewayClock,
    services,
    /** tools/call requests the fake received for one tool. */
    callsOf: (tool: string) => fake.toolCalls().filter((c) => c.tool === tool).length,
    close: () => fake.close(),
  };
}

export type VidiqHarness = Awaited<ReturnType<typeof createVidiqHarness>>;
