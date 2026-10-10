# Experiment arms on videos (BL-170, FO-REQ-0015 item 3)

**Status: IN PROGRESS** on `feature/fo-req-0015-experiment-arms`. Owner, Telegram 2026-10-10 (msg 2482, «Ок»): FO-REQ-0015 step 5 in the
order of DEV-RESP-0018.

## 1. What exists (code read 2026-10-10)

- **Decision engine** (Phase 10, `src/lib/decision-engine/`):
  - Tables `hypotheses` (channel, or none for a new-channel concept), `experiments` (one hypothesis; `treatment`, `control_baseline`,
    criteria; status `proposed → approved → running → concluded | abandoned`, moved only by a person) and `experiment_outcomes`.
  - Ids are UUIDs. There is no "H-0001": the Producer's hypothesis numbers live in its own files.
  - The tables travel in the device snapshot.
  - No table links a video to an experiment. `agent_list_asset_performance` says so ("experiments in the Decisions list are not linked to
    videos yet").
- **Decisions tab** (`decisions-manager.tsx`): create a hypothesis → select it → create an experiment, move its status, record outcomes.
  Live check 2026-10-10: Rural Japan Music has no hypothesis yet.
- **Producer proposals** (BL-163, `src/lib/agent-proposals/`):
  - Kinds: `watchlist.*` and `hypothesis.add`.
  - The owner approves in Research → Inbox. Approving applies the change through a port.
  - The Producer can read hypotheses and their trail, but it **cannot propose an experiment**: `create_experiment_proposal` is a
    channel-agent tool and is not on the Producer's list.
- **Stored per-video data to report per arm:**
  - Day-7 / day-28 milestones: totals and the retention curve.
  - Reach (impressions, CTR) per window.
  - Traffic sources and devices per day (BL-168).
  - Search terms (BL-169).
  - Milestones, breakdowns and search terms are device-local; Reach rows are shared.
- **Module rule:** `decision-engine` must not import analytics (PHASE10-INV-03). Any db symbol named like `experiment*`/`hypothes*` must
  stay inside it (PHASE10-INV-01).

## 2. Design

### Links

- **New table `experiment_arm_videos` (v79):** key (experiment_id, video_id), plus `arm`, `linked_by`, `linked_via` (`web_ui` |
  `producer_proposal`) and `linked_at`.
  - FK to `experiments`; no FK to `videos` (the informal-reference rule of the change-set link).
  - In the device snapshot, like the other decision tables.
- **Arm label:**
  - 1–32 characters: letters, digits, space, `_` or `-`. It starts with a letter or digit.
  - Suggested values: `control`, `A`, `B`, `C`, `D`. Any other label in the format is accepted too.
- **Rules:**
  - Only for an experiment whose hypothesis has a channel (like attaching a change set). The video must be a synced video of that channel,
    in any visibility, so a planned upload can be linked before it goes public.
  - A video is in at most one arm of an experiment. Linking it again is refused; remove it first.
  - At most 50 videos per experiment.
  - Links can be added or removed while the experiment is `proposed`, `approved` or `running`. Once it is `concluded` or `abandoned` they
    are frozen, so the history is kept.
- **Who can link:**
  - The owner, in the Decisions tab.
  - The Producer, by a proposal the owner approves. An agent never links directly.

### Producer proposal `experiment.link_video`

- **Payload:** `{ experimentId, videoId, arm }`.
- **Checked on submit:**
  - the experiment exists and its hypothesis's channel is the proposal's channel;
  - its status allows links;
  - the video is a synced video of that channel and not linked yet.
- **Duplicates:** the dedupe key is (experiment, video), so the same video cannot be pending twice.
- **Approving:** like `hypothesis.add`, the proposal's channel must be the owner's active channel, otherwise it stays pending. The link is
  then created with `linked_via: producer_proposal`.
- A new port next to `HypothesesPort`, wired to the decision engine.
- Shown in Research → Inbox with its own text.

### Reads

- **`agent_get_hypothesis_trail`** (existing): each experiment gains `arms: [{ arm, videoIds… }]`, in the decision engine itself.
- **New tool `agent_get_experiment_results`** (channel agent and Producer), input `{ channelId, experimentId }`. It returns the experiment
  (status, treatment, control baseline, success and stopping criteria) and `arms: [{ arm, videos: [...] }]`. For each video:
  - `videoId`, `title`, `publishedAt`, `durationSeconds`, `linkedAt`, `linkedVia`;
  - **per milestone** (day 7 and day 28):
    - the window;
    - the milestone `status` (collected | retry | failed | due | not_due, as in `producer_upload_milestones`, whose composition
      `portfolio-overview/upload-milestones.ts` this follows) and the stored `totals` (views, minutes, average view duration and
      percentage), null unless collected;
    - Reach over the same window (impressions, CTR, days with data);
    - traffic sources and devices summed over the same window (from the stored breakdowns).
- **What the tool does not include:**
  - The retention curve. It is 100 points per milestone; `agent_get_video_milestones` with the arm's videoIds gives it.
  - Search terms. They are a total over the video's own range, not per window; `agent_get_stored_search_terms` gives them.
- **No per-arm averages, sums or comparisons.** YT Manager groups each video's stored values by arm; the reader compares (III.E.4.h).
- **Where it is built:** a new module `src/lib/experiment-results/` composes the decision engine (the arms) with analytics and Reach (the
  values), through injected cores. The decision engine stays free of analytics (PHASE10-INV-03).
- **Versions:** Agent API 3.11.0 → **3.12.0** (capability `decision_engine.query_experiment_results` and the trail's `arms`). Producer API
  1.4.0 → **1.5.0** (the tool, and the proposal kind).
- The `agent_list_asset_performance` texts point to the new tool.

### Decisions tab

The selected experiment's card gets a **Videos by arm** block:
- the linked videos grouped by arm, each with its title, publish date and a remove button;
- a form to add a video: a searchable list of the channel's videos and an arm field with the suggested labels.

The block is read-only once the experiment is concluded or abandoned, or when its hypothesis has no channel (it then says why). The block's
texts get keys in English and Russian.

### Not in this step

- The Decisions tab does not show the outcomes per arm. The tool gives them.
- Experiments across channels: a hypothesis has one channel.
- **Pending the owner's answer:** whether the Producer may also propose an experiment. Today only the owner, or a channel agent through
  `create_experiment_proposal`, can create one.

## 3. Acceptance criteria (fixed before the code)

- **AC-EA-01 (link).** The owner links video `v1` of channel `UC_A` to experiment `E1` (hypothesis on `UC_A`, status `running`) as `A`.
  - `agent_get_hypothesis_trail` lists `E1` with arm `A` = [`v1`].
  - The row has `linked_via: web_ui` and the owner's user id.
- **AC-EA-02 (refusals).** Each of these is refused with its own error code, and nothing is written:
  - a hypothesis without a channel;
  - a video of another channel, or one that was never synced;
  - an experiment that is `concluded` or `abandoned`;
  - an arm label that is empty, 33 characters long, or starts with `-`;
  - a video already linked (in any arm);
  - the 51st video;
  - an `experimentId` that does not exist;
  - an inactive channel.
- **AC-EA-03 (remove).**
  - Removing `v1` from running `E1` deletes the link.
  - Removing a link of a concluded experiment is refused.
  - Removing a link that does not exist is refused.
- **AC-EA-04 (proposal submit).** The Producer submits `experiment.link_video { E1, v2, "control" }` for `UC_A`. It is pending, with
  `targetId = E1`.
  - The same (E1, v2) again is `AGENT_PROPOSAL_DUPLICATE`.
  - These are refused when submitted: an experiment of another channel, a video of another channel, a concluded experiment, an
    already-linked video, and a bad arm label.
- **AC-EA-05 (proposal approve).**
  - The owner approves while `UC_A` is active: the link exists with `linked_via: producer_proposal`, and the proposal is `applied`.
  - With another channel active, approving is refused and the proposal stays `pending`.
  - If the experiment was concluded in the meantime, the proposal is `failed` with the reason.
- **AC-EA-06 (results).** Read at 2026-10-10T18:00:00Z. `E1` has arm `control` = [`v1`] and arm `A` = [`v2`].
  - **Stored data of `v1`** (published 2026-09-01T12:00:00Z):
    - a day-7 milestone for 09-01..09-07: views 120, minutes 300, average view duration 150, average view percentage 41.5;
    - Reach rows 09-01 (1000 impressions, CTR 0.05) and 09-02 (500, 0.02);
    - traffic rows `SUBSCRIBER` 09-01 10 / 20 and 09-08 5 / 9.
  - `v2` is published 2026-10-05T12:00:00Z and has no stored data.
  - `agent_get_experiment_results` returns both arms. Expected values:

    | Video | Milestone | Window | Status | Totals | Reach | Traffic sources |
    |---|---|---|---|---|---|---|
    | `v1` | day 7 | 2026-09-01..09-07 | collected | as stored | 1500 impressions, CTR 0.04 (weighted: 60 / 1500), 2 days with data | `SUBSCRIBER` 10 / 20 (09-08 lies outside the window) |
    | `v1` | day 28 | 2026-09-01..09-28 | `due` (no stored row; the window and the lag are over) | null | 1500 / 0.04 | `SUBSCRIBER` 15 / 29 |
    | `v2` | day 7 | — | `not_due` | null | null | empty |
    | `v2` | day 28 | — | `not_due` | null | null | empty |

    `v2` returns no error.
- **AC-EA-07 (scope).**
  - `agent_get_experiment_results` for an experiment of another channel is refused. *(Changed while building: in an agent's scope the
    decision engine's own guard answers `CHANNEL_NOT_ACTIVE`, as for every read of another channel's experiment or hypothesis
    (`agent_get_hypothesis_trail` too); `EXPERIMENT_NOT_FOUND` remains for an unknown id and for an experiment whose hypothesis is not the
    requested channel's.)*
  - Through the Producer, it runs in the named channel's scope.
  - Neither the channel agent nor the Producer can link or remove directly: no MCP or CLI tool does it, checked by the agent-approval
    inventory test.
- **AC-EA-08 (frozen history).** After `E1` is concluded, its arms are still returned by the trail and the results, and adding or removing
  is refused.
- **AC-EA-09 (contract).**
  - Agent API 3.12.0 with capability `decision_engine.query_experiment_results`.
  - Producer API 1.5.0 with the tool on the channel-tool list and the kind in `producer_propose`.
  - `agent_list_asset_performance` no longer says experiments are not linked to videos.
- **AC-EA-10 (data).**
  - `experiment_arm_videos` is in the device snapshot and is classified as YT Manager's own data, not YouTube API data.
  - The UI texts exist in English and Russian.
- **AC-EA-11 (UI).**
  - In the Decisions tab, a running experiment of the active channel shows its videos by arm. A video can be added from the channel's list
    with a suggested arm label, and removed.
  - A concluded experiment shows the block read-only.
  - An experiment of a channel-less hypothesis shows why videos cannot be linked.
