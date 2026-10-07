# Production → Setup settings, the same on every device (BL-150)

**Decided** by the owner in Telegram on 2026-10-07, msg 2008: "Настройки Production - Setup тоже должны синхронизироваться. Чтобы были одинаковыми на обоих устройствах. Включая список Fallback GPU types". It is delivered on the same branch as BL-149 (`feature/app-routes`) and merged with it.

## Today

`MediaSettings` (`src/lib/media-generation/contracts.ts`) is one JSON value in this device's `app_settings`, which is device-local. Every device has its own:
- GPU, cloud type, datacenter, network volume, pod template;
- spend and session limits;
- GPU fallback list and capacity retry;
- factory limits;
- "release when done".

Both of the owner's computers report the same RunPod account (`runpodAccountId` in the BL-138 sessions reports, checked 2026-10-07).

## Design

- **What is shared.** Every `MediaSettings` field except `gpuOnDemandPricePerHr`, which is derived: the receiving device re-prices from RunPod's catalog when it applies a GPU.
- **What is not shared.** The RunPod/S3 keys and their exchange stay as they are (encrypted export/import, ADR 0027).
- **Transport: a new sync-gateway family `media-settings`.** It is one global Automerge document, shaped like `editorial-profile` and `ai-connections-catalog`: the same runner, the same Syncthing subfolder convention, and the same conflict detection.
  - A field edited on both devices before they met is a conflict, never resolved silently. It is listed in the Merge tab like the other families' conflicts.
  - Until the owner picks a value, the Automerge winner is used, as with editorial profiles.
- **The receiving device applies settings through Production's own rules.** `media-generation` owns this; `sync-gateway` never imports it.
  - On the media watcher tick, `media-generation` reads the merged document and applies the fields that differ through the same validation as an edit in the UI.
  - **Volume and datacenter.** These change only while the volume is free, the existing `assertVolumeFree` guard. Otherwise they wait for a later tick, and the Setup page shows "waiting: a session or transfer is using the volume".
  - **Live catalog checks.** The GPU type, datacenter, volume and template are checked against RunPod's catalog as today. A value that fails is not applied, and the reason is shown in Setup. Every other field is still applied.
  - **Account-bound fields** (network volume, datacenter, pod template) are applied only when both devices report the same RunPod account id. Otherwise they are skipped with a note.
- **Local edits are published.** `updateSettings` writes the changed fields into the document after its own validation succeeds.
- **Bootstrap.** The first time, an empty document is filled from this device's current settings. Two devices that both had settings before then produce conflicts only for the fields that actually differ, and the owner picks those once.
- **Audit.** Each applied peer change is recorded as a media control event (`settings_applied_from_peer`, with the fields).

## Acceptance criteria (written before the code)

- AC-MS-01: a setting saved in Setup on device A appears in Setup on device B after A's and B's sync cycles, through the merged document. The fallback GPU list is included, in its order.
- AC-MS-02: a received change passes the same validation as a local edit. An invalid value (a GPU not in the catalog, Community cloud with a volume) is not applied; the reason is visible, and the other fields are still applied.
- AC-MS-03: a received volume or datacenter change is never applied while this device's volume is in use (an open session, transfer or pull). It is applied on a later tick once the volume is free.
- AC-MS-04: account-bound fields are not applied when the account ids differ or either one is unknown.
- AC-MS-05: concurrent edits of the same field on both devices are listed as a conflict in Merge. Different fields edited on both devices merge without a conflict.
- AC-MS-06: the keys and `gpuOnDemandPricePerHr` are never in the document.
- AC-MS-07 (§M): `media-generation` reaches the family only through the `sync-gateway` barrel, and the family imports nothing from `media-generation`. If the family is unavailable, Production works on its local settings as today.
