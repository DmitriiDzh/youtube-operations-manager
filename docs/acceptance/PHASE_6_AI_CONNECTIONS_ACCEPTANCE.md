# PHASE_6_AI_CONNECTIONS_ACCEPTANCE.md

**Status: APPROVED for the scope below (2026-09-19, project owner's "Phase 6 — Provider-Agnostic AI Connections" assignment).** This document is written before implementation, per `AGENTS.md` §L, deriving scenarios from that assignment message directly (its numbered sections 1-9) plus the already-approved `docs/acceptance/PHASE_6_ACCEPTANCE.md` (which this feature must not regress — the mock provider, editorial profiles, Change Set/Batch reuse, and the Phase 5 write barrier all remain governed by that document).

## 1. Scope boundary

**In scope:** a provider-agnostic "AI Connections" entity (id, display name, adapter type, base URL, model id, optional encrypted credential, enabled state, status, capability metadata, task assignment), a small adapter registry (mock + one real "OpenAI-compatible" protocol adapter), CRUD + explicit "test connection" via a Settings UI and API, encrypted-at-rest credential storage, SSRF-resistant endpoint validation, and wiring so `ai-localization`'s existing `generateProposals` can optionally use a chosen connection instead of the default mock — all without changing `ai-localization`'s domain logic, `changesets`, or `batches`.

**Out of scope (explicitly, per the assignment):** hardcoding any specific vendor/model; a separate adapter per model; OS-keychain integration (see §4 decision below — an encrypted-at-rest alternative is implemented instead, with the abstraction kept swappable); a universal agent-execution framework; Codex as a provider; analytics/competitor research/publishing; any real paid API call from this task's own work; real YouTube writes/live validation/OAuth; Phase 7.

## 2. Architectural decision recorded: credential storage (per assignment §4/§9)

Three options were considered:

- **A — OS keychain** (Windows Credential Manager / macOS Keychain / Linux Secret Service) via a native Node module (e.g. `keytar` or a modern equivalent). Strongest isolation, but adds a native-binary dependency with cross-platform packaging/maintenance risk, and several such packages are unmaintained. Not implemented now; the storage interface (see `src/lib/ai-connections/adapters/store.ts`) is designed so this could be swapped in later without changing any calling code.
- **B — Application-managed encryption at rest** (AES-256-GCM, key supplied via an environment variable never committed to the repository, ciphertext/IV/auth-tag stored in a dedicated SQLite table separate from the connection's own row). No new dependency (Node's built-in `crypto`). Consistent with this repository's existing pattern of environment-variable-sourced secrets (`GOOGLE_CLIENT_SECRET`, etc.) and its "trusted operator's own machine" deployment model. **Chosen for this implementation.**
- **C — Plaintext in the database.** Explicitly forbidden by the assignment. Rejected.

**Consequence:** if the encryption key environment variable (`AI_CONNECTIONS_ENCRYPTION_KEY`) is not configured, saving a connection **with** a credential fails closed with a clear, structured error — never a plaintext fallback. A connection with no credential (e.g., a local endpoint requiring none) can still be created either way.

## 3. Safety invariants (must hold for every scenario below)

- **INV-AIC-1** A stored credential's plaintext is never returned to any API response or logged, under any code path, including error paths.
- **INV-AIC-2** No automatic paid API call is ever made by loading this module, listing connections, or the app starting up. A network call only happens from an explicit "generate" or "test connection" action.
- **INV-AIC-3** A connection's configured Base URL is validated against SSRF/internal-network access before every real outbound call, not only at save time.
- **INV-AIC-4** An unsupported or undeclared capability produces an explicit error before any network call is attempted — never a silent best-effort guess.
- **INV-AIC-5** AI-generated content from a real connection is validated server-side with exactly the same field-level rules as the mock provider (`docs/acceptance/PHASE_6_ACCEPTANCE.md` AC-GEN-08/09) — a provider's own structured-output guarantee is never trusted as a substitute.
- **INV-AIC-6** Nothing in this feature changes `approvalStatus` behavior, the Change Set/Batch pipeline, or the Phase 5 live-write barrier.
- **INV-AIC-7** No automated test in this repository ever makes a real network call to any external host.

## 4. Acceptance scenarios

### AC-CONN-01 — Creating a connection persists it without ever exposing the submitted credential back to the caller

- **Fixed test inputs:** `createConnection({ displayName: "Test", adapterType: "openai_compatible", baseUrl: "https://api.example.com/v1", modelId: "some-model", apiKey: "sk-secret-value", capabilities: { structuredOutput: "json_object" } })`.
- **Expected result:** Returns a connection record with `hasCredential: true` and **no field anywhere in the response containing `"sk-secret-value"`** or any derivative of it.
- **Verification method:** Automated (assert the full JSON-serialized response never contains the submitted secret string).
- **Pass/fail criteria:** PASS iff the secret never appears in the response. FAIL on any leak, including in an error/details field.

### AC-CONN-02 — A stored credential is encrypted at rest, never plaintext

- **Fixed test inputs:** Same as AC-CONN-01, then inspect the raw stored row via the store adapter directly (bypassing the service layer).
- **Expected result:** The stored ciphertext does not contain the plaintext secret as a substring; decrypting it with the correct key recovers the exact original secret.
- **Verification method:** Automated (fake/in-memory store still exercises the real `encrypt`/`decrypt` functions).
- **Pass/fail criteria:** PASS iff ciphertext never contains the plaintext and round-trip decryption is exact. FAIL otherwise.

### AC-CONN-03 — Without a configured encryption key, saving a connection with a credential fails closed (no plaintext fallback)

- **Fixed test inputs:** `createConnection({ ..., apiKey: "sk-secret" })` with the encryption key resolver returning `null`.
- **Expected result:** Throws a structured `DomainError` (`encryption_key_not_configured`); nothing is persisted.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the call rejects and nothing is stored. FAIL if it silently stores plaintext or a default key.

### AC-CONN-04 — Connection CRUD: create, edit, disable, delete

- **Fixed test inputs:** Create a connection; update its `displayName`/`modelId`; set `enabled: false`; delete it.
- **Expected result:** Each operation succeeds and is reflected in subsequent reads; after deletion, `getConnection` returns `not_found` and the associated credential row (if any) is also gone (verified via the store adapter).
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff every state transition is observable and deletion is total (no orphaned credential row). FAIL otherwise.

### AC-CONN-05 — Credential replacement and explicit deletion independent of the connection itself

- **Fixed test inputs:** Create a connection with credential A; update with a new credential B (no other fields); then update with `apiKey: null` to clear the credential while keeping the connection.
- **Expected result:** After replacing, decrypting the stored credential yields B, not A. After clearing, `hasCredential: false` and the credential row is gone; the connection itself still exists.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff replacement and independent clearing both work exactly as described. FAIL if the old credential lingers or the connection is deleted as a side effect.

### AC-CONN-06 — Authorization: every connections endpoint requires a session, exactly like every other route in this codebase

- **Fixed test inputs:** Call each new API route without a session cookie.
- **Expected result:** `401 Unauthorized`, before any service logic runs.
- **Verification method:** Automated (route-level test) or, at minimum, code inspection confirming the identical `getServerSession(authOptions)` guard already used by every other route (`AC-CONN-06` may be verified structurally if a full route-level test harness isn't already established for this repository's other routes — match whatever level of coverage `src/app/api/channels/[channelId]/change-sets/route.ts` already has).
- **Pass/fail criteria:** PASS iff the guard is present and structurally identical to existing routes. FAIL if any new route omits it.

### AC-CONN-07 — Endpoint validation rejects private/internal/loopback/metadata addresses unless local-inference mode is explicitly enabled

- **Fixed test inputs:** `validateEndpointUrl("http://169.254.169.254/latest/meta-data", { allowLocal: false })`, `validateEndpointUrl("http://127.0.0.1:11434", { allowLocal: false })`, `validateEndpointUrl("http://192.168.1.10:8000", { allowLocal: false })`, `validateEndpointUrl("http://10.0.0.5", { allowLocal: false })`, each also repeated with `allowLocal: true`.
- **Expected result:** All four reject with `allowLocal: false`; all four are accepted (subject to no other rule) with `allowLocal: true`.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff every private/internal/loopback/metadata address is blocked by default and only accepted under explicit local-inference mode. FAIL on any bypass.

### AC-CONN-08 — Endpoint validation requires HTTPS for non-local endpoints

- **Fixed test inputs:** `validateEndpointUrl("http://api.example.com/v1", { allowLocal: false })`.
- **Expected result:** Rejected (plain HTTP not allowed for a remote, non-local endpoint).
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff HTTP-to-a-public-host is rejected. FAIL if accepted.

### AC-CONN-09 — Endpoint validation re-resolves the hostname and blocks a hostname that resolves to a private address (DNS-rebinding class)

- **Fixed test inputs:** A hostname whose DNS resolution is mocked to return a private-range IP (e.g. `10.0.0.5`), `allowLocal: false`.
- **Expected result:** Rejected, even though the hostname/URL string itself looks like a public domain.
- **Verification method:** Automated (mock the DNS resolution function injected into `validateEndpointUrl`).
- **Pass/fail criteria:** PASS iff a private resolved address is blocked regardless of the hostname string. FAIL if only the string is checked and the resolved address is ignored. **Documented residual limitation:** this check happens immediately before the outbound call but does not pin the connection socket to the validated address, so an adversarial DNS server could in principle re-resolve differently between the check and the actual HTTP request (a narrow TOCTOU window) — acceptable for the current single-operator, locally-trusted deployment model (`docs/TECHNICAL_DEBT.md` Gate D remains the trigger to revisit this for network deployment).

### AC-CONN-10 — An undeclared or unsupported capability produces an explicit error before any network call

- **Fixed test inputs:** A connection with `capabilities: { structuredOutput: "none" }` (or the field omitted); attempt generation through it.
- **Expected result:** Throws `capability_not_supported` immediately; the underlying HTTP client is never invoked (assert zero fetch calls).
- **Verification method:** Automated (spy on the injected fetch function).
- **Pass/fail criteria:** PASS iff the error is thrown and no network call occurs. FAIL if a best-effort call is attempted anyway.

### AC-CONN-11 — Malformed JSON from the provider is treated as a provider error, isolated per target, never a crash

- **Fixed test inputs:** A fake HTTP client that returns a 200 response whose body is not valid JSON (or valid JSON missing the expected `title`/`description` fields).
- **Expected result:** The generation target reports a `providerError`, exactly like a mock-provider failure in `docs/acceptance/PHASE_6_ACCEPTANCE.md` AC-GEN-07 — sibling targets in the same `generateProposals` call are unaffected.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff malformed output is isolated and reported, never thrown uncaught. FAIL if it aborts the whole call or is silently accepted as valid content.

### AC-CONN-12 — A provider timeout is bounded and reported, not hung indefinitely

- **Fixed test inputs:** A fake HTTP client whose response never resolves within the configured timeout (default value stated in the implementation, e.g. 30s, injectable/shorter in tests).
- **Expected result:** The call aborts at the timeout boundary and reports a `providerError` (e.g. `"timeout"`), isolated per target.
- **Verification method:** Automated (inject a short timeout for the test).
- **Pass/fail criteria:** PASS iff the call is bounded and reported. FAIL if it can hang indefinitely or crash the process.

### AC-CONN-13 — Server-side validation applies identically to real-connection output as to mock output

- **Fixed test inputs:** A fake real-connection response with an empty `title` and a 101-character title (mirrors `docs/acceptance/PHASE_6_ACCEPTANCE.md` AC-GEN-08/09's fixtures).
- **Expected result:** Same `validationStatus: "invalid"` outcomes as the mock-provider equivalents, using the exact same shared validation function (`classifyAndValidateField` in `src/lib/ai-localization/services.ts`) — not a duplicated, parallel validator.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff validation is identical regardless of source. FAIL if a real connection's output bypasses or duplicates the existing validation.

### AC-CONN-14 — Zero real network calls in the automated test suite; zero YouTube mutations; unchanged approval/Change Set behavior

- **Requirement reference:** INV-AIC-7; `docs/acceptance/PHASE_6_ACCEPTANCE.md`'s INV-6.1/6.5 (no auto-approval, full reuse).
- **Verification method:** Automated repository inventory test (mirrors `src/lib/ai-localization/write-path-inventory.test.ts`'s pattern) confirming: no real HTTP/AI-SDK dependency reachable except through the OpenAI-compatible adapter's own injectable fetch client (never a bare global `fetch` call hardwired without dependency injection, so tests can never accidentally reach a real host); no reference to any Phase 5 live-write-capable symbol; every persisted `Change` from a connection-backed generation still starts `approvalStatus: "pending"`.
- **Pass/fail criteria:** PASS iff the inventory holds. FAIL on any regression.

### AC-CONN-15 — Explicit "test connection" action, cost-aware, never automatic

- **Fixed test inputs:** `testConnection(connectionId)` called directly (simulating the explicit UI button).
- **Expected result:** For a real (`openai_compatible`) connection, the result explicitly states `mayIncurCost: true`; for the mock adapter, `mayIncurCost: false`. Nothing calls `testConnection` automatically anywhere in this codebase (checked by inventory/grep: the function is only referenced by its own route handler and its own tests).
- **Verification method:** Automated + structural grep.
- **Pass/fail criteria:** PASS iff the cost flag is correct per adapter type and no automatic caller exists. FAIL otherwise.

### AC-CONN-16 — Unknown usage/pricing is reported as unknown, never fabricated as zero

- **Fixed test inputs:** A generation response with no `usage` field, and/or a connection with no configured pricing metadata.
- **Expected result:** The reported estimated cost is `null`/"unknown", never `0`.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff absent data is reported as unknown. FAIL if defaulted to zero or any invented number.

### AC-CONN-17 — A generation request routed through a connection preserves the entire existing AI Localization pipeline unchanged

- **Fixed test inputs:** `generateProposals({ ..., connectionId: "<a real-adapter connection backed by a fake HTTP client>" })`, followed by `createChangeSetFromGeneration` and the existing approve/Batch/dry-run flow (mirrors `docs/acceptance/PHASE_6_ACCEPTANCE.md` AC-BATCH-REUSE-01/AC-PRESERVE-01).
- **Expected result:** Identical behavior to the mock-provider path: editorial profile merge still applies, per-request `editorialBrief` still applies, every persisted `Change` starts `pending`, approval/conflict/Batch/dry-run all work unmodified, and untouched locales are still preserved end to end.
- **Verification method:** Automated (integration test).
- **Pass/fail criteria:** PASS iff behavior is indistinguishable from the mock-provider path except for which adapter actually ran. FAIL on any divergence.

## 5. Non-goals restated

Real vendor selection/payment, OS-keychain integration, a generic multi-provider agent framework, Codex-as-provider, analytics/competitor research/publishing, any real network call from this task, live validation, and Phase 7 remain explicitly out of scope, per the assignment's own §9.

## 6. Status

**APPROVED for implementation as of 2026-09-19**, per the project owner's assignment message, which is itself the required explicit authorization (`AGENTS.md` §C).
