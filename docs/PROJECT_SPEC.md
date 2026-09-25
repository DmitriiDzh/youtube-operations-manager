# PROJECT_SPEC.md
# YouTube Operations Manager

## 0. Purpose of this document

This document is the implementation specification for the **YouTube Operations Manager**, a private/internal tool for managing multiple YouTube channels.

Reference repositories (for ideas only, not architecture to copy wholesale):

- YouTube Video Metadata Translator: https://github.com/jordicor/YouTube-Video-Metadata-Translator
- youtube-metadata-agent: https://github.com/FairchildHeavyIndustries/youtube-metadata-agent

The goal is to:

1. preserve working authentication, YouTube integration, Web UI, CLI, MCP, and API contracts where practical;
2. extend the project incrementally;
3. add localization, XLSX import/export, backup/diff/approval, and later analytics/publishing/AI workflows;
4. keep the system suitable for both a human operator and future AI agents.

This is an internal operations tool, not a public SaaS product.

---

# 1. Product Vision

The long-term product should become a central operational layer between YouTube and human/AI operators.

Target architecture:

```text
Human Operator
      │
      ├──────── Web UI
      │
AI Agent / Claude / Codex
      │
      ├──────── MCP / Internal API
      │
      ▼
YouTube Operations Manager
      │
      ├── Channel management
      ├── Video metadata
      ├── Localizations
      ├── Import / Export
      ├── Approval workflows
      ├── Analytics
      ├── Publishing
      ├── Thumbnails
      ├── Playlists
      └── Automation
      │
      ▼
Official YouTube APIs
```

The application should hide OAuth, API pagination, quota handling, request payload construction, retry behavior, and other low-level API mechanics from the user.

The user should work through clear actions such as:

```text
Connect Channel
Sync Videos
Export Metadata
Import Localizations
Review Changes
Approve
Push to YouTube
Verify
```

---

# 3. No Parallel Implementations Rule

Before changing any subsystem, determine whether an existing one already solves the problem.

Default rule:

> Prefer extending existing working behavior over rewriting it.

Do not:

- rewrite authentication without evidence that it is necessary;
- replace the MCP layer with a custom agent protocol;
- rebuild working playlist operations;
- create a second YouTube client abstraction in parallel;
- create duplicated metadata logic;
- replace the frontend framework just because another framework is preferred.

Large architectural migrations require a written decision document explaining:

1. current limitation;
2. proposed replacement;
3. migration cost;
4. compatibility impact;
5. why extension is not sufficient.

---

# 4. Reference Repositories and What to Learn From Them

## 4.2 YouTube Video Metadata Translator

Repository:

https://github.com/jordicor/YouTube-Video-Metadata-Translator

Do **not** use this repository as the main architecture.

Use it as a reference for the localization workflow.

Useful concepts to study:

- selecting multiple videos;
- selecting multiple target languages;
- retrieving existing localizations;
- skipping or overwriting existing localizations;
- batch processing;
- progress reporting;
- localization verification;
- error handling for large batches.

Do not blindly copy code.

Understand the behavior and reimplement it within this project's own architecture.

---

## 4.3 youtube-metadata-agent

Repository:

https://github.com/FairchildHeavyIndustries/youtube-metadata-agent

Use this repository as a reference for safe automation architecture.

Important concepts to adopt:

```text
Fetch
↓
Immutable Backup
↓
Audit
↓
Proposed Changes
↓
Diff
↓
Human Approval
↓
Dry Run
↓
Push
↓
Per-item Ledger
↓
Verification
```

Particularly valuable patterns:

- immutable backups before write operations;
- proposed state separated from remote state;
- explicit human approval;
- dry-run by default;
- idempotent execution;
- per-video success ledger;
- per-video error ledger;
- workflows that can safely resume after interruption;
- AI-generated metadata never writing directly to YouTube;
- configuration that keeps channel-specific instructions separate from application code.

---

# 5. Primary Initial Use Case

The first production-quality feature is a **Localization Manager**.

The operator must be able to:

1. connect one or more YouTube channels;
2. synchronize all existing videos;
3. view original title and description;
4. view existing localized titles and descriptions;
5. export metadata to XLSX;
6. edit or generate translations externally;
7. import XLSX;
8. validate imported data;
9. preview exact changes;
10. selectively approve changes;
11. push changes to YouTube in bulk;
12. verify the remote result;
13. see failures without aborting the entire batch;
14. inspect a complete audit trail.

The system must work for hundreds of videos.

---

# 6. Example Managed Channels

Initial real-world examples include:

```text
Tropico Jazz
Rural Japan Music
```

Never hard-code these names.

The architecture must support arbitrary channels.

---

# 7. Project Scope — Milestone Sequence

Development must be incremental.

Do not attempt to implement all future features in one pass.

Phase 0 (initial architecture analysis) and Phase 1 (independent baseline verification) are complete — see `docs/ROADMAP_STATUS.md` for the record of what was done and when.

---

# 8. Channel and Account Model

The extended application must support multiple connected YouTube accounts/channels.

Minimum requirements:

```text
Connected account
Channel ID
Channel title
Channel thumbnail
Authorization reference
Connection date
Last successful sync
```

The active channel must always be clearly visible in the UI.

Every write operation must verify that the currently authorized YouTube identity has access to the intended channel.

The `expectedChannelId` channel-identity guardrail must be preserved and generalized across every write operation.

Never allow a background or bulk operation to silently switch channel context.

---

# 9. Video Synchronization

Add a reliable full-channel video synchronization workflow.

Preferred YouTube enumeration strategy:

- discover uploads playlist;
- enumerate upload playlist items;
- retrieve video resources in efficient batches.

Do not depend on YouTube Search API for full channel enumeration if a better uploads-playlist method is available.

Store/cache enough local data to avoid unnecessary API requests.

Minimum video fields:

```text
youtubeVideoId
channelId
title
description
publishedAt
privacyStatus
defaultLanguage
defaultAudioLanguage
thumbnails
existingLocalizations
lastSyncedAt
etag when useful
```

Synchronization must support channels with hundreds or thousands of videos.

---

# 10. Remote State vs Draft State

Never treat edited local values as if they are already live on YouTube.

Maintain conceptual separation between:

```text
REMOTE
DRAFT / PROPOSED
APPLIED / VERIFIED
```

For localizations, the system should know:

```text
remoteTitle
remoteDescription

draftTitle
draftDescription

status
```

A sync operation must not silently destroy an unapproved draft.

If remote data changed since the draft was created, flag a conflict.

---

# 11. Localization Manager — UI

Add a first-class section:

```text
Localizations
```

Suggested primary layout:

```text
Channel: [Tropico Jazz ▼]

Search [________________]

Languages:
[English] [Spanish] [Portuguese (Brazil)] [German] [French]

Filters:
[All]
[Missing]
[Draft]
[Changed]
[Ready]
[Error]

---------------------------------------------------------------

☐ Thumbnail | Video | EN | ES | PT-BR | DE | FR | Status

☐            Video A   ✓    ✓      —     ✓    —    Missing 2
☐            Video B   ✓    ✓      ✓     ✓    ✓    Complete
```

Clicking a video should open localization details.

---

# 12. Localization Detail

For a selected video show:

```text
Original / Default Metadata

Title
Description
Default language

--------------------------------

Spanish

Remote title
Draft title

Remote description
Draft description

Status
Last synced
```

Use a clear visual diff when draft differs from remote.

Editing in the UI must modify the local draft only.

Do not auto-save directly to YouTube.

---

# 13. Localization Language Handling

Use YouTube-compatible localization language codes.

Examples:

```text
en
es
de
fr
ja
pt-BR
```

Verify actual API behavior against current official documentation.

Centralize language handling.

Create a mapping such as:

```text
code → display name
```

Do not scatter language-code logic throughout UI components.

Allow arbitrary supported languages rather than hard-coding only five.

---

# 14. Default Language Handling

YouTube localization updates may require default metadata language to be configured.

If the target video lacks a default language:

- flag the video;
- do not silently guess;
- allow a user-approved batch operation to set it.

Example:

```text
23 selected videos have no default metadata language.

Set default language:
[English (en) ▼]

[Preview Changes]
```

Changing default language is a YouTube write operation and must follow the same approval/audit rules.

---

# 15. XLSX Export

Add export functionality.

Primary format:

```text
.xlsx
```

CSV may be supported as a secondary format.

Preferred workbook structure:

## Sheet: Videos

Columns:

```text
channel_id
channel_name
video_id
youtube_url
published_at
default_language
original_title
original_description
```

## Sheet: Localizations

Columns:

```text
video_id
language
title
description
remote_title
remote_description
status
```

Alternative structures are acceptable only if they materially improve usability.

Important:

`video_id` is the canonical identifier.

Never rely on video title as an identifier.

XLSX formatting:

- bold header;
- freeze top row;
- filters;
- sensible widths;
- wrapped descriptions;
- no excessive visual styling.

Export should support:

```text
selected videos
all filtered videos
entire channel
```

---

# 16. XLSX Import

Import must be safe.

Workflow:

```text
Upload XLSX
↓
Parse
↓
Validate
↓
Match video IDs
↓
Compare with current remote/local state
↓
Create change set
↓
Show preview
```

Required validation:

- workbook structure;
- required columns;
- valid video IDs;
- videos belong to selected channel;
- valid language codes;
- duplicate rows;
- title length constraints;
- description constraints;
- unsupported values.

Blank spreadsheet cells must **not** mean deletion by default.

Default behavior:

```text
blank cell = NO CHANGE
```

Deletion must be an explicit operation.

**Updated 2026-09-20 (explicit project-owner decision, reversing this section's original
no-deletion-feature-at-all default once any deletion feature is actually built):** this
application may build a real, explicit deletion capability (e.g. removing a video's localization
from YouTube), but only under a permanent, application-wide constraint that applies to **every**
deletion feature this application ever builds, not only the one that prompted this update:

- No deletion may ever be permanent or immediate, no matter how many confirmation steps precede
  it. A deletion action always requires **multiple, explicit confirmation steps** before it
  executes.
- Even after confirmation and execution, the deleted value must remain **locally recoverable for
  a configurable retention window** (default 30 days) so the operator can restore it without harm.
- "Restore" means re-applying the previously-deleted value as a new write, through the exact same
  safety model as any other write (identity check, dry-run capability, audit, verification) — it
  is never a bare, unaudited local undo.
- The retention window governs what the operator is *offered* as restorable; it does not by
  itself require deleting the underlying local backup once the window closes (see
  `docs/TECHNICAL_DEBT.md` for the current status of backup retention/cleanup, tracked
  separately as its own decision).

---

# 17. Change Set Model

Every import or AI generation task should produce a reusable change set.

Conceptually:

```text
ChangeSet
- id
- channelId
- source
- createdAt
- status
- changes[]
```

Possible source values:

```text
XLSX_IMPORT
MANUAL_EDIT
AI_GENERATION
API
MCP_AGENT
```

Each field-level or localization-level change should record:

```text
videoId
language
field
before
after
validationStatus
approvalStatus
applyStatus
error
```

This model becomes the common foundation for all future automation.

---

# 18. Diff / Approval UI

Before any YouTube write, show a human-readable diff.

Example:

```text
Video: abc123
Language: Spanish

TITLE

Current:
Jazz Cubano para Relajarse

Proposed:
Jazz Cubano Relajante | Música Tropical para Trabajar

DESCRIPTION

Current:
...

Proposed:
...
```

Classify changes:

```text
ADD
MODIFY
REMOVE
UNCHANGED
INVALID
CONFLICT
```

Allow:

- approve all valid;
- reject all;
- approve individual changes;
- exclude individual videos;
- filter by language;
- filter by change type.

---

# 19. Immutable Backup

Before the first write operation of a batch, capture the current remote state of every affected video.

Create a backup artifact.

Suggested storage:

```text
data/backups/<channelId>/<timestamp>/
```

Example:

```text
metadata_before.json
batch_manifest.json
```

A write operation should refuse to proceed if required backup creation fails.

Backups should not be overwritten.

The backup is the basis for:

- audit;
- troubleshooting;
- future rollback.

---

# 20. Dry Run Default

All new bulk write workflows must support dry-run.

Preferred safety behavior:

```text
dryRun = true
```

until the user explicitly confirms a live operation.

Dry run should perform:

- validation;
- identity check;
- remote state check;
- payload generation;
- quota estimation where feasible;
- diff generation;

but make no YouTube write requests.

MCP and CLI tools that can write should also expose dry-run semantics.

---

# 21. Safe Localization Update Logic

This is a critical requirement.

Do not blindly submit only one new localization if doing so could remove existing localization values.

Before constructing a YouTube update payload:

1. obtain current remote metadata if local state may be stale;
2. read all existing localizations;
3. merge approved changes into the complete localization object;
4. preserve localization entries not targeted by the operation;
5. preserve unrelated metadata required by the relevant YouTube `part`;
6. submit only after validation;
7. verify the result.

Create dedicated pure/testable logic similar to:

```text
mergeLocalizations(existing, approvedChanges)
```

and:

```text
buildSafeVideoUpdatePayload(remoteVideo, approvedChanges)
```

These functions need extensive tests.

**Field scope, permanent constraint (added 2026-09-21, explicit project-owner decision).** The
Change Set / localization mechanism (XLSX import, AI generation, tracked-language management, and
any localization-deletion capability built on it) has authority over exactly two fields:
`title` and `description`, per language. It must never read, write, or delete any other field —
not the video's own `defaultLanguage`/`defaultAudioLanguage`, not tags, category, privacy,
scheduling, or any other `snippet`/`status`/`recordingDetails` field (those belong to
`src/lib/video-details/`, a structurally separate module, per AGENTS.md §F), and not captions/
subtitles (a distinct YouTube API resource this application does not integrate with at all).
Extending this mechanism to cover any additional field is a separate product decision requiring
the project owner's own explicit authorization each time — never something a coding agent infers
is safe merely because the underlying YouTube API technically allows it, and never done by quietly
widening an existing type (e.g. `ChangeField`) without first updating this section to say so.

---

# 22. Idempotent Batch Execution

Adopt the best pattern from `youtube-metadata-agent`.

Each bulk operation needs a per-item execution ledger.

Conceptually:

```text
Batch ID
Video ID
Change ID
Attempt
Status
Timestamp
Remote confirmation
Error
```

Possible statuses:

```text
PENDING
SKIPPED
APPLYING
SUCCESS
FAILED
CONFLICT
```

Re-running an interrupted batch must:

- skip already confirmed successful items;
- retry eligible failed/transient items;
- not create duplicate effects.

---

# 23. Failure Isolation

A failure on one video must not abort the entire batch unless the failure indicates a systemic unsafe condition.

Example:

```text
Batch complete

Successful: 148
Skipped: 7
Failed: 3
Conflicts: 2
```

Allow export/download of the error report.

Systemic conditions that may justify aborting:

- wrong authenticated channel;
- credentials invalid globally;
- quota exhausted;
- malformed common payload logic;
- backup system unavailable.

---

# 24. Verification After Write

Do not mark a change as successful solely because the API request returned without transport error.

Verify the resulting state.

Possible strategies:

- use returned updated resource where sufficient;
- retrieve video resource after update;
- compare expected vs actual localizations.

Store:

```text
requested state
confirmed remote state
verification timestamp
```

---

# 25. Audit Log

Every write operation must be auditable.

Minimum fields:

```text
timestamp
account
channelId
videoId
batchId
actorType
actorId when available
operation
language
before
after
dryRun
result
error
```

Actor types may include:

```text
HUMAN
CLI
MCP_AGENT
SYSTEM
```

Future AI-generated changes should distinguish:

```text
generated by AI
approved by human
applied by system
```

---

# 26. Agent / MCP Safety

The MCP layer is strategically important.

Do not grant AI agents unrestricted direct write behavior.

MCP architecture should ultimately separate:

```text
READ TOOLS
PROPOSE TOOLS
APPROVE/APPLY TOOLS
```

Recommended model:

### Read

Agent can freely:

- list channels;
- list videos;
- retrieve metadata;
- retrieve analytics later;
- retrieve localizations.

### Propose

Agent can:

- create draft metadata;
- create localization drafts;
- create change sets;
- run validation;
- generate diff.

### Apply

Live YouTube writes require explicit authorization policy.

Initial policy:

```text
AI may propose.
Human approves.
System applies.
```

Later automation may allow specific trusted rules, but do not build unrestricted autonomous writes into MVP.

---

# 27. Channel Identity Guardrails

Every write path must validate channel identity.

This includes:

- Web UI;
- API;
- CLI;
- MCP.

If the active OAuth identity does not match or have access to the expected target channel:

```text
ABORT WRITE
```

Do not merely show a warning.

Generalize the `expectedChannelId` guardrail rather than removing it.

---

# 28. Quota Awareness

Centralize YouTube API operations so quota behavior can be reasoned about.

Requirements:

- avoid unnecessary reads;
- batch list calls where possible;
- avoid repeated full syncs automatically;
- do not repeatedly retry non-transient failures;
- recognize quota-exhausted errors;
- display understandable quota-related errors.

Later add a lightweight quota estimate for planned bulk operations if practical.

Do not hard-code quota costs without documentation and tests because API costs may change.

---

# 29. Retry Policy

Retry transient failures only.

Potentially retry:

```text
network timeout
temporary 5xx
temporary rate limit
```

Do not blindly retry:

```text
invalid metadata
invalid language
wrong channel
insufficient permissions
video not found
default language missing
quota exhausted
```

Use bounded exponential backoff where appropriate.

---

# 30. Conflict Detection

If a user exported metadata on Monday and imports edited data on Friday, YouTube may have changed in between.

Detect this.

Before apply:

- compare stored/exported baseline with current remote state where possible;
- identify changed remote values;
- mark as `CONFLICT`;
- require re-review.

Never silently overwrite newer remote changes.

---

# 31. Dashboard Evolution

Keep existing dashboard behavior functional.

Add an operational overview over time.

Suggested cards:

```text
Connected Channels
Total Videos
Pending Changes
Missing Localizations
Failed Operations
Last Sync
Last Write Batch
```

Do not prioritize dashboard cosmetics over core safety/workflow functionality.

---

# 32. Future AI Localization Module

Do not make AI translation mandatory for the localization MVP.

Design extension points for:

```text
LocalizationProvider
```

Possible future providers:

- OpenAI;
- Anthropic;
- DeepL;
- Google Translation;
- custom/local models.

AI-generated copy should not be treated as literal translation only.

Future workflow:

```text
Source metadata
↓
Channel localization brief
↓
AI generation
↓
Validation
↓
Draft
↓
Diff
↓
Human approval
↓
Apply
```

The channel may have language-specific SEO rules.

Example future config:

```text
channels/
  <channel-id>/
    localization/
      es.md
      pt-BR.md
      de.md
```

Keep channel-specific editorial instructions out of application source code.

---

# 33. Future YouTube Analytics Module

Later integrate the official YouTube Analytics API.

Potential metrics:

```text
views
watch time
average view duration
impressions
CTR where available
traffic sources
geography
subscribers
revenue where authorized
```

Data should be linked to canonical:

```text
channelId
videoId
date
```

This will later allow agents to make evidence-based recommendations.

Example:

```text
Analytics
↓
identify strong Spanish traffic
↓
create localization proposal
↓
human approval
↓
apply localized metadata
```

Do not implement analytics prematurely during localization MVP.

---

# 34. Future Publishing Module

Later add:

```text
upload video
upload thumbnail
title
description
tags
category
default language
localizations
playlist assignment
privacy status
scheduled publishing
```

Publishing must use the same:

```text
draft
preview
approval
apply
verify
audit
```

model as metadata updates.

---

# 35. Future Thumbnail Module

Potential future capabilities:

- show current YouTube thumbnail;
- upload replacement thumbnail;
- maintain thumbnail versions;
- associate generated artwork;
- approval workflow;
- A/B test metadata tracking if YouTube APIs expose appropriate supported functionality.

Do not invent YouTube API capabilities.

Verify every feature against current official API documentation before implementation.

---

# 36. Data Storage

Extend the existing persistence model rather than replacing it without a concrete need.

The system ultimately needs durable representation for at least:

```text
Accounts
Channels
Videos
Localizations
Drafts
ChangeSets
Batches
AuditEvents
Backups
```

Do not introduce enterprise infrastructure without a concrete need.

For a local-first internal application, a simple durable database is preferable.

---

# 37. Local-First Deployment

Initial target:

```text
Windows
macOS
```

The system should run locally and open in the browser.

Ideal end-state user experience:

```text
Start YouTube Operations Manager
↓
browser opens automatically
↓
http://localhost:<port>
```

The operator should not need to manually launch multiple terminals once packaging is mature.

Do not block core feature development on desktop packaging.

---

# 38. Secrets and OAuth Security

Never:

- commit OAuth client secrets;
- commit refresh/access tokens;
- expose refresh tokens to browser JavaScript;
- print secrets to logs;
- send Google credentials to an AI model;
- store Google account passwords.

OAuth/API calls should remain server-side.

Add secret redaction to logs.

Keep secret paths in `.gitignore`.

Document local credential storage behavior.

---

# 39. UI Design Direction

The product is an internal operations dashboard.

Design priorities:

```text
clarity
density
speed
status visibility
safe bulk operations
```

Visual reference:

```text
YouTube Studio
+
modern admin dashboard
+
developer operations tool
```

Avoid:

- marketing landing-page design;
- giant hero sections;
- excessive gradients;
- unnecessary animations;
- decorative dashboards with little operational value.

Use tables, filters, status badges, drawers/modals, diffs, and progress indicators.

---

# 40. Bulk Selection UX

Support:

```text
select one
select page
select all filtered
```

The UI must clearly distinguish:

```text
50 selected on this page
```

from:

```text
All 427 matching videos selected
```

Bulk actions should display the scope before execution.

---

# 41. Progress UX

Large operations need granular progress.

Example:

```text
Applying localization changes

78 / 150

Successful     74
Skipped         2
Failed          1
Conflict        1
```

Allow the user to inspect individual failures.

Do not freeze the UI until the entire operation completes.

---

# 42. Testing Requirements

Testing is mandatory.

Add tests for all new safety-critical logic.

## Unit tests

At minimum:

- language normalization;
- localization merge;
- payload construction;
- diff generation;
- blank-cell import semantics;
- deletion semantics;
- validation;
- conflict detection;
- idempotency decisions;
- retry classification.

## Integration tests

Mock YouTube APIs.

Test full flow:

```text
sync
↓
export
↓
import
↓
change set
↓
backup
↓
dry run
↓
apply
↓
verify
↓
audit
```

No automated tests may modify a production YouTube channel.

---

# 43. Demo / Mock Mode

Maintain or add a mode where the localization UI can be developed without real YouTube credentials.

Provide mock channels/videos/localizations.

Example scenarios:

- complete translations;
- missing translations;
- invalid draft;
- conflict;
- failed write;
- channel identity mismatch.

This significantly improves agent-driven development and UI testing.

---

# 44. Documentation Requirements

Maintain:

```text
README.md
PROJECT specification
docs/ARCHITECTURE.md
CHANGELOG.md
```

Add focused documentation for:

```text
OAuth
Localization workflow
XLSX schema
MCP tools
Safe write architecture
Backups
Recovery
```

A future coding agent should be able to understand the application without reconstructing architecture from source code alone.

---

# 45. Architecture Decision Records

For significant changes create concise ADR-style documents.

Example:

```text
docs/decisions/001-localization-storage.md
docs/decisions/002-batch-execution-model.md
```

Use this for decisions such as:

- replacing a core subsystem;
- database migration;
- changing authentication;
- changing MCP contracts;
- major framework migration.

Do not create ADRs for trivial implementation details.

---

# 46. Avoid Unnecessary Churn

Guidelines:

- isolate new modules;
- avoid arbitrary formatting of untouched files;
- avoid mass renames without reason;
- do not restructure the whole repository merely for preference;
- preserve existing interface contracts unless change is necessary;
- document intentional breaking changes.

Do not block a justified project-specific refactor merely to minimize diff size.

---

# 47. Suggested New Domain Modules

Conceptually introduce modules such as:

```text
localization/
  service
  validation
  merge
  diff
  import
  export

changesets/
  service
  storage
  approval

batches/
  executor
  ledger
  retry

audit/
  service

backup/
  service
```

Do not force these exact paths if they conflict with this project's own established module conventions (see `docs/DEVELOPMENT_PLAYBOOK.md`).

---

# 48. Suggested API Capabilities

Extend existing API routes rather than creating an unrelated parallel API.

Conceptual routes:

```text
GET  channels
POST channel sync

GET  videos
GET  video detail

GET  localizations

POST localization export
POST localization import

GET  changeset
POST changeset validate
POST changeset approve
POST changeset dry-run
POST changeset apply

GET  batch
GET  audit
```

Use the project's existing API conventions.

---

# 49. Suggested MCP Capabilities

Do not expose all write functionality immediately.

Initial localization-related MCP tools may include:

```text
localization_list
localization_missing
localization_export
localization_propose
changeset_get
changeset_validate
```

Later:

```text
changeset_apply
```

should require an explicit approval mechanism or trusted policy.

MCP tool results should use stable machine-readable schemas.

Avoid returning only prose.

---

# 50. Logging

Use structured logs.

Useful fields:

```text
requestId
batchId
channelId
videoId
operation
duration
result
```

Never log:

```text
accessToken
refreshToken
clientSecret
authorizationCode
```

---

# 51. Backup and Recovery UX

Eventually expose backups in UI.

Example:

```text
Backups

2026-09-15  Localization batch #42
152 videos
Spanish + Portuguese
[View]
[Export JSON]
```

Full automated rollback is optional for the first milestone.

However the data required to manually or programmatically restore previous metadata must exist.

---

# 52. Performance Expectations

The system must be practical for:

```text
hundreds of videos per channel
multiple connected channels
multiple localization languages
```

Avoid:

- one API call per visible table cell;
- fetching the full channel on every page load;
- loading all long descriptions into expensive UI components unnecessarily;
- synchronous all-at-once write loops that make the application unresponsive.

Use caching/persistence and controlled background execution where appropriate inside the running application.

Do not invent cloud infrastructure for this.

---

# 53. First Real Acceptance Test

The first major feature is complete only when the following workflow works against a real test/production channel:

1. Launch the independent YouTube Operations Manager repository.
2. Authenticate.
3. Select the correct channel.
4. Sync all videos.
5. Open Localization Manager.
6. See existing English/default metadata.
7. See all existing localizations.
8. Export selected/all videos to XLSX.
9. Add Spanish title/description values in XLSX.
10. Import the XLSX.
11. System validates the file.
12. System shows exact diff.
13. System identifies missing default language if applicable.
14. System creates immutable backup.
15. User runs dry-run.
16. User explicitly approves live update.
17. System validates expected channel identity.
18. System updates all selected videos safely.
19. Existing unrelated localizations remain intact.
20. System verifies YouTube remote state.
21. UI displays success/failure summary.
22. Audit history contains every write.
23. Re-running the same batch causes no duplicate/unnecessary updates.

If this is not reliable, do not proceed to AI automation.

---

# 54. Second Acceptance Test — Interrupted Batch

Test an intentionally interrupted bulk operation.

Scenario:

```text
100 videos selected
operation stops after 43 successful writes
```

On restart:

- the batch is recoverable;
- 43 confirmed successes are not re-applied unnecessarily;
- remaining videos continue;
- failures are preserved;
- audit remains coherent.

This is mandatory before calling bulk operations production-ready.

---

# 55. Third Acceptance Test — Wrong Channel

Connect/authenticate with a different channel than expected.

Attempt a write batch.

Expected behavior:

```text
WRITE IS BLOCKED
```

The system must clearly explain:

- authenticated channel;
- expected channel;
- operation aborted.

No metadata changes should be sent.

---

# 56. Fourth Acceptance Test — Conflict

1. Sync video.
2. Create draft.
3. Change the same remote metadata outside the application in YouTube Studio.
4. Attempt apply.

Expected:

```text
CONFLICT
```

Do not silently overwrite.

---

# 57. Fifth Acceptance Test — Existing Localizations

Video contains:

```text
Spanish
German
French
```

Import only a new Portuguese localization.

After update:

```text
Spanish preserved
German preserved
French preserved
Portuguese added
```

This must have automated test coverage.

---

# 58. Non-Goals for Localization MVP

Do not implement yet:

- YouTube Analytics;
- autonomous metadata optimization;
- automatic video publishing;
- video upload;
- thumbnail generation;
- image generation;
- music generation;
- rendering;
- livestream management;
- multi-user SaaS accounts;
- billing;
- cloud deployment;
- complex role-based access control.

Build the operational foundation correctly first.

---

# 59. Coding-Agent Working Rules

The coding agent must follow these rules.

## Rule 1

Read the entire repository and this specification before large changes.

## Rule 2

Do not implement the entire roadmap in one pass.

## Rule 4

Preserve working functionality unless there is a documented reason to change it.

## Rule 5

Before modifying authentication, MCP, API contracts, or database architecture, explain why.

## Rule 6

Verify YouTube API behavior against current official Google documentation.

Do not rely on assumptions.

## Rule 7

Use official YouTube APIs only.

Do not automate YouTube Studio through browser scraping for features available through official APIs.

## Rule 8

All write operations require:

```text
identity check
validation
backup
diff
approval
dry-run capability
audit
verification
```

## Rule 9

AI-generated metadata is always a draft.

## Rule 10

Never allow an LLM to directly receive or handle OAuth secrets.

## Rule 11

Never identify videos by title.

Use YouTube video ID.

## Rule 12

Never interpret blank spreadsheet cells as deletion unless explicitly configured.

## Rule 13

Never overwrite unrelated existing localizations.

## Rule 14

Use controlled concurrency.

## Rule 15

A single item failure should normally not terminate the batch.

## Rule 16

Write tests before considering safety-critical logic finished.

## Rule 17

Update documentation as architecture changes.

## Rule 18

Keep the repository easy for future Codex/Claude agents to understand.

---

# 60. Initial Agent Assignment

Complete — Phase 0/1 architecture analysis and baseline verification; see `docs/ROADMAP_STATUS.md`.

---

# 61. Second Agent Assignment

After the baseline is confirmed:

```text
Implement Phase 2: reliable channel/video synchronization and local persistence needed
for future localization management.

Requirements:

- preserve existing interfaces;
- use the channel uploads playlist for full enumeration where appropriate;
- retrieve video metadata and existing localizations;
- add clear channel identity context;
- avoid unnecessary API calls;
- support hundreds of videos;
- do not implement YouTube writes for localization yet;
- add mock data and tests;
- update ARCHITECTURE.md.

Definition of done:
the Web UI can select a connected channel, sync it, and display every video plus its
existing localization languages reliably.
```

---

# 62. Third Agent Assignment

Then:

```text
Implement the Localization Manager read-only UI and XLSX export.

Do not implement live localization writes yet.

Requirements:

- localization table;
- filtering;
- missing-language status;
- video detail;
- remote metadata display;
- XLSX export;
- normalized Videos + Localizations workbook;
- canonical video_id matching;
- tests;
- documentation.
```

---

# 63. Fourth Agent Assignment

Then:

```text
Implement XLSX import, validation, draft state, change sets and diff UI.

Still do not perform live YouTube localization writes.

Requirements:

- parse XLSX;
- validate;
- blank = no change;
- detect duplicates;
- detect invalid language codes;
- compare remote vs proposed;
- store change set;
- show human-readable diff;
- allow approve/reject;
- detect conflicts where feasible;
- tests.
```

---

# 64. Fifth Agent Assignment

Only after all previous phases are stable:

```text
Implement safe localization writes.

Requirements:

- immutable backup;
- expected channel identity validation;
- dry-run by default;
- safe merge with all existing localizations;
- controlled concurrency;
- per-video execution ledger;
- failure isolation;
- idempotent resume;
- verification;
- audit log;
- comprehensive tests.

Do not add AI generation yet.
```

---

# 65. Sixth Agent Assignment

After localization write workflow is production-safe:

```text
Add optional AI-assisted localization generation.

AI must produce drafts only.

Design a provider interface so OpenAI / Anthropic / other providers can be swapped.

Channel/language-specific localization briefs must live in configuration/content files,
not source code.

Every AI proposal must pass through the existing validation → diff → approval → apply
pipeline.
```

---

# 66. Long-Term Direction

The system should gradually become:

```text
YouTube Operations Manager
        │
        ├── Human dashboard
        │
        ├── MCP for agents
        │
        ├── Internal API
        │
        ├── YouTube Data API
        │
        └── YouTube Analytics API
```

The architectural principle is:

> One safe operational core, many interfaces.

Web UI, CLI, API, and agents should not each implement their own YouTube write logic.

They should call the same underlying application services and safety checks.

---

# 67. Success Criteria

This project is successful when it provides a more reliable workflow than manual YouTube Studio editing while remaining safe enough for future automation.

The most important qualities are:

```text
Safety
Reliability
Auditability
Recoverability
Agent compatibility
Low manual effort
Scalability across channels
```

Feature count is secondary.

Do not accelerate toward autonomous publishing until the core metadata/localization write pipeline is proven reliable.

---

# 68. Final Instruction to Coding Agents

When uncertain:

1. inspect this repository's own existing conventions and patterns;
2. inspect official YouTube documentation;
3. preserve data;
4. choose the less destructive behavior;
5. produce a draft/change set rather than writing directly;
6. keep human approval in the loop;
7. add tests.

Never trade metadata safety for implementation speed.
