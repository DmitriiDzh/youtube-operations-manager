# Watchlist hygiene and agent proposals (BL-163, FO-REQ-0014)

**Status: DONE, merged into `dev` in 0cbe1a4 (owner msg 2360).** Owner, Telegram 2026-10-09 (msg 2311): full pause plus a deletion proposal; no
revival check, since inactive channels get deleted; hypotheses in this round if possible; history goes with a full
deletion. Branch: `feature/watchlist-hygiene-proposals`, one merge approval at the end. Reply to the Factory Operator:
DEV-RESP-0016.

Safety-relevant (AGENTS.md §L). It covers data deletion, a new agent write path (proposals), and approval integrity
("AI may propose. Human approves. System applies.", `docs/PROJECT_SPEC.md` §26). The acceptance criteria below are set
before the code.

## 1. Facts (checked 2026-10-09)

- **The watchlist is one global list.** It lives in `research_channels`, with per-channel links in
  `channel_record_assignments` (kind `research_channel`). It is edited in Research → Channels; Settings has only the
  collection budget and depth. Agents see only the entries linked to their channel, and so does the Producer, per call.
- **Removing a channel from one of ours already exists.** The per-entry "our channels" control does it (PUT
  `/api/market-assignments`). Deleting an entry hard-deletes its history, but it **leaves the entry's
  `channel_record_assignments` rows behind** (a bug).
- **The newest upload date** is `MAX(published_at)` over the entry's retained `market_video_snapshots`. Collection re-reads
  the first uploads page on every run, so this costs no extra API calls. Retention (30 days by `observed_at`) applies: a
  paused entry's date fades after 30 days.
- **Collection** picks entries in `claimStaleResearchChannelsForCollection`. An entry has no pause flag yet.
- **Hypotheses** (`hypotheses`) can only be created, and only in the Web UI. No agent may create one; experiments are the
  agents' proposal path.
- **The Producer** is READ-only (Producer API 1.0.0, ADR 0034). Its first non-read tools come with this item.

## 2. Design

### A. Inactivity and pause

- **Setting.** "Inactive after N months without uploads", default 6 (`app_settings`). It sits next to the collection budget
  (Settings → API).
- **Read model** for every watchlist entry:
  - `latestUploadPublishedAt`: the raw `MAX(published_at)` of its retained snapshots, null when unknown, never guessed;
  - `inactive`: the date is known and older than N months;
  - `pausedAt`, `pausedReason` (`inactive` | `owner`).
- These fields appear in Research → Channels, in `query_market_overview` / `query_competitors` for channel agents and the
  Producer, and in the Producer's own reads. No `AGENT_API_VERSION` bump for them: new optional output fields on existing
  tools are a widening, which the version rule (`agent-operations/contracts.ts`) leaves unbumped.
- **Auto-pause.** It is evaluated after each collection run, and over all entries at the start of a run. An entry that is
  inactive and not yet paused gets two things in one transaction:
  - `pausedAt`, with reason `inactive`;
  - a **system proposal "delete completely"**. It records N, not the upload date (another channel's API data, kept 30 days at
    most); the owner's card shows the entry's current date from the watchlist. At most one pending proposal per entry.
- **What a pause means.** A paused entry is never collected. Schema v74 adds `research_channels.paused_at` and
  `paused_reason`.
- **Pause is stored state; inactivity is only a detector that sets it.** After 30 days the paused entry's date is gone, by
  retention, and `inactive` reads false. The pause stays all the same, so the system proposal's text records the date
  seen at detection. The date is never stored on `research_channels`, which is classified `notApiData`.
- **Owner actions** in Research → Channels:
  - "Resume collection" clears the pause. If the entry is still inactive, the next evaluation pauses it again, so after a
    rejected deletion the owner resumes it on purpose.
  - "Pause" by hand (reason `owner`).
- **No revival check** (owner, msg 2311).

### B. The two watchlist operations

- **Stop following from one channel:** the existing assignment control, made clearer ("Followed by our channels").
- **Delete completely:** the existing delete. It now also removes the entry's `channel_record_assignments` rows and any
  pending proposal about it, in the same transaction.

### C. Agent proposals

- **Table `agent_proposals`** (schema v74):
  - `id`, `source` (`producer` | `system`), `kind`, `payload` (JSON, strict per kind);
  - `text` (the proposer's explanation, required), `channelIds` (ours concerned);
  - `status` (`pending` → `applied` | `rejected` | `failed`), `createdAt`;
  - `decidedAt`, `decidedBy`, `rejectComment` (required on reject), `applyError`;
  - `doneAt` (the proposer marked it read), `agentApiVersion`.
- **One of our channels per proposal** (advisor review, told to the owner): every Producer call already runs inside one named
  channel's scope, so a proposal belongs to that channel (`channelId`, single). "Two of our channels" means two proposals. The
  entry it names must be visible to that channel (`assertAvailableToAgent`), except for `watchlist.add`.
- **Kinds (v1):**
  - `watchlist.add` `{ competitor: UC… id | handle/URL, reason }`: add the competitor, or link an existing one, to this channel;
  - `watchlist.unfollow` `{ researchChannelId }`: this channel stops following it, and the entry stays for the others;
  - `watchlist.pause` / `watchlist.resume` `{ researchChannelId }`;
  - `watchlist.delete` `{ researchChannelId }`: deleted completely, for every channel;
  - `hypothesis.add` `{ statement, evidenceNotes }`: a hypothesis for this channel. On approval it is created with
    `createdVia: "mcp"` and `createdBy` naming the Producer. This supersedes PHASE_10_SLICE_2_PLAN's "hypothesis creation
    is Web-only" for this approved path only.
- **Producer tools** (Producer API 1.1.0):
  - `producer_propose` (DRAFT): one proposal. It is validated on submit: the entry exists, the channels are connected,
    and there is no duplicate pending proposal for the same kind and target.
  - `producer_list_proposals` (READ): its proposals with status and, for a rejected one, the comment.
  - `producer_mark_proposals_done` (DRAFT): marks decided proposals as read.
- **Sync and uniqueness.** `agent_proposals` travels in the device snapshot after `research_channels` and `hypotheses`, like
  `market_research_requests`. It is classified `notApiData`. A partial unique index on `(kind, target_id) WHERE status =
  'pending'` makes the system's deletion proposal idempotent, even when both computers evaluate.
- **Owner UI.** An "Agent proposals" panel heads Research → Inbox, with a count badge. Each card shows:
  - the proposer (Producer or system);
  - its text;
  - what will change, in plain words.
  - **Approve** is one action. **Reject** opens an inline comment box (not a native dialog), and the comment is required.
- **Apply.** It happens on approval, through the same services the UI uses (add, assignments, pause/resume, delete,
  `createHypothesis`). It is guarded by an atomic `pending → approved` update. A failure is stored as `failed` with the
  error. Nothing changes before approval.
- **Cleanup.** A decided proposal is deleted when the Producer marks it done, or 90 days after the decision. Pending ones
  never expire. (Implemented lazily: every list and every mark-done purges.)
- **As built (2026-10-09):**
  - Kinds and payloads are as in `src/lib/agent-proposals/schemas.ts`: `watchlist.add` `{ competitorChannelId (UC... only),
    reason, handleOrUrl? }` -- resolving a handle would need a YouTube call; the reason and handle are stored only for a new entry.
  - One `channel_id` per proposal plus `target_id`, `dedupe_key` and `created_via`. The unique index is on `dedupe_key`, which only
    pending rows hold: pause / resume / delete one per entry, add / unfollow per entry and channel.
  - The Producer's proposal tools are producer-only (not run in a channel's scope); the service itself checks that the channel is
    connected and follows the entry.
  - The approval inventory also scans `src/app/api/mcp`.
  - Cleanup runs on the gated writes only; reads hide expired rows without deleting them.
  - A paused entry has the collection status `paused`, outside "needs attention".
  - The setting N is per computer (RISK-121); the detector sees no date for an entry whose newest upload is older than its
    collection-depth `publishedAfter` limit (nothing is stored for it), so such an entry is never auto-paused.
  - A hypothesis is approved only while the proposal's channel is the owner's active channel (`createHypothesis` requires it).
    Otherwise approval is refused with `AGENT_PROPOSAL_CHANNEL_NOT_ACTIVE` and the proposal stays pending.
  - Approve claims the proposal (`pending → applied`) before applying, and a throw sets `failed`. There is no separate
    `approved` state (RISK-120). An add whose channel is no longer connected is refused before the claim (stays pending); a
    hypothesis whose channel stops being active mid-approval is reopened (stays pending).
- **Integrity tests.** An inventory test fails if `src/mcp`, `src/cli` or `src/lib/agent-operations` can reach approve,
  reject or apply. The Producer READ test changes from "only READ" to "READ, plus exactly these two DRAFT tools".

## 3. Acceptance criteria

- **AC-WH-01** An entry whose newest retained upload is 7 months old is shown inactive. One with no known upload date is
  not.
- **AC-WH-02** The auto-pause pauses an inactive entry and creates exactly one pending system deletion proposal. It names the
  months, never the upload date (changed after independent review: storing the date kept another channel's API data past 30 days,
  III.E.4.d). Repeated evaluation creates no second one, including a concurrent one (unique index).
  Fixture at N = 6: entry A with snapshots at 7 and 8 months gets paused plus 1 proposal. Entry B with a snapshot at
  5 months is untouched. Entry C with no snapshots is untouched. A second run adds nothing.
- **AC-WH-07** A paused entry stays paused when its date later disappears, and rejecting its deletion proposal does not
  resume it.
- **AC-WH-03** A paused entry is never claimed for collection, whether automatically or by an approved collection request.
- **AC-WH-04** Resume clears the pause and stamps `resumedAt`. The detector does not pause the entry again for the same
  silence (a resume made while it was already inactive); a resume from an earlier, unrelated pause does not shield it; a newer upload
  that then goes quiet again does count. A change of N takes effect at the next evaluation.
- **AC-WH-05** Delete completely also removes the entry's channel links and its pending proposals.
- **AC-WH-06** The read tools and Research → Channels show `latestUploadPublishedAt`, `inactive` and the pause.
- **AC-PR-01** A Producer proposal is stored `pending` with its text. Nothing in the watchlist or hypotheses changes until
  approval.
- **AC-PR-02** Approve applies the change once, and a second approve gets `NOT_PENDING`. Reject without a comment is
  refused; with one, it stores the comment and changes nothing.
- **AC-PR-03** The Producer lists its proposals with status and the reject comment. Marking one done removes it once it is
  decided; a pending one cannot be marked done.
- **AC-PR-04** A proposal naming an unknown entry or an unconnected channel is refused at submit. So is a duplicate pending
  proposal.
- **AC-PR-05** No MCP, CLI or agent-operations code path can approve, reject or apply (inventory test).
- **AC-PR-06** A decided proposal is purged 90 days after the decision. Pending ones never are.
- **AC-PR-07** A failed apply (e.g. the entry was deleted meanwhile) is stored `failed` with the error. It is shown and
  never retried silently.

## 4. Slices (one branch)

1. A + B (pause, setting, read fields, delete fix), schema v74 (part).
2. C (proposals: table, services, Producer tools, Web routes, panel, cleanup, inventory test).
3. Docs: SYSTEM_MAP, ARCHITECTURE, interfaces, AGENT_OPERATIONS_INTERFACE, ADR 0034 amendment, TECHNICAL_DEBT if needed.
