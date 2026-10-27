import { z } from "zod";

// BL-229 part A (FO-REQ-0043 §A; MUSIC_LIBRARY_PLAN.md §2; ADR 0054): the factory's music library snapshot, written per channel to
// `<workspace>/99 Data Exchange/Sent to YTM/music/library.json`. The factory has not sent its real format yet (DEV-RESP-0043
// Q7/Q8), so this file IS the proposal sent to it -- the only place the format is defined:
//
//   {
//     "format": 1,
//     "generatedAt": "2026-10-27T09:00:00Z",                  // ISO 8601 time the factory wrote the snapshot
//     "genres": [{
//       "id": "rural-japan-control",                          // the genre profile's id
//       "title": "Sounds of Rural Japan",
//       "label": "Control",                                   // optional: short label shown beside the title
//       "color": "#4f9d69",                                   // optional: #rrggbb
//       "playlist": "PLW3cmFOp7WbA",                          // optional: the genre's playlist id
//       "status": "active",                                   // "active" | "stub"
//       "batches": 13, "tracks": 390,
//       "seconds": 70200, "neverUsedSeconds": 36000,          // total and never-used duration, in seconds
//       "daysLeft": 41                                        // optional: days of videos left (forecast); null = unknown
//     }],
//     "batches": [{
//       "batch": "001",
//       "genre": "rural-japan-control",                       // a genre id from "genres", or null (a batch without a genre)
//       "playlist": "PLW3cmFOp7WbA", "briefVersion": "3",    // optional
//       "tracks": 30,
//       "date": "2026-09-01",                                 // optional; null = unknown
//       "source": "suno",                                     // optional
//       "reviewed": 30, "accepted": 24                        // optional: tracks the owner reviewed, of them accepted
//     }],
//     "tracksWithoutGenre": 0                                 // tracks no genre profile covers (never used in a mix)
//   }
//
// Unknown extra fields are ignored (the factory may add more). A missing or wrong required field, a genre named twice, a batch
// naming a genre the snapshot does not list, or more accepted than reviewed tracks makes the whole file unreadable -- it is never
// half-shown.

const count = z.number().int().nonnegative();
const seconds = z.number().finite().nonnegative();
const text = z.string().min(1).max(200);

export const musicGenreSchema = z.object({
  id: text,
  title: text,
  label: z.string().max(40).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be #rrggbb").optional(),
  playlist: z.string().max(100).optional(),
  status: z.enum(["active", "stub"]),
  batches: count,
  tracks: count,
  seconds,
  neverUsedSeconds: seconds,
  daysLeft: z.number().finite().nonnegative().nullable().optional(),
});

export const musicBatchSchema = z
  .object({
    batch: text,
    genre: text.nullable(),
    playlist: z.string().max(100).optional(),
    briefVersion: z.string().max(40).optional(),
    tracks: count,
    date: z.string().max(40).nullable().optional(),
    source: z.string().max(100).optional(),
    reviewed: count.optional(),
    accepted: count.optional(),
  })
  .refine((b) => b.accepted === undefined || b.accepted <= (b.reviewed ?? 0), { message: "accepted is more than reviewed", path: ["accepted"] });

export const musicLibrarySnapshotSchema = z
  .object({
    format: z.literal(1),
    generatedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO 8601 time"),
    genres: z.array(musicGenreSchema).max(200),
    batches: z.array(musicBatchSchema).max(5000),
    tracksWithoutGenre: count,
  })
  .superRefine((snapshot, ctx) => {
    const ids = new Set<string>();
    snapshot.genres.forEach((genre, index) => {
      if (ids.has(genre.id)) ctx.addIssue({ code: "custom", message: `genre "${genre.id}" is listed twice`, path: ["genres", index, "id"] });
      ids.add(genre.id);
    });
    snapshot.batches.forEach((batch, index) => {
      if (batch.genre !== null && !ids.has(batch.genre)) ctx.addIssue({ code: "custom", message: `batch "${batch.batch}" names genre "${batch.genre}", which is not in genres`, path: ["batches", index, "genre"] });
    });
  });

export type MusicGenre = z.infer<typeof musicGenreSchema>;
export type MusicBatch = z.infer<typeof musicBatchSchema>;
export type MusicLibrarySnapshot = z.infer<typeof musicLibrarySnapshotSchema>;
