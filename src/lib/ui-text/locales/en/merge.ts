// BL-152: Merge -- device handoff and the divergence between the two computers.
export const merge = {
  "handoff.family.changeDrafts": "Change drafts",
  "handoff.family.editorialProfiles": "Editorial profiles",
  "handoff.family.aiConnections": "AI connections",
  "handoff.family.mediaSessions": "RunPod sessions",
  "handoff.family.generationPlans": "Generation plans",
  "handoff.family.mediaSettings": "Servers settings",

  "handoff.requestFailed": "Request to {url} failed ({status})",
  "handoff.justNow": "just now",
  "handoff.minutesAgo": "{count, plural, one {# minute ago} other {# minutes ago}}",
  "handoff.hoursAgo": "{count, plural, one {# hour ago} other {# hours ago}}",
  "handoff.daysAgo": "{count, plural, one {# day ago} other {# days ago}}",

  "handoff.error.loadStatus": "Failed to load status",
  "handoff.error.listSnapshots": "Failed to list snapshots",
  "handoff.error.loadSyncStatus": "Failed to load sync status",
  "handoff.error.loadConflicts": "Failed to load conflicts",
  "handoff.error.loadAiConflicts": "Failed to load AI-connection conflicts",
  "handoff.error.syncFailed": "Sync failed",
  "handoff.error.adoptFailed": "Failed to adopt peer's version",
  "handoff.error.exportFailed": "Export failed",
  "handoff.error.importFailed": "Import failed",
  "handoff.error.acknowledgeFailed": "Failed to record acknowledgement",

  "handoff.subject.change": "change {id}",
  "handoff.subject.editorialProfile": "editorial profile",
  "handoff.subject.connection": "connection {id}",

  "handoff.summary.changeDrafts":
    "Change drafts: {pushed}/{total, plural, one {# channel} other {# channels}} pushed, merged from {peers, plural, one {# other device} other {# other devices}}, {conflicts, plural, one {# new conflict} other {# new conflicts}}.",
  "handoff.summary.changeDraftsFailed": "Change drafts: failed ({error}).",
  "handoff.summary.profiles":
    "Editorial profiles: {pushed} pushed, {conflicts, plural, one {# new conflict} other {# new conflicts}}.",
  "handoff.summary.profilesFailed": "Editorial profiles: failed ({error}).",
  "handoff.summary.connectionsPushed": "AI connections: pushed, {conflicts, plural, one {# new conflict} other {# new conflicts}}.",
  "handoff.summary.connectionsNothing":
    "AI connections: nothing to push, {conflicts, plural, one {# new conflict} other {# new conflicts}}.",
  "handoff.summary.connectionsFailed": "AI connections: failed ({error}).",

  "handoff.adopted": "Adopted device {device}'s version. Your previous local copy was backed up to {path}.",
  "handoff.adoptedNoBackup": "Adopted device {device}'s version (there was no local copy to back up).",
  "handoff.exported":
    "Exported as snapshot {snapshot} (generation {generation}). This only records that export finished on this device -- it does not confirm any other device has stopped.",
  "handoff.imported.recovery":
    "Imported, but this device now has unresolved YouTube operation state -- restricted recovery mode is active. See below.",
  "handoff.imported.duplicate": "This snapshot is already the current state on this device -- nothing changed.",
  "handoff.imported.ok": "Imported and activated normally.",

  "handoff.recovery.title": "Restricted recovery mode",
  "handoff.recovery.body":
    "This device has {count, plural, one {# batch execution row} other {# batch execution rows}} with an uncertain YouTube write outcome (imported from a snapshot). Every mutating action — local state and YouTube writes alike — is refused until this is resolved through the existing recovery mechanism. Acknowledging below only records that you have reviewed this; it never changes any row’s status or lifts this restriction by itself.",
  "handoff.recovery.row": "batch {batch} / video {video}: {status}",
  "handoff.recovery.recording": "Recording…",
  "handoff.recovery.acknowledge": "I've reviewed this (acknowledge only)",

  "handoff.syncStatus.title": "Sync status",
  "handoff.syncStatus.intro":
    "Change Sets, editorial profiles, and AI connections each sync continuously in the background between devices sharing the configured Syncthing folder (Settings → Sync; checked automatically every minute while this app is open) — the button above just runs all three cycles immediately. A conflict below means two devices edited the same field while offline; nothing is ever picked automatically — choose which version to keep when one appears.",
  "handoff.syncStatus.failed": "Failed",
  "handoff.syncStatus.never": "Never synced",
  "handoff.syncStatus.ok": "Ok",
  "handoff.syncStatus.conflicts": "{count, plural, one {# conflict} other {# conflicts}}",

  "handoff.pushErrors.title": "Sync folder unreachable for {count, plural, one {# item} other {# items}}",
  "handoff.pushErrors.hint":
    "Nothing local was lost — this device’s changes just weren’t published this cycle. Check that the Syncthing folder (Settings → Sync) is actually mounted/reachable.",
  "handoff.peersSkipped.title":
    "{count, plural, one {# peer device file} other {# peer device files}} could not be merged this cycle",
  "handoff.peersSkipped.row": "{family}{channel}, device {device}: {reason}",
  "handoff.peersSkipped.adopt": "Discard my local copy, adopt this device’s version",
  "handoff.peersSkipped.switchChannel": "Switch to this channel to resolve it here.",
  "handoff.peersSkipped.hint":
    "A field-level conflict (below) is not the same as this — this means this device and that one share no common history at all and can never be automatically combined (e.g. a corrupted file, or two devices that started this data independently). Only “divergent history” entries can be resolved here, by explicitly discarding one side; any other reason (e.g. a corrupted file) will keep being retried automatically on its own.",

  "handoff.adoptConfirm.title": "Discard local copy and adopt peer's version?",
  "handoff.adoptConfirm.body":
    "This permanently replaces this device's local {family} with device {device}'s version. Your current local copy is backed up to a file first (never deleted outright), but this action itself cannot be undone through this screen.",
  "handoff.adoptConfirm.adopting": "Adopting…",
  "handoff.adoptConfirm.confirm": "Discard and adopt",

  "handoff.title": "Device handoff",
  "handoff.intro":
    "A separate mechanism from the continuous sync above -- an explicit, one-at-a-time transfer of ownership for the YouTube write pipeline (batches, their execution ledger, and the audit trail), which cannot sync continuously in the background.",
  "handoff.export.title": "Finish work on this device",
  "handoff.export.body":
    "Exports a scrubbed snapshot (never includes OAuth tokens or AI connection credentials) into the configured Syncthing folder (Settings → Sync). This records that export finished here — it does not and cannot confirm any other device has stopped.",
  "handoff.export.busy": "Exporting…",
  "handoff.export.button": "Export handoff",
  "handoff.import.title": "Continue work on this device",
  "handoff.import.body":
    "Available snapshots in the configured folder. Importing never resumes an in-progress/uncertain YouTube write automatically.",
  "handoff.import.none": "No snapshots found.",
  "handoff.import.snapshot": "{snapshot} (device {device}, gen {generation}, {time})",
  "handoff.import.busy": "Importing…",
  "handoff.import.button": "Import",

  "divergence.title": "Data differs between the two computers",
  "divergence.intro":
    "This is the snapshot sync of Batches, the audit trail, Research and Decisions — whole copies, one history. Since the two computers last agreed, both changed this data, so one version has to be chosen. Change Sets, profiles and AI connections are not affected (their conflicts are listed below).",
  "divergence.thisComputer": "This computer",
  "divergence.otherComputer": "The other computer",
  "divergence.device": "device {id}",
  "divergence.unknownDevice": "unknown",
  "divergence.unknownTime": "unknown time",
  "divergence.lastPublished": "last published {time}",
  "divergence.published": "published {time}",
  "divergence.unpublished": "Has changes not published yet.",
  "divergence.commonBase": "Both continue from the version of {time}; everything below changed after it.",
  "divergence.comparing": "Comparing the two versions…",
  "divergence.compareFailed": "Could not compare the two versions: {error}",
  "divergence.nowSame": "The two versions now hold the same data; this resolves itself on the next sync.",
  "divergence.manyTips":
    "{count, plural, one {# other version is} other {# other versions are}} in conflict; this compares with the newest one only. “Keep this computer's data” replaces all of them.",
  "divergence.column.section": "Section",
  "divergence.column.onlyHere": "Only on this computer",
  "divergence.column.onlyThere": "Only on the other",
  "divergence.column.changed": "On both, but different",
  "divergence.section.batches": "Batches",
  "divergence.section.audit": "Audit",
  "divergence.section.research": "Research",
  "divergence.section.decisions": "Decisions",
  "divergence.section.other": "Other",
  "divergence.sectionHint.batches": "prepared and executed Batches and their per-video rows",
  "divergence.sectionHint.audit": "the record of YouTube writes",
  "divergence.sectionHint.research": "Market Intelligence: research channels and their collected snapshots",
  "divergence.sectionHint.decisions": "hypotheses and experiments",
  "divergence.sectionHint.other": "other transferred data",
  "divergence.tableCounts": "{table}: +{here} here / +{there} there / {changed} changed",
  "divergence.rows": "{count, plural, one {# row} other {# rows}}",
  "divergence.identical": "Identical on both computers: {sections}.",
  "divergence.keepMine": "Keep this computer's data",
  "divergence.keepMineHint": "The other computer switches to this version.",
  "divergence.keepMineHintLoses":
    "The other computer switches to this version. It loses {count, plural, one {# row} other {# rows}} (kept there in a backup).",
  "divergence.takeTheirs": "Take the other computer's data",
  "divergence.takeTheirsHint": "This computer switches to the other version.",
  "divergence.takeTheirsHintLoses":
    "This computer switches to the other version. It loses {count, plural, one {# row} other {# rows}} (a backup is saved first).",
  "divergence.confirmKeep.title": "Keep this computer's data?",
  "divergence.confirmKeep.body":
    "This computer's Batches, audit trail, Research and Decisions data will replace the other computer's the next time it syncs.",
  "divergence.confirmKeep.bodyLoses":
    "This computer's Batches, audit trail, Research and Decisions data will replace the other computer's the next time it syncs. The other computer loses {count, plural, one {# row} other {# rows}} listed above; they stay in a backup there.",
  "divergence.confirmKeep.confirm": "Keep mine",
  "divergence.confirmTake.title": "Take the other computer's data?",
  "divergence.confirmTake.body":
    "This computer's Batches, audit trail, Research and Decisions data will be replaced by the other computer's. A backup of this computer's current data is saved first.",
  "divergence.confirmTake.bodyLoses":
    "This computer's Batches, audit trail, Research and Decisions data will be replaced by the other computer's. This computer loses {count, plural, one {# row} other {# rows}} listed above. A backup of this computer's current data is saved first.",
  "divergence.confirmTake.confirm": "Take theirs",
} as const;
