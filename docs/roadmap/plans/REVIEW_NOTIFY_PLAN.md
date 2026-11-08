# Owner review decisions wake the Producer (BL-248)

Sources:
- FO-REQ-0052 (Operator, 2026-11-08; owner TG 3412 in the Operator chat): every owner review decision in YT Manager (images,
  storyboards, videos, clips) writes one file into the Producer's Inbox.
- PRD-REQ-0063 (Producer, 2026-11-08; owner TG 1748): the same for clips, with the case that prompted it (two returned clips seen
  three hours late).
- DEV-RESP-0048 (plan, with its Update): videos = generation-plan video attempts + the storyboard's «Ролик целиком»; the weekly-plan
  slot decision added as kind `slot`. Approved by the owner 2026-11-08 (msg 4094, «да на оба»).
- ADR 0066 records the decision.

Written before the code, from the requirement. Expected values in the tests are derived from this file by hand.

## Behaviour

1. **The wake signal.** The Producer wakes only on a new non-dot file in `00 YT Producer/Inbox/` (`tools/wait_inbox.sh` polls every
   20 s, `find ! -name '.*'`). YTM writes one Markdown file per owner review decision there. Nothing else changes for the Producer:
   no MCP tool, no API contract changes.
2. **Kinds and what counts (only the owner's decisions).**
   | kind | source | counted | never counted |
   |---|---|---|---|
   | `clip` | clip-reviews document | a decision record `by: "owner"`, kind `approved` / `returned` (comment, attachments) | the Producer's `withdrawn`, a submit |
   | `storyboard` | storyboards document | a version decision (`approved` / `changes_requested`); a comment with `author: "owner"`; a reply with `author: "owner"` | the Operator's comments and replies, submissions, versions, comment state changes |
   | `render` | storyboards document | an owner verdict on an attached final file (`renderDecisions`) | the Operator's attach |
   | `plan` | generation plans | the owner's verdicts (accepted / rejected, rating, reasons, marks with region, note), picks and «ни один не подходит», on images, videos and music alike, from either computer | factory reports, validator rows, unpicks, cleared «ни один не подходит» |
   | `slot` | weekly publishing plans document | every slot decision (`approved`, `revoked`, `vetoed`, `restored`): all are the owner's | agents' saves of the plan |
   Approve / veto are what the requirement names; revoke and restore are the same owner surface and the Producer needs them as
   much (an approval taken back), so they are included with their status verbatim.
3. **One file per decision** for `clip`, `storyboard`, `render`, `slot`. **One file per review pass per plan** for `plan`: the
   owner gives up to 25 verdicts an hour in one plan. A pass is every not yet notified verdict, pick and «ни один не подходит» of
   the plan (on or after the plan floor, §6). It is written when
   - a wave finished: the plan has a `group_reviewed` event at or after the pass's earliest entry (minus 2 s: event times have
     one-second resolution), or
   - the plan was quiet for 5 minutes: the newest entry of the pass is 5 minutes old or more.
   A decision that arrives later (the other computer's, by sync) joins the next pass of its plan.
4. **File name** `REVIEW-DECISION-<kind>-<itemId>-<decisionId>.md`.
   - `clip`: itemId = clipId, decisionId = the decision record's id.
   - `storyboard`: itemId = storyboardId, decisionId = the decision's, comment's or reply's id.
   - `render`: itemId = storyboardId, decisionId = the render decision's id.
   - `slot`: itemId = `<weekStart>_<slotId>`, decisionId = the decision's id.
   - `plan`: itemId = planId, decisionId = the first 16 hex characters of the SHA-256 of the pass's entry ids, sorted and joined
     with `\n`. An entry id is `v|<planId>|<itemKey>|<attemptRef>|<at>|<result>` for a verdict, `p|<planId>|<itemKey>|<attemptRef>|<at>`
     for a pick, `n|<planId>|<itemKey>|<at>` for «ни один не подходит».
   - Every part keeps only `A-Z a-z 0-9 _ -`; any other character becomes `_`, and a part that had to be changed (or is longer
     than 64) is cut to 48 characters and gets `~` plus the first 8 hex of its own SHA-256, so two different ids never share a
     name. The whole name stays under 255 bytes.
   - Deterministic from the decision's own id: a retry, a restart or a second tick can never make a second name for it.
5. **Written once, never rewritten, atomic.** If the file already exists it is left alone. Otherwise the content goes to
   `.tmp-<random>` in the same folder (a dotfile: `wait_inbox.sh` ignores it), then is renamed to the final name. A failed write
   removes its temporary file. A decision that was written is recorded in this computer's notice ledger, so it is never written
   again even after the Producer moved the file away.
6. **When the switch goes on (first time, default included).** `clip` / `storyboard` / `render` / `slot` decisions made since
   2026-11-08T00:00:00Z are written (backfill); `plan` entries only from the moment it went on. Turning it on again later starts
   from that moment for every kind (no second backfill). Decisions older than 30 days are never looked at (the scan window).
7. **Content** (Markdown, the same bytes whichever computer writes it: no writer name, no write time):
   - YAML front matter: `format: ytm-review-decision/1`, kind, channelId, itemId, decisionId, status, decidedAt (UTC ISO),
     decidedOn, and for `plan` the entry count. Strings JSON-quoted.
   - Body: a title; channel name and id; the item and its context (clip: scene, clip path, clip note; storyboard: name = latest
     version title, version, Vn, target of a comment, the comment a reply answers; render: version, file; plan: title, Vn, every
     entry with item, attempt, result, rating, reasons, marks with region, note, device, time; slot: week, slot, date and time with
     the zone); status; the owner's comment verbatim in a fenced block; decidedAt; decidedOn; attachment paths relative to the
     channel folder; where to find it in YTM (tab) and the read tool (`producer_clip_review_get <clipId>`,
     `factory_storyboard_get`, `factory_plan_get`, `factory_publishing_plan_get`).
8. **One writer.** A per-computer switch «Будить Продюсера» (Settings → AI agent). Never set: ON when the workspace's
   `00 YT Producer` folder exists on this computer, OFF otherwise. Once on by default it stays on while that folder is away (the
   disk is not connected): that reads as "Inbox missing, retry", never as "switched off"; only the owner's explicit off turns it off. The Inbox folder setting: an absolute path; never set:
   `<workspace root>/00 YT Producer/Inbox`, where the workspace root is the one parent folder of every channel workspace set on
   this computer (none when they differ). The writer covers decisions made on either computer: the documents and the plans
   report bring the other computer's decisions here.
9. **How it runs.** A loop in the production server (never `next dev`), every 30 s (first 45 s after start), behind the device
   mutation gate like the other loops; an owner decision on this server also nudges it (2 s later). The decision itself never
   waits for or depends on the writer: a writer that is off, broken, or finds no Inbox folder changes nothing for the decision.
   A failure is logged (the same error once until it changes) and shown on the card; the next tick retries.
10. **Module shape (AGENTS.md §M).** `src/lib/review-notify/` imports no feature module (boundaries test). The sources are
    composed in `src/composition/review-notify.ts`. The feature modules know it only as an injected `notifyOwnerDecision` port
    (the nudge), wired in their own `index.ts`.

## Acceptance criteria

- **AC-RN-01** An owner `approved` and an owner `returned` clip decision each give exactly one file
  `REVIEW-DECISION-clip-<clipId>-<decisionId>.md`, with status, the comment verbatim and the attachment paths.
- **AC-RN-02** The Producer's `withdrawn` record and a submitted clip without a decision give no file.
- **AC-RN-03** A storyboard version decision, an owner comment and an owner reply each give one file (`storyboard`); an Operator
  comment or reply gives none. An owner render verdict gives one `render` file.
- **AC-RN-04** A slot decision gives one `slot` file named `REVIEW-DECISION-slot-<weekStart>_<slotId>-<decisionId>.md`.
- **AC-RN-05** A second tick, a restart (new service on the same ledger) or a retry writes nothing new; a file the Producer moved
  away is not written again.
- **AC-RN-06** An existing file with the final name is never rewritten (its bytes stay), and the decision counts as notified.
- **AC-RN-07** Plan entries 1-2 minutes old with no finished wave give no file; once the newest is 5 minutes old they give one file
  listing all of them; a `group_reviewed` event at or after the earliest entry gives the file at once.
- **AC-RN-08** A pass's decisionId is the SHA-256 prefix of its sorted entry ids (computed by hand in the test); a later verdict in
  the same plan goes into the next pass, not the first file.
- **AC-RN-09** The write never shows a non-dot partial file: every name the folder sees before the rename starts with `.tmp-`; a
  failed write leaves no temporary file.
- **AC-RN-10** A missing Inbox folder writes nothing, records nothing, logs once, and the next tick (folder present) writes the
  missing files.
- **AC-RN-11** Switch off: nothing is written and nothing is recorded; the owner's decisions are unaffected.
- **AC-RN-12** First enable: a clip decision of 2026-11-07T23:59:59Z gives no file, one of 2026-11-08T00:00:00Z gives one; a plan
  verdict before the enable time gives none.
- **AC-RN-13** File names: ids with `/`, `..`, spaces or non-Latin letters give names with only `A-Za-z0-9._~-`, deterministic,
  two different ids never the same name, shorter than 255 bytes.
- **AC-RN-14** `src/lib/review-notify/` imports no feature module (clip-reviews, storyboards, generation-plans, publishing-plans,
  publishing) and no db.ts.
- **AC-RN-15** The default: never set + `00 YT Producer` present → on; never set + absent → off; the owner's choice wins.
- **AC-RN-16** The same decision rendered twice gives the same bytes (no write time or writer name in the file).
- **AC-RN-17** A source that throws does not stop the other sources' files in the same tick.

## Not in scope

- No YouTube call, no paid call, no MCP tool or API contract change (the Producer only reads files).
- No backfill of plan verdicts before the enable time.
- The Producer's handling of the files (it dedupes by decisionId itself).
