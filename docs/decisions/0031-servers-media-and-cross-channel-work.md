# 0031. Servers and Media, other channels' work, plan move, reviewing from two computers

Status: Accepted

**Date:** 2026-10-08.

**Requested** by the Factory Operator on the owner's proposal in FO-REQ-0009, with the follow-up answer FO-MSG-0011.

**Decided** by the owner in Telegram on 2026-10-08:
- msg 2119: the bell lists only channels that are not active, and everything ships on one branch;
- msg 2121: a missing file during a plan move is an error;
- msg 2125: go ahead.

Plan and acceptance criteria: `docs/roadmap/plans/SERVERS_MEDIA_PLAN.md` (BL-157). This ADR extends ADR 0004, ADR 0029 and ADR 0028.

## Context

The owner now runs two music channels at once.

- Production was one section for every channel. Its plans, review queue and badge mixed the channels' tracks.
- Work waiting in a channel that was not active stayed invisible.
- One plan held the Japan music under the Tropico channel.
- The owner reviews long queues on two computers at once, and a track could be rated on both.

## Decision

1. **Production is two sections.**
   - **Servers** holds the shared infrastructure: sessions of every channel (by channel name, with a filter), models, templates
     and setup.
   - **Media** holds the active channel's plans, review and jobs.
   - The Media routes resolve the active channel on the server, per ADR 0004 (b). A plan of another channel is `not_found`.
   - Old `/production/...` addresses redirect.
2. **Exception to ADR 0004: counts of other channels.**
   - `GET /api/generation-plans/summary` returns every connected channel's open Media work: waiting counts, the waves' counts
     and the plans' notices.
   - The channel switcher shows each channel's waiting count. The bell lists the channels that are not active.
   - Only counts and names cross the channel boundary: the titles of plans, waves and stages, and the kind of each notice.
     Tracks, files, verdicts and the rest of the plan stay behind ADR 0004's filter. That includes the verdicts sent from here,
     which the peers route filters too.
   - The owner asked for this so that another channel never stays silent.
3. **A plan moves to another channel: `factory_plan_move`, Factory API 1.8.0.**
   - Every reported `auditionFile` and every reference must already exist in the target channel's Sent to YTM. One missing file
     refuses the move and lists the missing files.
   - The move is refused while the plan has an unfinished job.
   - History is untouched, because jobs, sessions, results and events are read by plan id.
   - After the move, a job's own output still plays from the channel the job ran on (`media_jobs.channel_id`). This holds both
     on this device and on the other device.
4. **The plans report goes to version 2, once for the whole change.**
   - Every level of the report is strict, so any new field makes an older build reject the whole report. Bumping the version
     once makes that a single, named incompatibility: both computers update together.
   - Version 2 adds:
     - on a review entry: `jobChannelId` and `history`;
     - on a plan: `batches`, the waves' context;
     - on a group: `ownerNote`;
     - on the report: `claims`.
   - The reader accepts versions 1 and 2.
5. **Reviewing by wave.**
   - The owner's wave note gets its own field, `ownerNote`, so it no longer overwrites the factory's context in `note`.
   - `group_reviewed` is recorded when the owner's verdicts take a wave's waiting count to zero.
6. **Two computers.**
   - **History.** Every owner verdict is kept, with the device it was given on (schema v69). `owner_verdict` events are derived
     from that history.
   - **Claims.** "Being reviewed here" claims on a track or a wave (schema v70) travel in the report. They are **advisory**: they
     arrive within the sync delay (1.5–3 minutes).
   - **Replacing a verdict needs `replace`.** Any existing verdict counts: one given here, one relayed by the factory, one sent
     from here, or one on its way from another device. The server refuses a replacement without `replace` with
     `plan_verdict_exists` (409), so the confirmation also holds when the screen's data is stale.
   - **A verdict on its way counts as given.** On the owning device, a verdict sent from another device that this device has
     not applied yet counts as given.
   - **Which verdict is newer** is decided by the time the owner gave it, on that device's clock, as before.

## Alternatives rejected

- **A "target channel" on the plan, used only for the Media view.** The plan's files and its future outputs would stay in the
  wrong channel's workspace. The Factory Operator also preferred a real move (FO-REQ-0009 §4).
- **Re-creating the plan on the new channel.** It loses the live job links, the owner's verdicts and events, and the spend
  (FO-MSG-0011 §1).
- **Claims as a lock.** Every exchange between the devices goes through files synced over Syncthing, with no shared server. A
  lock would either block the owner when the other computer is off, or still be a hint. The confirmation (6) and the history
  are what keep a double rating from losing anything.
- **Additive optional fields without a version bump.** An older build would reject the report anyway, because the report is
  strict. That would happen silently, with no "update the app" message.

## Consequences

- **Schema** (both additive and device-local):
  - v69: `generation_plan_verdict_history`;
  - v70: `generation_plan_review_claims`.
- **Factory API 1.8.0** (additive): `factory_plan_move`, `plan_moved`, `group_reviewed`, `ownerNote`, and `owner_verdict` per
  verdict with `device`.
- **New error code:** `plan_verdict_exists` (409).
- **Two devices must run the same version.** Until both do, each shows the other's last version 1 report, then marks it stale.
- **Claims can be missed.** A track opened on both computers within the sync delay can still be rated twice. The second rating
  asks first if the first has arrived, and the history keeps both. See `docs/TECHNICAL_DEBT.md` RISK-114.
