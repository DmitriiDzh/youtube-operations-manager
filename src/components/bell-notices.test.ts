import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator } from "@/lib/ui-text";
import { diskNoticeEntry, liveNoticeEntries, type LiveNotice } from "./bell-notices";

// BL-262 (owner msgs 4541/4542/4545, 2026-11-16): this computer's own bell notices get a group icon, an urgency (red where the
// owner has to act, sky for information), a short text and the full text on hover. Expected texts are the owner-approved
// wording, written by hand, not taken from running the code.
const ru = createTranslator("ru");
const en = createTranslator("en");

// 16.11.2026 09:05 local time -- the bell shows times in the local zone as DD.MM.YYYY HH:MM.
const since = new Date(2026, 10, 16, 9, 5).getTime();
const notice = (kind: LiveNotice["kind"], detail?: string): LiveNotice => ({ channelId: "UC_live", kind, since, detail });

test("live streams: the short texts, each opening the channel's «Трансляции» tab; a missing source is information, the rest need the owner", () => {
  const entries = liveNoticeEntries(ru, [
    notice("live_stream_down"),
    notice("live_stream_ended"),
    notice("live_segment_switch_failed"),
    notice("live_stream_source_missing", "abc123XYZ_-"),
  ]);
  assert.deepEqual(
    entries.map((e) => [e.text, e.group, e.severity, e.channelId, e.href]),
    [
      ["Не в эфире с 16.11.2026 09:05", "live", "action", "UC_live", "/content/streams"],
      ["Завершена YouTube: начать новую", "live", "action", "UC_live", "/content/streams"],
      ["Сегмент не переключился", "live", "action", "UC_live", "/content/streams"],
      ["Нет видео abc123XYZ_- на Mac", "live", "info", "UC_live", "/content/streams"],
    ]
  );
  // The full text stays on hover: when YouTube ended it, and that the copied videos replay.
  assert.equal(entries[1].detail, "YouTube завершил трансляцию в 16.11.2026 09:05: начните новую.");
  assert.equal(entries[3].detail, "Следующего видео (abc123XYZ_-) нет на Mac: по кругу идут уже скопированные.");
  assert.equal(new Set(entries.map((e) => e.key)).size, 4, "one key per channel and kind");
  assert.equal(liveNoticeEntries(en, [notice("live_stream_down")])[0].text, "Off air since 16.11.2026 09:05");
  assert.deepEqual(liveNoticeEntries(ru, []), []);
});

test("disk: «Мало места: {free}», an action, no channel, opening Servers → Sessions; the threshold is in the hover text", () => {
  const entry = diskNoticeEntry(ru, { freeBytes: 12_300_000_000, thresholdGb: 20, since: "2026-11-16T09:00:00.000Z" });
  assert.deepEqual([entry.text, entry.group, entry.severity, entry.channelId, entry.href], ["Мало места: 12.3 ГБ", "disk", "action", null, "/servers/sessions"]);
  assert.equal(entry.detail, "Мало места на диске этого компьютера: свободно 12.3 ГБ, меньше 20 ГБ.");
  assert.equal(diskNoticeEntry(en, { freeBytes: 5_000_000_000, thresholdGb: 20, since: "" }).text, "Low disk space: 5.0 GB");
});
