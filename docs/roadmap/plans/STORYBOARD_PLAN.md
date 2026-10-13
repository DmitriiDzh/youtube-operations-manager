# Storyboards reviewed before video, and Media's review tabs (FO-REQ-0024, BL-184)

- **Status:** PROPOSED 2026-10-13. Started on the owner's go (Telegram msg 2739: "Можешь начинать следующий таск FO-REQ-0024").
  The tab layout (§4) waits for the owner's choice.
- **Request:** FO-REQ-0024 (Operator, 2026-10-13; owner instruction 1178, gate scope 1183).
- **Sources:**
  - `dev` f535431 (schema v89, Factory API 1.15.0);
  - ADR 0029 (generation plans), ADR 0028 (per-device reports), ADR 0035 (Gemini money rules);
  - BL-175 visual review (`VISUAL_REVIEW_PLAN.md`);
  - the Operator's bar case under `Tropico Jazz/99 Data Exchange/Sent to YTM/H-0004/bar/` (K0–K3, `v2/`; present on disk).
- **ADR:** 0038 (proposed with this plan).

## 1. Facts that shape the design

- **Media today has two tabs** (Plans, Jobs). The review screen is per plan and mixes every kind in one list of attempts. The
  viewer is chosen by file kind.
  - Strong tools exist and are reused:
    - image zoom, pins (`PlanMarker{region}`), wipe / difference compare;
    - video frame step, markers and seam loop;
    - `SeamFrames` (the last frame against the first);
    - the grid, picks, verdicts and reasons.
  - Nothing is threaded, nothing can be commented before an attempt exists, and plans have no versions and no approval.
- **Plans are owned by the computer that made them.** Other computers see a read-only per-device report and send verdicts back
  through peer tables (ADR 0029). That model cannot take comments and approvals from both computers on the same object, which a
  storyboard needs.
- **Peer media plays from the receiving computer's own copy of the channel workspace** (`peers/[deviceId]/[planId]/audition`). The
  channel folders are synced between the computers. A storyboard keyframe can therefore be a workspace path, like a plan attempt.
- **Video jobs:**
  - Gemini `firstFrame` / `lastFrame` are explicit, and `readInputs` computes each input's sha256 before the estimate, the limit
    check and any charge. That is a free gate point.
  - RunPod media templates have no frame roles: a template's image parameter is a name and a node. The gate there needs a role
    annotation on the template, set by the Operator.
- **Notices:** the layout already passes separate entry lists to the bell (languages, publishing). A storyboard list joins them.
- **Factory API:** the tool names are explicit allowlists (`FACTORY_TOOL_NAMES`, `FACTORY_WRITE_TOOL_NAMES`) with tests.

## 2. Decisions proposed

1. **A storyboard is a new object** in its own feature module, `src/lib/storyboards/` (AGENTS.md §M), not a plan kind. It
   depends on nothing in `generation-plans`. A link to a plan is an optional id.
2. **Synced as Automerge, one document per channel** (sync family `storyboards`, the `change-drafts` pattern), because both
   computers write to it:
   - **Versions are written only by the authoring side:** the Operator's Factory API, on the computer it runs on. Each version is a
     frozen snapshot keyed by `versionId` (v1, v2, …). A new version never edits an older one.
   - **Comments are a map by `commentId`.** Each comment has a target (the storyboard, a keyframe, a segment or a prop cell), an
     optional pin (`PlanMarker.region`), author (owner or operator), text, state (open or resolved), the version it was made on,
     and replies (a map by `replyId`). Ids as map keys and whole-value fields keep the two computers' appends from colliding.
   - **The approval is `{ versionId, by, at }`.** It counts only while `versionId` is the latest version. A new version therefore
     resets the state to "in review" without anything being edited; an approval of v2 made on Windows while the Mac adds v3
     approves nothing current.
   - **State is derived, never stored twice:**
     - draft: no version submitted;
     - in review: the latest version submitted, no newer request or approval;
     - changes requested: the owner requested changes on the latest version;
     - approved: an approval names the latest version;
     - generating / done: from the jobs linked to the approved version.
3. **Keyframe images are workspace paths** (under `99 Data Exchange/Sent to YTM/` or `From YTM/`), with the sha256 frozen in the
   version. The other computer shows them from its own copy, through the plan-audition checks. When this computer's file is
   missing or its sha256 differs, the screen says so ("this computer's copy differs") and keeps the comments and pins; review is
   not blocked.
4. **The gate (B4, owner 1183):** a per-channel setting, "first/last-frame video requires an approved storyboard", on by default.
   - **Gated:** a video job whose first and last frames are two **different** images (by sha256), unless it names a storyboard
     version that is approved and current and a segment whose two keyframes are exactly those images (by sha256). Otherwise it is
     refused with `storyboard_not_approved`: nothing is sent and nothing is charged.
   - **Not gated:** a job with only a first frame, or with the same file as first and last frame (a one-image loop); image jobs;
     music jobs.
   - **Gemini** (`factory_gemini_create_job`): checked right after `readInputs`, before the estimate and any charge.
   - **RunPod templates** (`factory_media_create_job`): a template's image parameter gains an optional role, `first_frame` or
     `last_frame`, set by the Operator in the template tools. The check runs after the inputs are resolved and their sha256 is
     computed locally, before the upload. A template without roles is not recognised as first/last-frame. The Operator must tag
     the FLF templates, which DEV-RESP-0029 asks for.
   - **Plan runs** (`factory_plan_run_stage` / rerun) go through the same `createJob` path, so the same check applies per job. A
     plan item carries `storyboardId` / `segmentId` in its parameters when it renders a segment.
5. **Prop table:** rows are typed (object or character) with a name; columns are the keyframes; each cell is free text. A cell that
   differs from the previous keyframe's cell is highlighted, so continuity is visible at a glance.
6. **Factory API 1.16.0 (additive):**
   - `factory_storyboard_create` and `factory_storyboard_update` (content; a content change makes a new version);
   - `factory_storyboard_get` (content, versions, derived state, comments with pins, the approval);
   - `factory_storyboard_list` (with `state` filters: waiting for the owner, changes requested, approved with segments not yet
     rendered). It plays the role FO-REQ-0024 C gives `factory_plan_todo`, which stays unchanged;
   - `factory_storyboard_submit` (to "in review"; raises the notice);
   - `factory_storyboard_reply` (an answer in a comment's thread, and resolve);
   - `storyboardId` / `segmentId` on `factory_media_create_job`, `factory_gemini_create_job` and `factory_plan_report` rows.
   - Agent API and Producer API: a read of storyboards (draft creation by the Producer is not in this plan).
   - Approving and requesting changes stay in the Web UI, by the owner.

## 3. Stages (one branch, `feature/bl-184-storyboards`, merged whole on the owner's yes)

**Stage 1: the storyboard and its review** (acceptance §5 steps 1–3).
1. Module, schema and sync family. Is anything device-local in SQLite? Ideally nothing: the document is the store, and SQLite at
   most indexes it for lists.
2. Factory tools: create, update (new version), get, list, submit, reply. Checks:
   - the channel is connected;
   - every keyframe file exists in the workspace (its sha256 is computed and frozen);
   - segment endpoints are keyframes of the version;
   - the loop flag adds the last → first segment.
3. Media → «Раскадровка» (tab or route per §4). It lists the channel's storyboards with their state; the detail screen has:
   - a filmstrip, K0 → [S1 card: action, duration, model, cost] → K1 … → K0 when looped;
   - a keyframe opens in the existing image viewer (zoom, pins); a segment card opens its text;
   - two neighbouring keyframes side by side or as a difference (the existing compare);
   - the prop table under the filmstrip, changed cells highlighted;
   - comments on the storyboard, a keyframe (with pins), a segment or a prop cell; open and resolved; threads;
   - «Запросить изменения» (with the open comments) and «Одобрить эту версию»;
   - a version switcher, and what changed against the previous version (keyframes replaced, texts and cells edited).
4. Notices: «Раскадровка ждёт проверки», «Одобрена, N сегментов к рендеру» (badge on Media, bell for other channels).
   «Изменения запрошены» goes to the Operator through `factory_storyboard_list`.

**Stage 2: the gate** (acceptance §5 step 4).
1. The channel setting (Media setup or Settings → channel), on by default.
2. Gemini: the frame check after `readInputs`; the job records `storyboardId`, `versionId` and `segmentId`.
3. RunPod: the template role annotation in the template tools, then the check after the inputs are resolved; the job records the
   link (new nullable `media_jobs` columns).
4. Plan runs: the same check per created job.

**Stage 3: the tabs and the video review** (acceptance §5 steps 5–6), after the owner's layout choice.
1. The chosen layout (§4). The kind tabs reuse the plan list and the review screen with a kind filter (audio, image, video).
2. Lineage (A4): `sourceRef` on a keyframe (another keyframe or an attempt) and on a plan result. The viewer flips and compares
   against the parent.
3. Video for a storyboard:
   - each segment's takes (media and Gemini jobs linked to it) between its keyframes;
   - one pick per segment (the existing pick flow);
   - the joints with the existing seam tools: the last frame of take n against the first frame of take n + 1, and the loop closure;
   - the assembled loop played in order in the browser; the Operator uploads the rendered loop for the final verdict.

## 4. The owner's decision: Media's first level

- **Option A (recommended; what 1178 asks for):** «Музыка | Изображения сцены | Раскадровка | Видео | Служебное».
  - «Служебное» holds today's Планы and Задания.
  - Each kind tab lists the plans with items of that kind (and, for Раскадровка, the storyboards), and opens the review filtered
    to that kind.
- **Option B:** keep «Планы | Задания», and add «Раскадровка» as a third tab. The plan review gets a kind filter (Музыка /
  Изображения / Видео) at its top.

## 5. Not in this plan

- Blind A/B comparison (A5, nice to have): a later item.
- Storyboard drafts created by the Producer.
- An in-app video concatenation into a file: the Operator renders the final loop.
- Storyboards for one-image videos: not needed (owner 1183).

## 6. Risks

- **The gate depends on the Operator's template roles.** An FLF template left untagged is not gated, and the plan says so in the
  Operator's release note.
- **A workspace file can be overwritten in place.** The frozen sha256 detects it, and the screen warns.
- **Two computers resolving the same comment differently** is an Automerge field conflict. The last writer wins, and both values
  stay visible in Merge, like other families.
