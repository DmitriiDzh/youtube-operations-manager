# 0065. Attachments to the owner's clip comment, written into the channel's `From YTM/clip-reviews/`

Status: Accepted (owner, Telegram 2026-11-06: msgs 4076/4078/4079 «да»). Amends ADR 0061's consequence "the app writes nothing into
the channel folder" -- for these attachments only, only under `99 Data Exchange/From YTM/clip-reviews/`.

**Date:** 2026-11-06.
- **Plan:** `docs/roadmap/plans/CLIP_REVIEWS_PLAN.md` items 10-17 (BL-246), acceptance AC-CR-17..27.

## Context

When the owner approves or returns a clip, a comment alone is often not enough: he wants to show a screenshot with the problem marked,
a reference image, a short PDF or a sample video. Today he sends those in Telegram, apart from the decision. The Producer reads the
decision on either computer, and the channel folder already syncs to both by Syncthing.

## Decision

1. **The owner's comment can carry files** (paste, drop, «Прикрепить файл»): at most 10 per decision, each up to 50 MiB, only
   png / jpg / jpeg / webp / gif / pdf / txt / md / json / mp4 / webm / mov, checked by extension, by the type the browser declares and
   by the file's first bytes. Names are sanitized (one segment, no control or Windows-reserved characters, length cap) and de-duplicated
   ignoring case.
2. **Where they go:** `<workspace>/99 Data Exchange/From YTM/clip-reviews/<clipId>/<decisionId>/<name>` -- the one folder ADR 0019's
   amendment lets the product write into, created through the shared `workspace-exchange` rule (new reusable helpers
   `resolveFromYtmFolder` / `resolveFromYtmFolderFile`: plain folders, real paths inside the workspace). Syncthing brings them to the
   other computer. Nothing else in the channel folder is written.
3. **Upload in pieces to this computer's app data first.** Every `/api` request passes `src/proxy.ts`, and Next keeps only the first
   40 MB of a proxied body (`proxyClientMaxBodySize`) and silently drops the rest. Rather than raise that limit for every route (and
   hold 50 MB+ bodies in memory), the panel sends each file in pieces of at most 4 MiB to a staging folder in app data, with the
   browser's SHA-256 checked at the last piece. The decision then names the staged uploads. Staging older than 24 h is removed.
4. **All or nothing.** Everything is checked before the workspace is touched; the files are copied under a temporary name in the new
   decision folder, their size and SHA-256 verified, renamed; only then is the decision recorded. A failed copy, check or record removes
   the decision folder; nothing is recorded.
5. **The record** gets an optional `attachments: [{ path, name, mime, size, sha256 }]` (workspace-relative path). Older builds read
   the document without a schema and ignore the field; a decision without it reads `[]`.
6. **Showing** follows ADR 0029 decision 5 and ADR 0061 §6: a loopback-only owner route, `local-file-response`, the stored path
   accepted only as exactly that decision's folder plus one name, resolved again at serve time; a file not here yet or different
   (size or SHA-256) is reported, never served.
7. **The Producer** reads the attachments in `producer_clip_review_get` / `_list` (Producer API 1.19.0, additive) and gets no tool
   to add them. Only the owner's Web session decides (unchanged; AC-CR-12 source scan).

## Consequences

- The channel folder gains `99 Data Exchange/From YTM/clip-reviews/` with the owner's files; the app never deletes them after the
  decision (the receiving side may, like any `From YTM` content).
- A decision on one computer may show «файл ещё не пришёл» on the other until Syncthing has copied the files.
- An abandoned staged upload costs disk until the 24 h sweep (at most 10 × 50 MiB per open comment).

## Compatibility / migration impact

- Additive field in the `clip_reviews` document; no schema change, no new sync family. Producer API 1.19.0; Agent and Factory APIs
  unchanged.
