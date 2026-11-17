> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 7. Persistence (Phase 2/3)

### 7.1 Schema (additive to the pre-existing baseline tables)

```text
users     (unchanged)   — id, email, name, image, accessToken, refreshToken, tokenExpiry, oauthScope, selectedChannelId
rules     (unchanged)   — auto-playlisting match rules, unrelated to sync

channels  (new)         — id (channelId, PK), title, thumbnailUrl, uploadsPlaylistId,
                           connectedUserId, connectedAt, lastSyncedAt
videos    (new)         — id (videoId, PK), channelId (FK → channels.id), title, description,
                           publishedAt, privacyStatus, defaultLanguage, defaultAudioLanguage,
                           thumbnailsJson, localizationsJson, etag, lastSyncedAt
                           + index on channelId
```

`thumbnails` and `existingLocalizations` are stored as JSON text columns (`thumbnailsJson`/`localizationsJson`), parsed/serialized at the persistence boundary in `src/lib/db.ts` (`mapStoredVideo`/`upsertVideos`). This mirrors the existing codebase's preference for plain SQLite columns over a JSON-mode ORM feature, and keeps the schema readable directly in a SQLite browser.

`channels.id` is the canonical YouTube `channelId` (never a title) and is the primary key — a channel is a single global entity; `connectedUserId` records which local OAuth user last connected/synced it, for traceability only, not an ownership boundary (`docs/PROJECT_SPEC.md` §37 sets the local-first/desktop deployment target this reflects, though it does not itself use the phrase "single operator" — a citation this document previously stated more strongly than the source; the actual read-scoping enforcement is `selectedChannelId`/`docs/decisions/0004-active-channel-read-scoping.md`, not `connectedUserId`).

### 7.2 Migration strategy decision (documented per this phase's explicit requirement)

**Decision: keep the existing boot-time idempotent schema pattern (`CREATE TABLE IF NOT EXISTS` / try-catch `ALTER TABLE ADD COLUMN` inside `initializeDatabase()` in `src/lib/db.ts`) for Phase 2. Do not introduce Drizzle Kit migrations yet.**

Reasoning:

1. **The Phase 2 schema change is purely additive** — two brand-new tables (`channels`, `videos`), zero changes to existing table shapes, zero data migrations, zero destructive operations. The existing pattern already handles this exact case correctly (it was used to add `selected_channel_id` and `oauth_scope` to `users` previously) and was re-verified working in this phase (`channels`/`videos` tables confirmed created on boot against a real SQLite file).
2. **`AGENTS.md`/`docs/PROJECT_SPEC.md` both require avoiding broad rewrites and explaining *why* before changing database architecture** (§3, Rule 5). Switching to Drizzle Kit migrations now — while `drizzle-kit` is an installed-but-unused devDependency — would be exactly the kind of architectural change the spec asks to justify in writing before doing, and there is no concrete need yet: no destructive schema change, no multi-environment migration ordering problem, no team-coordination requirement (single local SQLite file per operator).
3. **This is not a permanent decision.** The project's original architecture review already flagged that the idempotent-ALTER pattern will become error-prone as more tables accumulate. Phase 4 added two more tables (`change_sets`, `changes`, §6.10) purely additively, confirming the decision still holds; `batches`/`audit`/`backups` remain future additions per the roadmap. The threshold for revisiting this is unchanged: **the first schema change that is not purely additive** (a column type change, a `NOT NULL` backfill, a data transformation, or a multi-step migration ordering requirement) — at that point, introduce Drizzle Kit migrations via a dedicated ADR (`docs/decisions/00X-database-migrations.md`, per `docs/PROJECT_SPEC.md` §45), not silently.

### 7.3 Persistence access (`src/lib/db.ts`)

New exported functions, following the existing file's flat function-per-operation style (not a repository class):

```text
upsertChannel(...)             — insert or update-on-conflict a channel row
markChannelSynced(id, at)      — update lastSyncedAt only
listStoredChannels()           — all connected/synced channels
getStoredChannel(id)           — single channel lookup
upsertVideos(entries, at)      — insert or update-on-conflict each video row
listStoredVideosByChannel(id)  — all videos for a channel, newest first
```

`src/lib/channel-sync/adapters/store.ts` wraps these as the `channelStore` dependency injected into `services.ts`, exactly mirroring how `write-context`'s `channelSelectionStore` wraps `getSelectedChannelId`/`setSelectedChannelId`.

---

