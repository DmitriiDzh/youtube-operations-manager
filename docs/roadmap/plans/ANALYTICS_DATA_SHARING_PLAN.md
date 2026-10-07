# Analytics and reach data shared between devices (BL-151)

**Decided** by the owner in Telegram on 2026-10-07:
- msg 2004: "при запуске инструмента прогонялась проверка обновления всех данных аналитики и research по всем каналам ... учитывать мердж с другого компьютера и когда это делалось там, чтобы не запрашивать одни и те же данные 2 раза";
- msg 2008: same branch as BL-149.

Research data already travels in the device-sync snapshot, and its staleness check already sees the other computer's collections.

## Today

All of these are device-local (`SNAPSHOT_DEVICE_LOCAL_TABLES`), so each computer collects every channel itself once a day (RISK-52):
- Analytics: `video_metrics_daily` (45,780 rows on the Mac), `channel_metrics_daily` (452), `analytics_video_history` (98), `analytics_collection_runs`, and the stamp `channels.analytics_last_auto_collected_at`.
- Reach: `channel_reach_daily` (1,880), `reporting_report_files` (73), `reporting_jobs`, `reporting_sync_attempts`.

Skipping a collection because "the other device did it" would leave this device without the data. The data itself has to travel.

## Design

- **A new sync-gateway family `analytics-data`, append-only per device.**
  - Each device writes only its own files under `<Syncthing root>/analytics-data/<deviceId>/`: one JSON-lines file per day, holding the rows it collected (or downloaded) that day.
  - Each file is written atomically and replaced only by the same device.
  - Peers read other devices' files read-only, the same model as `quota-ledger-sync` and change-drafts' per-device files.
  - Rows carry their table, primary key, values and `collectedAt`. No token, key or URL is in a row.
- **Import is idempotent.**
  - A row is upserted by its primary key.
  - When both devices hold the same key with different values, the row with the newer `collectedAt` wins. These are YouTube's numbers fetched twice, not something the owner wrote, and YouTube revises recent days, so the later read is the better one. No conflict is shown.
  - Each imported file is remembered by name, size and hash, so it is read once.
- **Freshness travels with the data.**
  - A peer's `analytics_collection_runs` row for a channel, and its auto-collected-at stamp, are imported, so this device's existing staleness check (`isAnalyticsCollectionStale`) sees that the channel was collected today.
  - For Reach, the peer's checked-at time and its downloaded report ids are imported. The 6 h due check then counts the peer's check, and an already imported report file is never downloaded again.
  - Weekly reports stay device-local. They are rebuilt from the now shared metrics.
- **Import before collecting.**
  - `auto-collect-all` and `reach/sync-all` first import whatever peer files have arrived. The same rule as Research's sync-before-collect applies: an import still running means the collection waits for the next load.
  - The device that collects writes its file at once, so the other device sees it on its next sync.
  - Two devices opening at the same minute can still both collect. That is rare, and the result is identical rows.
- **Unknown videos.** A video metrics row for a video this device has not synced yet is skipped. `video_metrics_daily` references `videos` on a fresh schema, and one unknown video must not fail the whole import. The device's own channel sync adds the video; its metrics for those days then come from that device's own collection.
- **Retention.** A device prunes its own files older than 45 days, the same window as the quota ledger. Older history stays in each device's database.

## Acceptance criteria (written before the code)

- AC-AD-01: after device A collects channel X today, device B, once A's file has arrived, (a) has A's rows for X and (b) does not collect X again today: the existing staleness check says current. This also covers channels other than B's active one.
- AC-AD-02: importing the same file twice changes nothing. A row present on both devices with different values keeps the one with the newer `collectedAt`.
- AC-AD-03: Reach: B counts A's check of channel X within 6 h as its own and never downloads a report A has already imported.
- AC-AD-04: files contain only the listed tables' rows, with no credential or URL. A device never writes into another device's folder, and an invalid or foreign-named file is skipped with a reason in the Merge tab, as other families do.
- AC-AD-05: with the family unavailable (no sync folder), analytics and reach collect locally exactly as today (§M).
- AC-AD-06: the loading window's Analytics and Reach lines say "already collected on the other computer" when the import made the collection unnecessary.

## Changes after the independent review (2026-10-07)

- **Import transactions.** The import runs in short atomic batches, never as one long transaction with awaits inside it. libsql works synchronously on the one Node thread, so a long transaction made other writers fail with SQLITE_BUSY.
- **A channel with unknown videos is incomplete.** If any of its rows name a video this device has not synced, or the peer saw no videos while this device has some, the channel's stamp and runs are not imported. This device's own check then still collects it.
  - Its file is applied again once this device has synced more videos.
  - A history marker is imported only for a video stored here, and only when it reaches a later date.
- **Imported files are remembered persistently** (`app_settings`), so a restart does not import 45 days of files again.
- **Import still running.** If the peers' rows are still being imported after 2 minutes, this load does not collect; the next load does. It never collects in parallel with the import.
- **Reach.**
  - A peer's report goes through the same period-replacement rule as one downloaded here.
  - Only a peer's successful check is taken over.
- **Pausing.** The 2-minute exchange pauses during a snapshot import, a migration or recovery mode.
- **Known.** Imported rows keep their collection time, so the receiver re-exports them in its own day file ("echo"). It is harmless, because a repeated import changes nothing, but it roughly doubles a day file. A per-row origin column would remove it; not done now.
