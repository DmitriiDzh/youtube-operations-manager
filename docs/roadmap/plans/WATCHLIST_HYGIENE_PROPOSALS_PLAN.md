# Watchlist hygiene and agent proposals (BL-163, FO-REQ-0014)

**Status: APPROVED, in progress.** Owner, Telegram 2026-10-09 (msg 2311): full pause plus a deletion proposal; no
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
  Producer (`AGENT_API_VERSION` minor bump), and in the Producer's own reads.
- **Auto-pause.** It is evaluated after each collection run, and over all entries at the start of a run. An entry that is
  inactive and not yet paused gets two things in one transaction:
  - `pausedAt`, with reason `inactive`;
  - a **system proposal "delete completely"**, whose text names the newest upload date. At most one pending proposal per
    entry.
- **What a pause means.** A paused entry is never collected. Schema v74 adds `research_channels.paused_at` and
  `paused_reason`.
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
- **Kinds (v1):**
  - `watchlist.add` `{ channelId (UC…) | handle, followers: ourChannelIds[] }`;
  - `watchlist.follow` `{ researchChannelId, add: ourChannelIds[], remove: ourChannelIds[] }`;
  - `watchlist.pause` / `watchlist.resume` `{ researchChannelId }`;
  - `watchlist.delete` `{ researchChannelId }`;
  - `hypothesis.add` `{ channelId (ours) | null, statement, evidenceNotes }`.
- **Producer tools** (Producer API 1.1.0):
  - `producer_propose` (DRAFT): one proposal. It is validated on submit: the entry exists, the channels are connected,
    and there is no duplicate pending proposal for the same kind and target.
  - `producer_list_proposals` (READ): its proposals with status and, for a rejected one, the comment.
  - `producer_mark_proposals_done` (DRAFT): marks decided proposals as read.
- **Owner UI.** An "Agent proposals" panel heads Research → Inbox, with a count badge. Each card shows:
  - the proposer (Producer or system);
  - its text;
  - what will change, in plain words.
  - **Approve** is one action. **Reject** opens an inline comment box (not a native dialog), and the comment is required.
- **Apply.** It happens on approval, through the same services the UI uses (add, assignments, pause/resume, delete,
  `createHypothesis`). It is guarded by an atomic `pending → approved` update. A failure is stored as `failed` with the
  error. Nothing changes before approval.
- **Cleanup.** A decided proposal is deleted when the Producer marks it done, or 90 days after the decision. Pending ones
  never expire.
- **Integrity tests.** An inventory test fails if `src/mcp`, `src/cli` or `src/lib/agent-operations` can reach approve,
  reject or apply. The Producer READ test changes from "only READ" to "READ, plus exactly these two DRAFT tools".

## 3. Acceptance criteria

- **AC-WH-01** An entry whose newest retained upload is 7 months old is shown inactive. One with no known upload date is
  not.
- **AC-WH-02** The auto-pause pauses an inactive entry and creates exactly one pending system deletion proposal. Repeated
  evaluation creates no second one.
- **AC-WH-03** A paused entry is never claimed for collection, whether automatically or by an approved collection request.
- **AC-WH-04** Resume clears the pause. The setting change (N) takes effect at the next evaluation.
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
