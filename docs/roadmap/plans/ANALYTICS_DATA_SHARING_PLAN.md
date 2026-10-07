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
- **Retention.** A device prunes its own files older than 45 days, the same window as the quota ledger. Older history stays in each device's database.

## Acceptance criteria (written before the code)

- AC-AD-01: after device A collects channel X today, device B, once A's file has arrived, (a) has A's rows for X and (b) does not collect X again today: the existing staleness check says current. This also covers channels other than B's active one.
- AC-AD-02: importing the same file twice changes nothing. A row present on both devices with different values keeps the one with the newer `collectedAt`.
- AC-AD-03: Reach: B counts A's check of channel X within 6 h as its own and never downloads a report A has already imported.
- AC-AD-04: files contain only the listed tables' rows, with no credential or URL. A device never writes into another device's folder, and an invalid or foreign-named file is skipped with a reason in the Merge tab, as other families do.
- AC-AD-05: with the family unavailable (no sync folder), analytics and reach collect locally exactly as today (§M).
- AC-AD-06: the loading window's Analytics and Reach lines say "already collected on the other computer" when the import made the collection unnecessary.
