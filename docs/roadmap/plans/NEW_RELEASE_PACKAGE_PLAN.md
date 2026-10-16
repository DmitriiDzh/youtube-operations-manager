# A release package made by the owner in Content → «Публикация» (BL-192)

**Status: IN PROGRESS** on `feature/bl-192-new-release-package`. Owner, Telegram 2026-10-16: the question (msg 2842), "pick the text file
instead of typing" (msg 2844), the plan (msg 2847) accepted with «ок» (msgs 2846, 2848).

## 1. Why

Release packages (`Vn_release.json`, `yt-release-package/1`, BL-182) are written only by the Operator today. The owner wants to make one
without the agent. The video folders already hold everything: the video, `Thumbnail_*`, and a `*Title_Description*.txt` whose lines
read `TITLE` / the title / `DESCRIPTION` / the description (with chapters and hashtags), saved with a BOM (both channels, checked
2026-10-16).

## 2. Design

- **Module** `src/lib/publishing/package-composer.ts` (pure, deps injected), wired in `publishing/index.ts`. It reuses the package scan's
  workspace reads (the workspace rule, ffprobe with its cache, the channel baseline) and the parser and checks of `packages.ts`.
- **Folders** (`GET .../publishing/package-folders`): every `04 Videos/<month>/<MMDD Vn>/` folder (the `workspace-videos` walk) holding a
  video file directly inside it. Each has `folder`, `video` (Vn from the folder name), its video, image and text files (direct children
  only), and whether a package is there already and whether it may be replaced.
- **Draft** (`POST .../publishing/package-draft { folder }`), filled in from the folder:
  - video: the only video file, or the one named after Vn (`isNamedAfterRelease`) when that is exactly one; otherwise the owner picks;
  - thumbnail: the only `Thumbnail_*.jpg|png`, else the only image; otherwise the owner picks;
  - text: the only `*Title_Description*.txt`; title and description from it (`parseTitleDescription`);
  - size from the file, duration by ffprobe, languages = the channel baseline; tags empty (the channel's tags then apply); date empty.
  - The answer carries the same problems the scan would give for that package (`packageProblems`).
- **Save** (`POST .../publishing/package { folder, files, title, description, tags, plannedPublishDate, replace }`): everything rebuilt on
  the server (size, duration, languages, Vn); written atomically as `<folder>/Vn_release.json` (temporary file + rename, the folder's real
  path inside the workspace) with `ready: true`, `problems: []` and `createdBy: "owner"`. A package with problems is saved and shows as
  not ready with its reasons, like any other.
- **Refused** (nothing written): a folder that is not `MMDD Vn` under `04 Videos/` of this channel's workspace; a file that is not a direct
  child of the folder or not of its kind; no channel language baseline; an empty title; a date that is not a real calendar date; tags
  that are not strings; an existing package without `replace`; with `replace`, a package that is uploaded (`Vn_youtube.json`), queued or
  uploading here, or reported by another computer (the approval's own rule, now one shared function).
- **UI**: «Новый пакет» beside «Обновить»; a dialog (the app's `ConfirmDialog`, no browser dialogs): folder list → the filled form
  (video, thumbnail, title, description, tags, date DD.MM.YYYY) with the problems shown live from the draft → «Сохранить». Replacing an
  existing package asks once more inside the dialog. Texts in English and Russian.
- **Not changed:** the upload, the approval, the agents (no new tool), the text file (read only).

## 3. Acceptance criteria (fixed before the code)

- **AC-NP-01 (text).** `﻿TITLE\r\nCuban Jazz ☕ | 2 Hours\r\n\r\nDESCRIPTION\r\nLine 1\r\n\r\n00:00 A\r\n#Tag\r\n\r\n` gives title
  `Cuban Jazz ☕ | 2 Hours` and description `Line 1\n\n00:00 A\n#Tag`. Without a `TITLE` or a `DESCRIPTION` line: null. The headers are
  matched case-insensitively on a line of their own.
- **AC-NP-02 (picks).** V41's folder (`0930.png`, `Thumbnail_V41_A.jpg`, `V41 Tropico Jazz.mp4`, `V41_Cuban-Jazz_A_master.png`,
  `V41_YouTube_Title_Description.txt`, `V41_YouTube_Chapters.txt`, `V41_Report.txt`, folder `work/`) → video `V41 Tropico Jazz.mp4`,
  thumbnail `Thumbnail_V41_A.jpg`, text `V41_YouTube_Title_Description.txt`. Two `Thumbnail_*` → thumbnail null (the owner picks). A file
  inside `work/` is never offered.
- **AC-NP-03 (save).** Saving V56 writes `V56_release.json` whose fields are: schema, channelId, `video: "V56"`, `mix: null`, the date or
  null, the two file names, the file's size and ffprobe's duration, title, description, tags, the baseline languages, `ready: true`,
  `problems: []`, `createdBy: "owner"` -- and the scan then lists it.
- **AC-NP-04 (refusals).** Each refusal of §2 writes nothing and gives its code.
- **AC-NP-05 (replace).** An existing, not uploaded package is replaced only with `replace: true`; one with `Vn_youtube.json`, an active
  local upload or a peer's report is never replaced.
