# Independent test-suite audit — 2026-09-26

Produced per the project owner's Telegram request: *"Проведи независимый анализ тестов. Все ли
они актуальны и правильно работают. Возможно их можно оптимизировать / сократить."* This is a
review-only deliverable — no test or production code was changed while producing it. Findings are
reported here for the owner to prioritize; none has been fixed yet.

## Method

The full suite (127 test files, 1487 tests, all passing on `dev` as of commit `8d92b58`) was split
into 7 non-overlapping domain zones, each independently audited by a fresh reviewer with no memory
of writing any of the code, per the project's established review discipline (`AGENTS.md` §L). Each
reviewer read every assigned test file in full, ran it against the real suite, and cross-checked it
against the actual current production source (not just documentation, which this project's own
history shows can lag). Reviewers were told what to flag (staleness against removed/changed
functionality, `AGENTS.md` §L "would pass regardless of a real bug" defects, genuine duplication)
and what NOT to flag (mocking real external APIs, legitimate defense-in-depth across interfaces,
slowness inherent to a real concurrency/scale guarantee).

Zones: (1) sync-gateway/CRDT/channel-identity, (2) Batches/write-safety pipeline, (3)
Analytics/Cloud Quotas, (4) Web API routes + video-metadata/video-details/playlist-management, (5)
AI/agent domain modules, (6) YouTube read/write gateways + Change Sets + Localization +
`shared-*` utilities, (7) MCP server + CLI + infrastructure.

## Top-line verdict

**The suite is healthy overall.** 1487/1487 tests pass. No zone found a test exercising genuinely
removed/dead functionality, no wholesale stale-metric or superseded-enum problem, and most files
in every zone show real, spec-derived, independently-verified expected values (hand-computed
dates, live-API-observed fixtures with provenance comments, boundary tables) — the pattern
`AGENTS.md` §L asks for, not implementation-mirroring. Several zones are singled out below by
reviewers as house-style examples: `video-details/**`, `db.test.ts`, `operations-instructions/
services.test.ts`, `content-proposals/**`, `comparable-content/services.test.ts`.

Against that healthy baseline, the audit surfaced two categories of finding that matter more than
ordinary test hygiene, plus a genuine cluster of real reduction opportunities.

## Category A — real production-code gaps, found through test review, not test bugs

These are not test defects; they are actual gaps in the application, surfaced because trying to
write a rigorous test for the requirement exposed that the code doesn't fully meet it.

1. **HIGH — `playlist-management`'s `addVideosToPlaylist`/`removeVideosFromPlaylist` never
   validate channel identity.** Every sibling write method in the same file
   (`createPlaylist`/`updatePlaylist`/`deletePlaylist`) calls `writeContext.assertWriteChannel(...)`
   and fails closed on a mismatch. These two do not — and their input schemas don't even have an
   `expectedChannelId` field to accept one. Confirmed live across all three interfaces: the MCP
   tool handlers and CLI commands for add/remove-videos also omit `expectedChannelId`, while their
   sibling create/update/delete commands all require it. This conflicts with `docs/PROJECT_SPEC.md`
   §27 ("every write path must validate channel identity... including Web UI, API, CLI, MCP") and
   `AGENTS.md` §G. No UI currently calls the two web routes, but MCP/CLI are live surfaces today.
   **This needs the project owner's sign-off before fixing** (it changes a public API/MCP contract,
   `AGENTS.md` §A) — recommend adding `expectedChannelId` to both schemas, wiring
   `assertWriteChannel` the way update/delete already do, and threading it through CLI/MCP.
   `docs/DEVELOPMENT_PLAYBOOK.md` §6.5's "Identity verification — IMPLEMENTED" row is also
   inaccurate as written since it doesn't disclose this exclusion.

2. **HIGH — `batches/write-path-inventory.test.ts`'s `FORBIDDEN_SYMBOLS` list — the module's
   single mechanically-enforced live-write safety net — has a real hole.** It omits
   `executeSingleAttempt` (exported, zero current callers, but callable by a future route with none
   of `executeWithRetry`'s audit/ledger-transition/lock-release guarantees) and
   `createLiveWriteExecutorIfEnabled` (importable without the string `"WriteExecutor"` ever
   appearing at a call site without an explicit type annotation). Not currently exploited — no
   production reference exists to either — but exactly the kind of completeness gap `AGENTS.md`
   says should never be silently carried forward in a safety-critical inventory test. Recommend
   adding both symbols to the forbidden list, or deleting `executeSingleAttempt` outright (it is
   Slice-1-era and superseded by `executeWithRetry`).

3. **MEDIUM-HIGH — the real-connection AI-generation cost cap (`REAL_CONNECTION_MAX_TARGETS_PER_CALL
   = 50`) has zero test coverage anywhere in the repo.** This is the only thing standing between an
   agent-driven call and an unbounded paid-API bill via a real AI Connection. Its own code comment
   cites an acceptance-doc section (`PHASE_6_AI_CONNECTIONS_ACCEPTANCE.md` §7) that doesn't exist —
   that document only has sections 1–6, meaning this cap was never captured as a formal acceptance
   scenario at all. Recommend a boundary test (50 succeeds, 51 rejected as `validation_failed`).

4. **MEDIUM — `AC-AUDIT-03` (server-stamped `actorType`/`actorId` on every audit event) appears
   entirely unimplemented, not merely untested.** Neither field exists anywhere in
   `src/lib/audit/contracts.ts` or any caller. This is a real, undocumented gap between an approved
   Phase 5 acceptance criterion and what shipped — `docs/TECHNICAL_DEBT.md`'s Phase 5 progress notes
   explicitly track other known Phase 5 gaps (`AC-CONCURRENCY-03`, `AC-QUOTA-01`, `AC-RESUME-01`) but
   never mention this one. Needs an owner decision: implement it, or record it as an accepted,
   explicitly-deferred gap the way the others already are.

5. **MEDIUM — two unhandled-exception paths in the Web API playlist routes.**
   `src/app/api/youtube/playlists/route.ts`'s `GET` has no `try/catch` at all — any `DomainError`
   from the service layer becomes a bare framework 500 instead of the structured JSON error every
   sibling route returns (and has a regression test for). The three POST playlist routes
   (add-to-playlist/create-playlist/remove-from-playlist) all parse the request body with raw
   `request.json()` *before* their `try` block, instead of this app's own `parseVideoMetadataJsonBody`
   helper that every other route under `src/app/api/` is documented to use — a malformed body
   throws an uncaught `SyntaxError`, also a bare 500. None of the three has a 401-pre-auth test
   either, despite each implementing the check. Low blast radius (local-operator app, not
   internet-facing) but a real, cheaply-fixed correctness gap.

## Category B — a recurring, systemic gap in this repo's mechanical "inventory" tests

This project enforces several architectural invariants (single write gateway, single read gateway,
"module X stays auxiliary") with grep/regex-based tests rather than relying on convention alone —
a deliberate, valuable pattern (`AGENTS.md` §G). Earlier today, an independent review of the new
`shared-xlsx/usage-inventory.test.ts` found and fixed a real gap in that pattern: the original
regex only caught a static `from "..."` import, missing `import()`, `require()`, and side-effect
`import "..."`. **This same class of gap exists, unaddressed, in three older, more safety-critical
inventory tests the fix was never ported to:**

- `src/lib/youtube-read-gateway/read-gateway-inventory.test.ts` — both of its tests (the
  `googleapis`-import check and the barrel-only-import check) have the identical narrower-regex
  gap. Impact: a caller using `require()`/dynamic `import()`/side-effect import to reach
  `.videos.list(...)`/`.reports.query(...)` would bypass the per-category reads-enabled toggle, the
  quota-classification wrapper, and the 24h traffic counters, undetected by this test.
- `src/lib/youtube-write-gateway/gateway-inventory.test.ts`'s main check has the same notation gap
  (also can't catch bracket-notation calls like `youtube["videos"]["update"](...)`, a limitation
  its own doc comment already argues the import-level check should backstop — but that backstop
  has the same regex gap). Separately, its resource/verb list is not actually exhaustive against
  the installed `googleapis` package: `abuseReports.insert`, `playlistImages.*`,
  `thirdPartyLinks.*`, and `liveBroadcasts.insertCuepoint` are real mutating methods the pattern
  misses entirely. None of these three resources are used in production today — latent, not live.
- `src/lib/ai-connections/write-path-inventory.test.ts`'s SDK-detection patterns (checking no
  direct `openai`/`@anthropic-ai/` import exists outside the approved adapter) miss subpath imports
  (`from "openai/resources"`), side-effect imports, and dynamic imports — verified empirically, all
  three currently pass through undetected. Its sibling `ai-localization/write-path-inventory.test.ts`
  independently uses a looser-but-more-robust pattern that *does* catch all of these — the two
  files are inconsistent in strength for the same class of risk.

None of these are currently exploited (verified: no production file today actually uses any of the
missed forms). But given how many independent write-safety/read-safety guarantees rest on these
three files specifically, and that a proven fix pattern already exists in this same codebase
(`shared-xlsx/usage-inventory.test.ts`'s `IMPORT_PATTERNS` array), porting it to all three is a
cheap, high-value fix.

## Category C — tests that would pass regardless of the specific bug they claim to guard against

The recurring `AGENTS.md` §L failure mode found across multiple zones (not exhaustive — see each
zone's full report for more):

- `automerge-core/sync-runner.test.ts`'s mutual-exclusion test only asserts the adopt call ran
  once and returned `null` — deleting the actual exclusion guard from production code would not
  fail this test. Its sibling in `change-drafts-sync/services.test.ts` uses an ordered-events
  assertion that *would* catch this; the pattern should be ported over.
- `cloud-connection/services.test.ts`'s "sanity: encrypt/decrypt round-trips" test never calls
  `decryptSecret` at all — would pass even if decryption were completely broken. A separate test in
  the same file checks for plaintext leakage in stored ciphertext by substring-matching the raw
  base64 string without decoding first — verified this would not catch a regression that stored a
  merely base64-encoded (not actually AES-encrypted) token set.
- Four credential-resolution-failure tests in `analytics/services.test.ts` assert only
  `error instanceof DomainError`, never `.code` — a bug that mapped the failure to the wrong error
  code would pass undetected.
- `pickWritableSnippetFields`/`pickWritableStatusFields` (the RISK-11 whitelist functions gating
  what reaches a real `videos.update` call) have no negative test proving they strip a
  non-whitelisted field — unlike their sibling `pickWritableRecordingDetailsFields`, which has
  exactly this test. A regression that made either function forward its entire input unfiltered
  would pass every current test.
- `computeBackoffDelayMs` (the batches module's documented full-jitter retry-backoff formula, §0.E)
  has zero test coverage anywhere — every retry-test harness stubs the clock as a no-op that
  discards the delay argument entirely.
- `AC-BACKUP-01`'s own acceptance text requires proving backup precedes the write call for the same
  video; this is only ever demonstrated on the dry-run path today, never on a real (mocked)
  `WriteExecutor` call.
- The IPv4-mapped-IPv6 (`::ffff:...`) unwrap branch in the SSRF-protection code
  (`ai-connections/endpoint-security.ts`) is completely untested in either direction — and a
  related production-code gap was found alongside it: no branch handles NAT64-embedded addresses
  (`64:ff9b::/96`), a real, documented SSRF technique, which today would not be blocked at all.

## Category D — genuine, sizable reduction/optimization opportunities

- **`src/mcp/server.test.ts` and `src/cli/video-metadata.test.ts`** (the two largest files in the
  repo, combined >10,000 lines) independently maintain near-duplicate fixture builders for the same
  underlying cores. Two functions are byte-for-byte identical between the files. A shared
  test-fixtures module would meaningfully shrink both and remove the risk of the two CLI/MCP-parity
  suites silently drifting.
- **`src/lib/cli-auth/services.test.ts`**: 13 of ~15 tests inline an identical DB-stub object with
  no shared helper — extracting one would cut roughly 100-150 of this file's 746 lines with zero
  coverage loss.
- **`src/lib/playlist-management/services.test.ts`** (885 lines): a fixture helper exists but is
  used by only 1 of 12 tests; the other 11 each reconstruct the full dependency object inline. The
  sibling `video-details/services.test.ts` already demonstrates a leaner `makeDeps(overrides)`
  pattern in this same codebase that would apply directly here.
- **`src/lib/analytics/services.test.ts`** (1664 lines): roughly 9 near-identical "fails closed on
  wrong channel" tests, 5 "inverted date range" tests, and 3 "credential failure" tests are strong
  table-driving candidates — and while consolidating them, they should also be corrected to
  activate a genuinely *different* channel (not "no channel selected") to actually test what their
  names claim.
- **`withTempDir`**, a ~7-line mkdtemp/cleanup test helper, is independently duplicated across at
  least 10 files repo-wide (bootstrap-config, atomic-json-file, snapshot, sync-gateway ×4,
  db-backup, device-handoff) — a single shared `src/test-support/temp-dir.ts` would remove all of
  them mechanically, with zero risk.
- **`src/proxy.test.ts`**: four structurally identical "gates route X like any other real mutation"
  tests could be one table-driven test over an array of paths, matching a pattern the file already
  uses elsewhere in itself.
- Several other single-file opportunities are noted in the full zone reports (`cli/video-metadata.
  recovery-gate.test.ts`'s repeated fake-auth object, `ai-connections/crypto.test.ts`'s one
  genuinely redundant case against `shared-crypto/index.test.ts`).

**Explicitly NOT flagged as reducible**, per every reviewer's explicit judgment: the 100-video
resume acceptance test, the real-concurrency/race integration tests across `batches/**`, the
per-enum-value label tests in `analytics/breakdown-labels.test.ts` (each independently verified
against real API docs/live data — collapsing them would lose that per-value verification trail),
and cross-interface defense-in-depth tests (the same invariant re-verified at MCP/CLI/API layers
deliberately, not wastefully).

## Minor documentation drift noted (not fixed here)

- `docs/SYSTEM_MAP.md` §2.9s still describes `agent-connections` (BL-091) as "not in `dev`, ждёт
  мерджа" — it has been merged for some time; a stale section header.
- `docs/DEVELOPMENT_PLAYBOOK.md` §6.5's identity-verification status row overstates coverage (see
  Category A finding 1).
- A stale doc comment in `youtube-read-gateway/error-classification.ts` describes a test fixture
  shape the file no longer uses.

## What this document does not do

At the time this document was written, it did not fix anything — every finding above was reported
exactly as found, unimplemented. The owner then assigned exactly that work (Telegram, 2026-09-26:
*"Создай новую ветку и проведи в ней изменения / улучшения согласно результатам анализа. Я
согласовываю только финальный мердж в дев."*) on `feature/test-suite-audit-fixes`. See the
Disposition section below for what that branch actually did with each finding — this section's
original text is left as-is above (a snapshot of the review-only deliverable), not rewritten to
claim foreknowledge of the fixes that came after it.

## Disposition — `feature/test-suite-audit-fixes` (2026-09-26)

Every finding above got one of three outcomes. None was silently dropped.

**Category A:**
1. `addVideosToPlaylist`/`removeVideosFromPlaylist` channel-identity gap — **FIXED**, `b8d1578`.
   `expectedChannelId` added to both schemas (required), wired through `assertWriteChannel` exactly
   like `updatePlaylist`/`deletePlaylist`, threaded through the Web routes/CLI/MCP. This is a public
   API/MCP contract change — disclosed explicitly to the owner when this branch is presented for its
   final merge approval (`AGENTS.md` §K.2), not silently merged.
2. `write-path-inventory.test.ts` `FORBIDDEN_SYMBOLS` gap — **FIXED**, `ea12442`.
   `executeSingleAttempt`/`createLiveWriteExecutorIfEnabled` added to the forbidden list.
3. `REAL_CONNECTION_MAX_TARGETS_PER_CALL` cap has zero test coverage — **FIXED**, `4999223`. Boundary
   tests added (50 succeeds, 51 rejected with exact `{requested, limit}` details, mock provider
   uncapped); the stale non-existent-section doc-comment citation corrected.
4. `AC-AUDIT-03` (`actorType`/`actorId` on audit events) unimplemented — **RECORDED AS DEBT, not
   implemented**, `0dd8b06` (new progress note under `RISK-09`). Implementing a missing Phase 5
   acceptance criterion is new production functionality, not a test fix — out of scope for this
   branch; the owner's own decision on implement-vs-accept is still open.
5. Playlist routes: missing `try/catch` and raw `request.json()` — **FIXED**, `ea12442`. All four
   routes now use `parseVideoMetadataJsonBody` inside `try`; `GET /playlists` maps `DomainError`
   the same way its siblings do; 401/malformed-body/DomainError tests added.

**Category B (all three inventory-test regex gaps):** **FIXED**, `bc55776`. All three inventory
tests now use a shared 4-form import-detection pattern (static/side-effect/dynamic/`require`);
`gateway-inventory.test.ts`'s resource/verb list widened against the real `googleapis` types; its
hardcoded 3-file caller list replaced with a dynamic scan (which found a real, previously-unchecked
4th caller, confirmed already correct).

**Category C:**
- `sync-runner.test.ts` weak mutual-exclusion assertion — **FIXED**, `e0f772c` (ordered-events
  pattern, plus the missing reverse-direction test the title already claimed to cover).
- `cloud-connection` vacuous decrypt/plaintext-leak tests — **FIXED**, `1589b74`.
- `analytics/services.test.ts` credential-failure tests missing `.code` — **FIXED**, `faf53e2`.
- `pickWritableSnippetFields`/`pickWritableStatusFields` missing negative tests — **FIXED**,
  `1b21f76`.
- `computeBackoffDelayMs` zero coverage — **FIXED**, `1b21f76` (new `contracts.test.ts`, bounds
  independently derived from §0.E's formula, plus a genuine-randomization check).
- `AC-BACKUP-01` only demonstrated on the dry-run path — **FIXED**, `3cfd3ea`. New test proves the
  order against a real (mocked) `WriteExecutor`, not dry-run.
- `::ffff:` unwrap branch untested + NAT64 (`64:ff9b::/96`) gap — **FIXED**, `51a6798`. This was a
  real, exploitable SSRF gap (a literal URL like `https://[64:ff9b::169.254.169.254]/` passed
  validation entirely) — closed with a shared `unwrapEmbeddedIpv4` helper and 5 new tests; also
  fixed an unrelated false-positive the same gap analysis surfaced (a public `::ffff:` literal was
  incorrectly blocked). `docs/TECHNICAL_DEBT.md` RISK-14 updated.
- **Two additional real findings surfaced while addressing the above, not in the original report:**
  (a) `discardLocalAndAdoptPeer`'s SQL-projection cleanup deleted a discarded change set's row
  BEFORE its own child change rows, silently violating a live FK constraint
  (`foreign_keys=ON`) and leaving the change-set row permanently orphaned — every existing test used
  an in-memory fake with no FK enforcement, so none could catch it. **FIXED**, `2f5ca8c`
  (`RISK-46` updated), with a real-`SqlProjectionAdapter` regression test verified to fail against
  the old order and pass against the new one. (b) The 2026-09-25 analytics freshness-gate fix
  (`genuineRunCoversExpectedDate`) had a test for its date-range clause but zero coverage for its
  total-failure clause (a run covering yesterday but with `upsertsIssued: 0`) — **FIXED**, `4d3f5b7`.

**Category D:**
- `withTempDir` duplication (9 files) — **FIXED**, `d2cd500`.
- `cli-auth/services.test.ts` db-stub duplication — **FIXED**, `461fb51`.
- `src/mcp/server.test.ts`/`src/cli/video-metadata.test.ts` shared-fixtures consolidation (>10,000
  combined lines, two byte-identical helper functions) — **NOT DONE, deferred**. Flagged by the
  original report as the biggest win but also the biggest risk/effort; doing it inside a branch that
  already carries a real security fix (SSRF/NAT64) and a real data-integrity fix (RISK-46 FK
  ordering) would mix high-churn, low-risk refactoring with changes that need careful, focused
  review. Recommend its own dedicated `feature/*` branch and task.
- `playlist-management/services.test.ts` fixture reuse (used by 1 of 12 tests), `analytics/
  services.test.ts` table-driving (~9/~5/~3 near-identical groups), `src/proxy.test.ts` table-driving
  (4 near-identical tests), `cli/video-metadata.recovery-gate.test.ts`'s repeated fake-auth object,
  `ai-connections/crypto.test.ts`'s one redundant case — **NOT DONE, deferred** for the same reason:
  genuine, low-risk wins, but additive scope beyond what this branch's fixes required. Recommend a
  follow-up `proposed` backlog item (`roadmap-backlog` skill) if the owner wants them picked up.

**Minor documentation drift (all three):** **FIXED**, `3743155`. `SYSTEM_MAP.md` §2.9s/§2.9t merge
headers corrected (both features had actually merged to `dev` by the time this branch started); the
`error-classification.ts` doc comment corrected to describe the fixture's current (real-shaped,
`Object.defineProperty`-based) form instead of the superseded plain-object one.
`DEVELOPMENT_PLAYBOOK.md` §6.5's identity-verification row needed no separate edit — Category A
finding 1's fix made its claim actually true.

**Verified clean on this branch's tip** (independent review, 2026-09-26 — individual commits along
the way ran a mix of targeted and full validation, not uniformly the full set every time; see each
commit's own message for exactly what it ran): `npx tsc --noEmit`, `npm run lint`,
`npm run build`, `git diff --check` all clean; `npm test` grew from the `dev` baseline of 1487 to
1525, with zero pre-existing test weakened or deleted to make a change pass.
