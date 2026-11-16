# 0071. A second video code `S<n>` for Shorts, chosen by the factory, and a one-shot local recode of the WWE Shorts

Status: Proposed -- the requirement is the owner's; implemented on `feature/bl-263-short-video-code` (Factory API 1.49.0, Agent API
4.21.0, Producer API 1.23.0), awaiting the owner's merge. Decided 2026-11-16: the recode runs on the Mac, an S is given only through
`factory_video_create`, the next long video is the highest V ever known + 1, published Shorts are recoded too; the Operator confirmed
the file rule, the timing (recode right after the 2.5.44 pin) and that slots asking for approval again are acceptable. Requirement (owner via the Producer: PRD-REQ-0194, Producer chat TG 2332 «под шортс ок», 2026-11-16; TG 2334 -- recode the
unpublished WWE Shorts; owner TG 4553/4555 -- recode the published ones too, locally only; spec agreed with the Factory Operator).

**Date:** 2026-11-16.
- **Plan:** `docs/roadmap/plans/SHORT_VIDEO_CODE_PLAN.md`, acceptance AC-SC-01..21. Backlog BL-263.
- **Amends:** ADR 0040 §2 (the next number) and §4 (the duplicate rule) for the `S` series. Builds on ADR 0051/0062 (weekly plan,
  fingerprints), 0059 (Producer queue), 0070 (owner package review) and BL-261 (`factory_release_folder_rename`).

## Context

Every video of a channel has one code `V<n>` (ADR 0040): YTM gives the next one (highest + 1), the factory names the folder
`<MMDD> V<n>`, the package `V<n>_release.json`, the upload record `V<n>_youtube.json`, the cost file `V<n>_cost.json` and the mp4
`V<n> <Channel>.mp4`. The code is checked by about forty separate regexes (three different V spellings), by three per-device sync
reports, and it keys upload rows, reservations, job links, the orientation cache and Content's column. WWE now makes Shorts numbered
by their piece (`S-0014`); the owner wants their own series, and the 22 existing WWE Shorts (V1–V3, V5–V10, V12–V17, V20–V26)
recoded to S1–S22, including four published and two uploaded private ones. The long WWE videos V4, V11, V18, V19 stay V.

## Problem

1. Where the code rule lives, and how strict readers are.
2. How S numbers are given without breaking "the next V" and "a number is never given twice".
3. How a computer on an older build behaves when a peer's report carries an S code.
4. How 22 packages, some uploaded and published, change their code without a YouTube call and without losing their video id,
   upload history or plan state, on two computers that each own only their own records.

## Alternatives

- **Code rule:** (a) widen each regex in place -- forty edits, three spellings drift again; (b) **one shared module** used everywhere
  (chosen); (c) a per-channel prefix setting -- needs a prefix in every report, folder rule and a "next" rule per prefix, for one
  known need.
- **S numbering:** (a) S also highest + 1 -- contradicts the requirement (the number is the piece's); (b) **a given number, refused
  when known** (chosen); (c) no reservation at all for S -- loses duplicate detection and cost linking.
- **Older peer:** (a) bump the three report versions unconditionally -- the older peer refuses even V-only reports the moment one
  computer updates; (b) **version 2 only when a report holds an S** (chosen; BL-229 plans-report precedent) plus a release order;
  (c) leave version 1 and let the strict schema fail -- the older peer says "invalid" and silently keeps a stale report.
- **Recode:** (a) the Operator renames by hand -- upload rows, records, reservations and the manifest SHA-256 drift apart and a
  package can be offered for upload again; (b) re-upload under the new code -- a YouTube write and a new video id, refused; (c) **one
  local tool that moves files and every record together, with journal and rollback** (chosen). For the peer's own rows: (c1) run the
  tool again on the peer -- two runs to coordinate per video; (c2) **a read-time alias carried by the existing `replacedBy` field**
  (chosen).

## Decision

1. **`src/lib/shared-video-code/`** owns the code: `^(V|S)[1-9][0-9]{0,5}$` for every input and new contract; for existing files and
   reports, each reader keeps its current V acceptance (`V\d+`, `V\d{1,6}` or strict) and adds strict S, so no existing V package or report changes meaning;
   `parseVideoCode` → `{ series, number }`; the comparator (V before S, numeric).
2. **Numbering.** The next V is the highest known **V** + 1. `factory_video_create` takes an optional `video` that must be an S code
   (decision 2026-11-16: only the Factory Operator; a channel worker's `agent_video_create` refuses it, `s_codes_factory_only`); it is refused as `video_number_taken` when any source already knows it (cancelled reservations
   included). An S conflict between computers is shown, but never renumbered (there is no next S).
3. **Sync.** `publishing-uploads`, `video-reservations` and `video-costs` reports are version 2 only when they hold an S code;
   readers take 1 and 2. Automerge families are unchanged. Release order: both computers on this build, then the Operator pins
   factory bundle 2.5.44 (writes S) for WWE only, then the recode.
4. **Recode.** `factory_release_recode { channelId, video, newCode, dryRun? }` (Factory endpoint only, Factory API 1.49.0) renames
   the release folder and every file named after the code, rewrites the manifest's `video` and file fields (never free text), the
   records' `video` field, and in one DB transaction this computer's upload rows (code, paths, new manifest SHA-256, video id kept),
   reservations (old V cancelled with `replacedBy` the S, S in work), job/plan/social links and the orientation key; storyboards
   follow. Journal and backups first; any failure undoes the done steps; a crash is undone on the next call; read-back and audit.
   Refused: not a ` Short` folder or a horizontal frame, another channel, target known, busy (BL-261's reasons), a peer holding any
   upload row of the code, an owner approval that still has a date or an upload to give. Publishing state is **not** a refusal.
5. **Recode alias.** A V cancelled with `replacedBy` an S on any computer is "recoded": shown as such (no video id, so Content shows
   the S), its runs counted under the S, no new links, still counted toward the next V. A weekly-plan approval naming the V matches
   the S package when its video id equals the current one; an approval made before the upload is not carried (the slot asks
   again, which by ADR 0062 changes no date).

## Rationale

One module ends the three-spelling drift and is the only place a third series would ever be added. Lenient V reading keeps the
promise that nothing existing changes. Giving S as chosen matches how the factory numbers pieces; refusing a known S keeps "never
twice". Conditional report versions keep the two computers compatible until the first S exists, and make the failure message say
what to do. The recode moves the upload row onto the new manifest SHA-256, so the package stays "tried/uploaded" and can never be
offered again; the video id is the identity (AGENTS §F), so plans and Content follow it. `replacedBy` V→S cannot be confused with a
conflict renumber (always V→V), so the peer learns the mapping without a schema change or a second run.

## Consequences

- The recoded WWE V numbers stay burnt: the next long WWE video is the highest V ever known + 1 (V27 with V26 the highest).
- Old V codes stay in history (audit, cleanup log, review and plan decisions, Producer wake file names).
- `video_registry.csv` rows naming recoded codes would need the Operator's update (WWE has none); the alias hides them meanwhile.
- An older build that meets an S report keeps a stale copy of that peer's report (it cannot know the peer's newer uploads) -- the
  release order is the guard; a TECHNICAL_DEBT entry records it.
- No change to how YouTube is written; the recode is not a YouTube writer (AGENTS §F/§G unaffected).

## Compatibility / migration impact

- Additive APIs: Factory 1.49.0, Agent 4.21.0, Producer 1.22.0.
- No schema migration (no new table or column; the orientation cache is a setting key).
- Sync: version 1 reports unchanged when no S code exists; version 2 needs this build on both computers.
- Existing V packages, upload rows and reports are read exactly as before. The recode changes 22 WWE packages' manifest SHA-256 by
  design; the four published and two uploaded ones keep their upload rows (moved) and video ids.
