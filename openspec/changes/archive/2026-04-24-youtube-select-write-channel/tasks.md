# Tasks: YouTube Select Write Channel

## Phase 1: Foundation (contracts + state derivation)

- [x] 1.1 Update `src/lib/write-context/contracts.ts` with `WriteChannelAlignment`, `KnownWriteChannel`, and enriched `WriteChannelContext` (`knownChannels`, `alignment`, `requiresReauth`, stable message fields).
- [x] 1.2 Implement shared derivation in `src/lib/write-context/service.ts`: `matched|mismatch|unresolved`, `requiresReauth` rules, and `recommendedAction` for mismatch/unresolved.
- [x] 1.3 Add minimal-safe known channel listing in `src/lib/write-context/service.ts` by combining `activeWriteChannel` + `selectedChannelId` (dedupe, `source: "active"|"selected"`, no remote catalog claim).
- [x] 1.4 Implement select flow in `src/lib/write-context/service.ts` to persist requested `selectedChannelId` and return post-save alignment without implying OAuth switch.

## Phase 2: Core Implementation (auth service + validation)

- [x] 2.1 Extend `src/lib/cli-auth/service.ts` `write_channel_whoami` output to include enriched `writeChannel` contract (`activeWriteChannel`, `selectedChannelId`, `alignment`, effective credential ref).
- [x] 2.2 Add `listKnownWriteChannels` in `src/lib/cli-auth/service.ts` backed by write-context list derivation (inspector/list mínimo seguro).
- [x] 2.3 Add `selectWriteChannel` in `src/lib/cli-auth/service.ts` with strict boundary validation for `channelId` and structured validation errors.
- [x] 2.4 Ensure guardrail-facing errors from `src/lib/write-context/service.ts` preserve actionable diagnostics (`requiresReauth`, ids, `recommendedAction`) for mismatch/unresolved.

## Phase 3: Integration Surfaces (CLI + MCP parity)

- [x] 3.1 Update `src/cli/video-metadata.ts` to expose `auth list-channels` and `auth select-channel --channelId <ID>` with stable JSON envelopes.
- [x] 3.2 Keep CLI inspection output wired to enriched whoami contract in `src/cli/video-metadata.ts` (clear selected vs active distinction).
- [x] 3.3 Update `src/mcp/server.ts` to keep `write_context` and add `write_channel_list` + `write_channel_select` tools with strict zod input validation.
- [x] 3.4 Enforce parity of contract fields/messages between CLI and MCP in `src/mcp/server.ts` and `src/lib/cli-auth/service.ts`.

## Phase 4: Testing & Verification

- [x] 4.1 Expand `src/lib/write-context/service.test.ts` for alignment matrix scenarios: matched, mismatch (fail-closed), unresolved, and `requiresReauth` behavior.
- [x] 4.2 Add `src/lib/write-context/service.test.ts` cases for known-channel list mínimo seguro (active+selected merge, source tagging, dedupe, no full-catalog semantics).
- [x] 4.3 Extend `src/lib/cli-auth/service.test.ts` for enriched whoami, list-channels output, select with mismatch persistence, and invalid `channelId` validation failure.
- [x] 4.4 Extend `src/cli/video-metadata.test.ts` for `auth list-channels` and `auth select-channel` command envelopes and mismatch guidance messaging.
- [x] 4.5 Extend `src/mcp/server.test.ts` for `write_context` enriched contract, `write_channel_list`, and invalid `write_channel_select` payload rejection without persistence.

## Phase 5: Documentation

- [x] 5.1 Update `README.md` with the explicit model: `selectedChannelId` is expected default, `activeWriteChannel` is OAuth truth, and mismatch requires reauth.
- [x] 5.2 Document new CLI/MCP surfaces in `README.md` (`auth list-channels`, `auth select-channel`, `write_channel_list`, `write_channel_select`) and list mínimo seguro limitations.
