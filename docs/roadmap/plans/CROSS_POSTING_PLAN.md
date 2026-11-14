# BL-252 — Cross-posting: one vertical video to several short-video networks (plan and acceptance criteria)

Owner, Telegram 2026-11-14: msg 4239 (which platforms for vertical content that drive traffic to YouTube), msg 4241 (which
of them can be automated, one video to several networks), msg 4243 («делаем путь один как модуль YTM»: our own module,
not a third-party posting service), msg 4245 (every network that offers an API integration; each channel then decides in the
YTM interface which networks it connects — a per-channel user setting, not a developer choice). Open owner decisions are listed at the end; nothing is built before they are answered
and this plan is approved.

## Goal

One vertical clip from a channel folder → a post on several networks at once, each with its own caption and the link to
the YouTube channel, through the networks' official APIs. YouTube itself is not touched: the existing publishing module
keeps owning YouTube uploads.

## Platforms (owner msg 4245: every network with an API; each channel connects its own in the UI)

| Network | Official API | Upload of a local file | Before posts are public |
|---|---|---|---|
| Instagram Reels | Instagram Graph API, content publishing (Business/Creator account linked to a Facebook Page; Creator support **unverified**) | resumable upload to `rupload.facebook.com` — **unverified**; if only `video_url` works, R3 applies to Instagram too | Meta app review (`instagram_business_content_publish`); per-account limit read from `content_publishing_limit` |
| Facebook Reels | Pages API `video_reels` (the same Meta app) — **unverified** | resumable upload — **unverified** | the same Meta app review (`pages_manage_posts`, `pages_read_engagement`) |
| Threads | Threads API (video container → publish) | **only a public `video_url`** | Meta app review (`threads_content_publish`) — see risk R3 |
| TikTok | Content Posting API, Direct Post | `FILE_UPLOAD` in chunks | TikTok's Content Posting audit; without it posts can only go to a private account |
| Pinterest | API v5: media upload → video pin (clickable link to YouTube in every pin) | upload to the URL Pinterest returns | Standard access (Trial pins are visible only to the owner) |
| X | X API v2 posts + media upload | chunked upload | pay-per-use pricing (shown to the owner before a channel connects X) |

Not in scope: Snapchat Spotlight (allowlist only), Reddit (no official video upload; subreddit rules), VK/Dzen (unless the
owner asks for a Russian audience).

## Stage 0 — access probe (before any feature code; like publishing's G1)

The owner creates the developer apps (Meta, TikTok, Pinterest, X). For each network a short dev-only probe records, on the
owner's own test account: which upload path really works for a local file, what development / trial / unaudited mode
allows (private only? app role-holders only?), what each review asks for (public website, privacy policy URL, business
verification, a demo video of the posting UX) and whether a private single-owner local tool can pass it, and whether the
OAuth redirect accepts `http://localhost`. Result: go / no-go per network, written into this plan. A network that cannot
pass review stays available in its private/test mode only, clearly labelled in the UI.

## Shape (AGENTS.md §M: a feature module the rest of the app does not depend on)

- **`src/lib/social-gateway/`** — the single gateway for every call to these networks (the standing one-gateway-per-API
  rule, like the YouTube read/write gateways). One child per network (`meta.ts`, `tiktok.ts`, `pinterest.ts`, `x.ts`),
  re-exported by a barrel; an inventory test fails if any file outside the gateway calls those hosts. Every mutating call
  checks a new switch **«Публикация в соцсети»** (Settings, off until the owner turns it on) immediately before the call,
  the same way Live writes guard YouTube.
- **`src/lib/cross-posting/`** — the domain module: contracts, schemas, services, adapters (ports for files, store,
  gateway, clock). Nothing else imports it except its routes, MCP tools and UI.
- **Accounts:** one connection per channel per network (OAuth), connected by the user in the channel's settings (msg 4245).
  Token storage follows ADR 0042 and how `cloud-connection` stores rotating OAuth tokens (to be read at stage 1 before
  choosing: the device secret store currently excludes OAuth); app client secrets the same way. Never in the browser,
  logs, MCP answers or AI calls. Settings →
  «Соцсети»: connect / disconnect / status (account name, token expiry, the network's publishing limit). The OAuth
  callback is a fixed redirect URI registered in each developer app (risk R1), bound to a signed, single-use `state`
  (channel + network + nonce), not to the browser session. Connect, disconnect and anything touching tokens are Mac-only
  (BL-251 remote gate list); viewing the queue and approving a post from the phone is allowed only if the owner says so
  (Q2b).
- **Post request (a «пост»):** channel, clip (a file in the channel folder, checked by the shared
  `workspace-exchange.resolveWorkspaceFile` like clip reviews; size + SHA-256 kept), networks, per-network caption
  (hashtags included), link (default: the channel's YouTube URL), optional schedule time. Validation per network before
  queuing: duration, resolution 9:16, size, caption length, link rules.
- **Approval integrity:** an approval binds a content hash (clip SHA-256, per-network captions, networks, link,
  schedule); any change after approval voids it, exactly like plan-slot approvals. **Dry-run:** every post can be
  validated and previewed per network (what would be sent, without the token or a network call).
- **Approval:** the Producer proposes (`producer_social_post_submit` / `_list` / `_get` / `_withdraw`: DRAFT/READ only);
  the owner approves in the Web UI (Media → «Соцсети», like «Клипы»: player, captions per network, «Одобрить» /
  «Вернуть» with a comment). No MCP or agent path can approve or post (boundaries test). Owner decision Q2 may change this.
- **Runner:** after approval, one job per network on one computer only: cross-posting has its own «этот компьютер
  публикует в соцсети» switch (not publishing's automatic-upload switch — §M independence), so two computers never post
  the same clip. States: queued → uploading → processing → published | failed. Idempotent: a job
  that already has a remote post id is never re-posted; a retry resumes or re-checks status first. Failure of one network
  never blocks the others.
- **Verification + audit:** after publish, read the post back (id, permalink, status); the permalink is stored and shown;
  every step goes to the audit log (`social:<postId>:<network>`). Deleting a published post is a separate owner action,
  not part of v1.
- **Storage:** a sync family `social_posts` (Automerge doc per channel, like clip reviews), so both computers see the same
  queue and decisions; job execution state stays local to the computer that runs it.
- **Analytics (later stage):** per-network views read back where the API offers it; YouTube «External» traffic is already
  collected by YTM.

## Stages

1. Gateway skeleton + switch + inventory test; Settings «Соцсети» with OAuth connect for **Meta** (Instagram + Facebook +
   Threads) in the Meta app's development mode (posts visible to the app's own testers only).
2. Post request + Producer tools + owner approval screen + runner for Instagram and Facebook Reels; first real post to the
   owner's own account while the app is still in development mode.
3. TikTok (private-account posts until the audit passes), Pinterest (Trial until Standard), Threads (after R3 is solved).
4. X (if chosen); per-network analytics read-back.

Developer-app applications (Meta, TikTok, Pinterest) are submitted by the owner at stage 1; reviews take days to weeks and
run in parallel with the code. I prepare the texts and the demo video each review asks for.

## Acceptance criteria (stage 1–2; written before code, from this plan)

- AC-XP-1 No file outside `src/lib/social-gateway/` reaches graph.facebook.com, graph.threads.net, rupload.facebook.com,
  open.tiktokapis.com, api.pinterest.com or api.x.com (inventory test).
- AC-XP-2 With «Публикация в соцсети» off, every publish call fails before any network request (`social_posting_disabled`),
  even for an approved post.
- AC-XP-3 A token is never returned by any API/MCP answer or written to a log; status shows only account name, expiry and
  `connected: true/false`.
- AC-XP-4 The Producer can submit, list, get and withdraw; no MCP tool can approve, post or delete. A post without the
  owner's approval is never sent.
- AC-XP-5 Validation refuses, before queuing: a clip outside the channel folder, not 9:16, longer than the network allows,
  a caption over the network's limit; each with its own error code.
- AC-XP-6 The runner posts each approved network once: a job with a remote id is not re-posted after a restart; one
  network's failure leaves the others' results intact.
- AC-XP-7 After publish the post is read back; the permalink and status are stored; the audit has upload, publish and
  verify events.
- AC-XP-8 Wrong account: if the connected account is not the one stored for that channel and network, the post is refused
  (`social_account_mismatch`) — the same fail-closed rule as YouTube channel identity.
- AC-XP-9 Only the computer whose cross-posting switch is on runs jobs; the other one shows the queue read-only.
- AC-XP-10 Changing the clip file, a caption, the network list, the link or the schedule after approval voids the approval
  (hash mismatch → `social_approval_stale`); nothing is posted until it is approved again.
- AC-XP-11 Dry-run returns the per-network payload preview and the validation result, makes no network call and
  contains no token.
- AC-XP-12 Connect / disconnect / token routes refuse remote (phone) requests; an OAuth callback with a missing, reused
  or foreign `state` is refused.
- AC-XP-13 A channel only ever posts to the networks it connected; the per-channel list is the user's setting.
- AC-XP-14 AI disclosure on by default (Producer 2026-11-14: our narration is an ElevenLabs voice; Meta requires labelling
  realistic AI audio, ElevenLabs music terms ask for platform disclosure): every post carries the network's AI-generated
  content flag where its API has one; where it has none (to be checked against the docs at stage 2, UNVERIFIED for the
  Instagram/Facebook publishing APIs), the approval screen says so and the caption carries the channel's AI note. Never the
  Instagram profile-level "AI-generated" toggle (that is for synthetic personas).

## Risks

- R1 OAuth redirect: networks require registered redirect URIs; stage 0 checks which accept `http://localhost`. Fallback:
  the owner's Tailscale HTTPS name (BL-251) — but that callback arrives as a remote request without the Mac's session, so
  it is authorised only by the signed single-use `state`, never the cookie.
- R2 Reviews may be refused or slow; until then posts are private/test-only. The module still works end to end in that mode.
- R3 Threads needs a public video URL: options (a) skip Threads, (b) a short-lived public link from cloud storage the owner
  already uses (RunPod S3), deleted after publish. Owner decision if Threads is wanted.
- R4 Network rules change (limits, required fields): every limit lives in one per-network constants file with its source
  URL and check date; TECHNICAL_DEBT entry with a re-check trigger.
- R5 New outbound network exposure (TECHNICAL_DEBT network gate): calls go only to the listed hosts through the gateway.

## Not in scope (v1)

Deleting or editing published posts; comments/DMs; paid promotion; third-party posting services; automatic posting without
the owner's approval (unless the owner decides so in Q2); channel worker or factory agents posting.

## Open owner decisions

- Q1 Networks — **answered** (msg 4245): every network with an API; each channel connects its own in the UI.
- Q2 Approval: every post approved by the owner in YTM (proposed), or automatic after the Producer queues it?
  Q2b: may a post be approved from the phone (BL-251)?
- Q3 Developer accounts: Meta for Developers, TikTok for Developers, Pinterest Developers, X Developer — created by the
  owner (stage 0).

## Stage 0 findings — official docs (2026-11-14, before any code)

| Network | Public posts to the owner's own accounts without a review? | Evidence (official) | Plan |
|---|---|---|---|
| Instagram | **Yes** — an app "only for a business I own or manage" gets Standard Access, App Review "Not required"; accounts must belong to people with a role on the app; 100 API posts / 24 h | developers.facebook.com instagram-platform/app-review, graph-api access-levels | **go**: Facebook Login for Business (needed for `upload_type=resumable` → rupload.facebook.com, a local file, no public URL) |
| Facebook Page Reels | Unclear — no Pages Reels doc found (404) | — | probe at stage 1 |
| Threads | Yes for **Threads testers on the app** (no advanced access) — the owner's own Threads account added as a tester | developers.facebook.com threads/posts | go, but video only by a **public `video_url`** (R3) |
| TikTok | **No** — "All content posted by unaudited clients will be restricted to private viewing mode"; public needs the Content Posting audit (acceptance of a single-owner tool not stated) | developers.tiktok.com content-posting-api | private-only until an audit; redirect URIs must be `https` (no localhost) |
| Pinterest | **No** — Trial pins are "only visible to their creator"; Standard is reviewed, needs a demo video and a privacy policy on a public domain clearly tied to the app (single users still reviewed) | developers.pinterest.com access-tiers | blocked until there is a public privacy-policy page |
| X | Yes in principle (own account, `tweet.write` + media upload); pay-per-use; price not stated in the docs read | docs.x.com create-post, getting-access | go (paid) |

Consequences: stage 1 = Meta only (Instagram first) as a vertical slice; no generic six-network abstraction yet. Stage 1
alone posts nothing, so it stays on the branch and merges together with stage 2 (first real post). TikTok and Pinterest:
the owner decides whether to apply for the reviews (TikTok audit; Pinterest needs a public privacy policy page).
