import type { youtube_v3 } from "googleapis";
import { getLiveWritesEnabled } from "@/lib/db";
import {
  mapPlaylistMetadata,
  type PlaylistMetadata,
  type PlaylistPrivacyStatus,
} from "@/lib/youtube";
import { DomainError, type LocaleMetadata } from "./contracts";

// ---------------------------------------------------------------------------
// The single funnel for every outbound YouTube WRITE call (owner instruction, 2026-09-21:
// "Делаем новый модуль, который будет отвечать за отправку какой-либо информации на
// YouTube. Он должен быть единственным путем как информация может попасть в 'релиз'...
// Никакие будущие модули не имеют права записывать / изменять / отправлять данные на
// YouTube в обход этого модуля"). No other file in this repository may call
// `videos.update`, `playlists.insert/update/delete`, or `playlistItems.insert/delete` --
// enforced mechanically by `gateway-inventory.test.ts`, not by convention alone.
//
// This module intentionally stays a thin, dependency-injected wrapper around the
// `youtube_v3.Youtube` client (AGENTS.md §D -- one YouTube client, reused, never a
// parallel implementation): every function here takes an already-authorized client and
// makes exactly the request its name says, nothing more. Two things this module does
// NOT do, on purpose:
//   - It does not resolve credentials or OAuth scope -- that stays the caller's job
//     (each domain module's `services.ts` already resolves `YOUTUBE_WRITE_SCOPE` via
//     `resolveGoogleCredentials`/`authResolver.resolve` before ever reaching here; moving
//     that here would conflate "is this call authorized" with "is this call physically
//     the only place data can reach YouTube", which are different concerns).
//   - The identity/channel guardrail (`write-context.assertWriteChannel`) and the
//     read/propose/apply MCP classification stay exactly where `docs/DEVELOPMENT_PLAYBOOK.md`
//     §6.7/§G already put them -- this module is the last stop before the network call,
//     not a replacement for the checks that happen before it.
//
// What this module DOES also own: the shared, single Gate B "live writes" policy check
// (`assertLiveWritesAuthorized`, moved and generalized from `src/lib/batches/adapters/
// write-executor.youtube.ts`). Before this refactor, that check only ever ran for the
// Batches pipeline -- the single-item `apply`/`playlist_*` write paths had no live-write
// barrier at all beyond the identity guardrail (owner-identified gap, 2026-09-21 Telegram
// conversation). Every caller outside `src/lib/batches/` now calls
// `assertLiveWritesAuthorized()` itself immediately before invoking a gateway write
// function (see `video-metadata/adapters/youtube-api.ts`, `video-details/adapters/
// youtube-api.ts`, `playlist-management/adapters/youtube-api.ts`). Batches keeps its own
// pre-existing two-layer barrier unchanged (`write-executor.ts`'s construction gate, plus
// `write-executor.youtube.ts`'s own call-time re-check, which now simply imports this same
// function instead of keeping a second, drifting copy) -- this generalizes the policy
// without collapsing that design.
// ---------------------------------------------------------------------------

export async function assertLiveWritesAuthorized(): Promise<void> {
  if (await getLiveWritesEnabled()) return;

  throw new DomainError({
    code: "live_writes_disabled",
    message:
      "Real YouTube write execution is disabled -- the Settings tab's \"live writes\" toggle is off (defaults off every session, docs/TECHNICAL_DEBT.md RISK-09/Gate B).",
  });
}

/**
 * RISK-11: the exhaustive, documentation-verified list of `snippet` sub-properties the
 * YouTube Data API v3 actually treats as mutable/writable via `videos.update`
 * (developers.google.com/youtube/v3/docs/videos, checked field-by-field 2026-09-18).
 * Everything NOT in this list is read-only (`publishedAt`, `channelId`, `channelTitle`,
 * `thumbnails`, `liveBroadcastContent`) or a separate read-only echo of the
 * `localizations` object (`localized`). This is the single canonical source for every
 * write path in this repository.
 */
export const WRITABLE_SNIPPET_FIELDS = [
  "title",
  "description",
  "tags",
  "categoryId",
  "defaultLanguage",
  "defaultAudioLanguage",
] as const;

export function pickWritableSnippetFields(snippet: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of WRITABLE_SNIPPET_FIELDS) {
    if (field in snippet) result[field] = snippet[field];
  }
  return result;
}

/**
 * `src/lib/video-details/` (Studio-parity "Details" edit) -- writable `status` fields,
 * confirmed against the OFFICIAL "You can set values for these properties" list on the
 * `videos.update`/`videos.insert` reference pages (not merely present in the resource --
 * `madeForKids`, all of `contentDetails.*`, and `defaultAudioLanguage` are readable but
 * NOT in that settable list, and are deliberately excluded here).
 */
export const WRITABLE_STATUS_FIELDS = [
  "privacyStatus",
  "publishAt",
  "license",
  "embeddable",
  "publicStatsViewable",
  "selfDeclaredMadeForKids",
  "containsSyntheticMedia",
] as const;

export function pickWritableStatusFields(status: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of WRITABLE_STATUS_FIELDS) {
    if (field in status) result[field] = status[field];
  }
  return result;
}

/** Only `recordingDate` is settable -- `location`/`locationDescription` are deprecated
 * (2017/2018) and rejected by the live API today; never forwarded even if present. */
export function pickWritableRecordingDetailsFields(
  recordingDetails: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if ("recordingDate" in recordingDetails) result.recordingDate = recordingDetails.recordingDate;
  return result;
}

/**
 * Real `videos.update(part: [snippet, localizations])`. The only physical write call for
 * the title/description localization pipeline (single-item `apply` and, via
 * `src/lib/batches/adapters/write-executor.youtube.ts`, the Batches pipeline). Does NOT
 * itself call `assertLiveWritesAuthorized` -- Batches' own barrier already wraps its call
 * site (`write-executor.youtube.ts`'s `attemptWrite`), and this function must remain the
 * raw, unwrapped primitive for `performYoutubeWrite`'s existing tests, which call it
 * directly to prove it "never bypasses the barrier -- it has none, that is attemptWrite's
 * job". The single-item caller (`video-metadata/adapters/youtube-api.ts`) calls
 * `assertLiveWritesAuthorized()` itself immediately before this function.
 */
export async function applyVideoMetadataUpdate(args: {
  youtube: youtube_v3.Youtube;
  update: {
    videoId: string;
    snippet: Record<string, unknown>;
    localizations: Record<string, LocaleMetadata>;
  };
}): Promise<void> {
  await args.youtube.videos.update({
    part: ["snippet", "localizations"],
    requestBody: {
      id: args.update.videoId,
      snippet: args.update.snippet as youtube_v3.Schema$VideoSnippet,
      localizations: args.update.localizations,
    },
  });
}

/**
 * Real `videos.update` for the video-details module -- sends only the parts the caller
 * actually touched. Every part sent is still the FULL merged object for that part (the
 * YouTube API replaces a part wholesale); the "don't touch untouched fields" guarantee
 * comes from the caller always merging onto a freshly-fetched current value before
 * calling this. Caller (`video-details/adapters/youtube-api.ts`) calls
 * `assertLiveWritesAuthorized()` itself immediately before this function.
 */
export async function applyVideoDetailsUpdate(args: {
  youtube: youtube_v3.Youtube;
  videoId: string;
  parts: {
    snippet?: youtube_v3.Schema$VideoSnippet;
    status?: youtube_v3.Schema$VideoStatus;
    recordingDetails?: { recordingDate?: string | null };
  };
}): Promise<void> {
  const part = Object.keys(args.parts) as Array<keyof typeof args.parts>;
  if (part.length === 0) return;

  await args.youtube.videos.update({
    part,
    requestBody: {
      id: args.videoId,
      ...args.parts,
    },
  });
}

/** Real `playlists.insert`. Caller calls `assertLiveWritesAuthorized()` first. */
export async function createPlaylistForAuthenticated(
  youtube: youtube_v3.Youtube,
  title: string,
  privacyStatus: PlaylistPrivacyStatus = "private",
  description = ""
): Promise<PlaylistMetadata> {
  const res = await youtube.playlists.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: { title, description },
      status: { privacyStatus },
    },
  });

  if (!res.data.id) {
    throw new Error("YouTube create playlist response did not include playlist id");
  }

  return mapPlaylistMetadata(res.data, { title, description, privacyStatus })!;
}

/** Real `playlists.update`. Caller calls `assertLiveWritesAuthorized()` first. */
export async function updatePlaylistForAuthenticated(args: {
  youtube: youtube_v3.Youtube;
  playlistId: string;
  title: string;
  description: string;
  privacyStatus: PlaylistPrivacyStatus;
}): Promise<PlaylistMetadata> {
  const response = await args.youtube.playlists.update({
    part: ["snippet", "status"],
    requestBody: {
      id: args.playlistId,
      snippet: {
        title: args.title,
        description: args.description,
      },
      status: {
        privacyStatus: args.privacyStatus,
      },
    },
  });

  return mapPlaylistMetadata(response.data, {
    title: args.title,
    description: args.description,
    privacyStatus: args.privacyStatus,
  })!;
}

/** Real `playlists.delete`. Caller calls `assertLiveWritesAuthorized()` first. */
export async function deletePlaylistForAuthenticated(
  youtube: youtube_v3.Youtube,
  playlistId: string
): Promise<void> {
  await youtube.playlists.delete({ id: playlistId });
}

/** Real `playlistItems.insert`. Caller calls `assertLiveWritesAuthorized()` first. */
export async function addVideoToPlaylistForAuthenticated(
  youtube: youtube_v3.Youtube,
  videoId: string,
  playlistId: string
): Promise<void> {
  await youtube.playlistItems.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: {
          kind: "youtube#video",
          videoId,
        },
      },
    },
  });
}

/** Real `playlistItems.delete`. Caller calls `assertLiveWritesAuthorized()` first. */
export async function deletePlaylistItemById(
  youtube: youtube_v3.Youtube,
  playlistItemId: string
): Promise<void> {
  await youtube.playlistItems.delete({ id: playlistItemId });
}
