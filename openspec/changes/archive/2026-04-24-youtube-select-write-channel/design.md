# Design: YouTube Select Write Channel

## Technical Approach

Keep `activeWriteChannel` as the OAuth-resolved truth for writes, and keep `selectedChannelId` as the persisted default expectation. Extend `write-context` to publish a derived selection state consumed by CLI/MCP, while preserving the existing fail-closed guardrail for writes.

## Architecture Decisions

| Decision | Options | Choice | Rationale |
|---|---|---|---|
| State model | Collapse into one field / keep active+selected separate | Keep both plus derived `alignment` | Avoids the false promise that persisted selection can switch OAuth identity. |
| Select behavior | Persist only on match / persist any known id | Persist requested `channelId` and return post-save state | Lets users preselect the intended channel before reauth, while `requiresReauth` stays explicit. |
| Known channels | Remote multi-channel listing / local derived list | Local derived list from `activeWriteChannel` + stored selection | Matches current API limits (`channels.list(mine:true)` only resolves one active channel) and avoids misleading “full catalog” claims. |

## Data Flow

```text
auth select-channel/list-channels OR MCP tool
  -> cli-auth service
    -> write-context service
      -> DB selected_channel_id
      -> YouTube adapter getActiveChannel(mine:true)
      -> derive alignment + knownChannels + requiresReauth
```

Alignment rules:
- `matched`: `selectedChannelId` and `activeWriteChannel.id` both exist and match.
- `mismatch`: both exist and differ.
- `unresolved`: one side is missing.

`requiresReauth = true` when status is `mismatch`, or when status is `unresolved` and a persisted selection exists without a resolvable active channel.

## File Changes

| File | Action | Description |
|---|---|---|
| `openspec/changes/youtube-select-write-channel/design.md` | Create | Technical design artifact. |
| `src/lib/write-context/contracts.ts` | Modify | Add `WriteChannelAlignment`, `KnownWriteChannel`, and enriched `WriteChannelContext`. |
| `src/lib/write-context/service.ts` | Modify | Centralize `deriveWriteChannelState`, `setSelectedChannelId`, `listKnownChannels`, and enriched context generation. |
| `src/lib/cli-auth/service.ts` | Modify | Expose `whoami` with enriched `writeChannel`, plus `listKnownWriteChannels` and `selectWriteChannel`. |
| `src/cli/video-metadata.ts` | Modify | Add exact commands `auth list-channels` and `auth select-channel --channelId <ID>`. |
| `src/mcp/server.ts` | Modify | Keep `write_context`, add `write_channel_list` and `write_channel_select`. |
| `src/lib/db.ts` | Modify | Reuse `setSelectedChannelId/getSelectedChannelId`; no migration. |
| `README.md` | Modify | Minimal docs for mismatch vs reauth and the new CLI/MCP surfaces. |
| `src/lib/write-context/service.test.ts` | Modify | Cover derived alignment, known channels, and select persistence. |
| `src/lib/cli-auth/service.test.ts` | Modify | Cover enriched `whoami`, select/list behavior, and `requiresReauth`. |
| `src/cli/video-metadata.test.ts` | Modify | Cover new auth commands and stable JSON envelopes. |
| `src/mcp/server.test.ts` | Modify | Cover new tools and structured contracts. |

## Interfaces / Contracts

```ts
type WriteChannelAlignment = {
  status: "matched" | "mismatch" | "unresolved";
  requiresReauth: boolean;
  message: string;
};

type KnownWriteChannel = {
  id: string;
  title: string | null;
  source: "active" | "selected";
  isActive: boolean;
  isSelected: boolean;
};

type WriteChannelContext = {
  activeWriteChannel: WriteChannelInfo | null;
  selectedChannelId: string | null;
  expectedChannelId: string | null;
  source: WriteChannelSource;
  knownChannels: KnownWriteChannel[];
  alignment: WriteChannelAlignment;
};
```

CLI commands:
- `npm run cli:video-metadata -- auth list-channels`
- `npm run cli:video-metadata -- auth select-channel --channelId <CHANNEL_ID>`

MCP tools:
- `write_channel_list` input `{}`
- `write_channel_select` input `{ channelId: z.string().min(1), credentialRef?: credentialSchema }`
- `write_context` remains, but returns the enriched contract above.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | Alignment matrix and known-channel dedupe/order | `node:test` on `write-context/service.test.ts` |
| Integration | CLI auth service returns stable state after select/list | `node:test` with stubs in `cli-auth/service.test.ts` |
| Integration | CLI/MCP command/tool envelopes and validation | Extend `video-metadata.test.ts` and `mcp/server.test.ts` |

## Migration / Rollout

No migration required. Reuse `users.selected_channel_id` and keep current write guardrails unchanged.

## Open Questions

- [ ] Final message copy for `alignment.message` / reauth guidance can still be tuned during implementation.
