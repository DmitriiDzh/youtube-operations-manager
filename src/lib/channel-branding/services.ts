import { YOUTUBE_READ_SCOPE, YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import {
  DomainError,
  isDomainError,
  type ChannelBrandingActor,
  type ChannelBrandingBody,
  type ChannelBrandingDependencies,
  type ChannelBrandingGetView,
  type ChannelBrandingLastApply,
  type ChannelBrandingLive,
  type ChannelBrandingPreview,
  type ChannelBrandingSaveInput,
  type ChannelBrandingView,
  type LiveChannelBranding,
} from "./contracts";
import {
  CHANNEL_BANNER_MAX_BYTES,
  checkBannerBytes,
  isRelativeExchangePath,
  parseKeywords,
  readStoredDraft,
  sameKeywords,
  serializeKeywords,
  textStatus,
  validateDescription,
  validateKeywords,
  type ChannelBrandingDraft,
  type ChannelBrandingField,
  type ChannelBrandingFieldStatus,
  type ChannelBrandingRefusal,
} from "./draft";

/** Up to 4 reads, 5 s apart, while the channel does not yet show what was written. */
export const CHANNEL_BRANDING_READ_BACK = { attempts: 4, delayMs: 5_000 };

/** `channels.update` and `channelBanners.insert` each cost 50 units (the plan's "API facts", U1/U3/U6). */
const WRITE_UNITS = 50;

/**
 * The `brandingSettings.channel` properties `channels.update` documents as settable (U1). Each is sent back exactly as read; the
 * title is repeated as read (U1: "the channel's current title or omit the property"). Anything else YouTube returns is not sent.
 */
export const SETTABLE_BRANDING_CHANNEL_FIELDS = ["country", "defaultLanguage", "description", "keywords", "trackingAnalyticsAccountId", "unsubscribedTrailer"] as const;

/** The version of a stored draft the owner previewed: the SHA-256 of the stored column (it holds the banner's own SHA-256). */
export function channelBrandingDraftVersion(sha256: (value: string) => string, draftJson: string | null | undefined): string {
  return sha256(draftJson ?? "");
}

/** JSON with object keys sorted, so two reads of the same object compare equal whatever their key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function liveOf(context: LiveChannelBranding): ChannelBrandingLive {
  const branding = context.brandingChannel;
  return {
    title: context.title,
    avatarUrl: context.avatarUrl,
    customUrl: context.customUrl,
    description: str(branding.description) ?? "",
    keywords: parseKeywords(str(branding.keywords)),
    country: str(branding.country),
    defaultLanguage: str(branding.defaultLanguage),
    unsubscribedTrailer: str(branding.unsubscribedTrailer),
    bannerUrl: context.bannerExternalUrl,
  };
}

function parseLastApply(json: string | null | undefined): ChannelBrandingLastApply | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ChannelBrandingLastApply;
  } catch {
    return null;
  }
}

/** What the draft would do to the channel as read: each draft field's status, and whether the banner must be uploaded. */
export function planBranding(draft: ChannelBrandingDraft, live: LiveChannelBranding, lastApply: ChannelBrandingLastApply | null): { fields: Array<{ field: ChannelBrandingField; status: ChannelBrandingFieldStatus }>; uploadBanner: boolean } {
  const current = liveOf(live);
  const fields: Array<{ field: ChannelBrandingField; status: ChannelBrandingFieldStatus }> = [];
  if (draft.description !== undefined) fields.push({ field: "description", status: textStatus(draft.description, current.description) });
  if (draft.keywords !== undefined) {
    const same = sameKeywords(draft.keywords, current.keywords);
    fields.push({ field: "keywords", status: same ? "unchanged" : current.keywords.length === 0 ? "new" : draft.keywords.length === 0 ? "cleared" : "changed" });
  }
  let uploadBanner = false;
  if (draft.banner) {
    // The same image this app already set, still on the channel: nothing to upload. Otherwise it is uploaded again (a banner cannot be
    // compared with YouTube's processed copy).
    const applied = lastApply?.banner ?? null;
    const unchanged = applied !== null && applied.sha256 === draft.banner.sha256 && current.bannerUrl === applied.url;
    uploadBanner = !unchanged;
    fields.push({ field: "banner", status: unchanged ? "unchanged" : current.bannerUrl ? "changed" : "new" });
  }
  return { fields, uploadBanner };
}

/**
 * The FULL `brandingSettings` to send (U1: the part is replaced whole, an omitted property is deleted): the title and every
 * documented settable field exactly as read, with only the draft's changed fields replaced; the banner URL as read unless a new one
 * was uploaded. A cleared field is left out (that is how U1 deletes it).
 */
export function buildBrandingBody(fresh: LiveChannelBranding, draft: ChannelBrandingDraft, plan: ReturnType<typeof planBranding>, uploadedBannerUrl: string | null): ChannelBrandingBody {
  const channel: Record<string, string> = {};
  const title = str(fresh.brandingChannel.title);
  if (title) channel.title = title;
  for (const key of SETTABLE_BRANDING_CHANNEL_FIELDS) {
    const value = str(fresh.brandingChannel[key]);
    if (value !== null && value !== "") channel[key] = value;
  }
  const changed = (field: ChannelBrandingField) => plan.fields.some((f) => f.field === field && f.status !== "unchanged");
  if (draft.description !== undefined && changed("description")) {
    if (draft.description === "") delete channel.description;
    else channel.description = draft.description;
  }
  if (draft.keywords !== undefined && changed("keywords")) {
    const keywords = serializeKeywords(draft.keywords);
    if (keywords === "") delete channel.keywords;
    else channel.keywords = keywords;
  }
  const banner = uploadedBannerUrl ?? fresh.bannerExternalUrl;
  return banner ? { channel, image: { bannerExternalUrl: banner } } : { channel };
}

/** Whether a second read differs from the first in anything the write sends back or must keep. */
function changedBetweenReads(second: LiveChannelBranding, first: LiveChannelBranding): boolean {
  return (
    second.title !== first.title ||
    stableJson(second.brandingChannel) !== stableJson(first.brandingChannel) ||
    second.bannerExternalUrl !== first.bannerExternalUrl ||
    stableJson(second.localizations) !== stableJson(first.localizations)
  );
}

/**
 * After the write: the draft's fields as sent (keywords compared as lists, after YouTube's own formatting), the banner the uploaded
 * one, every other branding field, the name and the translations unchanged. A difference is named, never hidden.
 */
function readBackProblem(after: LiveChannelBranding, before: LiveChannelBranding, draft: ChannelBrandingDraft, uploadedBannerUrl: string | null): string | null {
  const problems: string[] = [];
  const now = liveOf(after);
  if (draft.description !== undefined && now.description !== draft.description) problems.push("description differs from the one sent");
  if (draft.keywords !== undefined && !sameKeywords(now.keywords, draft.keywords)) {
    problems.push(`keywords differ: sent ${JSON.stringify(serializeKeywords(draft.keywords))}, YouTube shows ${JSON.stringify(str(after.brandingChannel.keywords) ?? "")}`);
  }
  if (uploadedBannerUrl !== null) {
    if (after.bannerExternalUrl !== uploadedBannerUrl) problems.push("banner not set (the channel shows another banner URL)");
  } else if (after.bannerExternalUrl !== before.bannerExternalUrl) {
    problems.push("banner changed");
  }
  const skip = new Set<string>([...(draft.description !== undefined ? ["description"] : []), ...(draft.keywords !== undefined ? ["keywords"] : [])]);
  const keys = new Set([...Object.keys(before.brandingChannel), ...Object.keys(after.brandingChannel)]);
  const otherChanged = [...keys].filter((key) => !skip.has(key) && stableJson(before.brandingChannel[key]) !== stableJson(after.brandingChannel[key])).sort();
  if (otherChanged.length > 0) problems.push(`other branding field changed: ${otherChanged.join(", ")}`);
  if (after.title !== before.title) problems.push("the channel name changed");
  if (stableJson(after.localizations) !== stableJson(before.localizations)) problems.push("the channel translations changed");
  return problems.length > 0 ? problems.join("; ") : null;
}

export function createChannelBrandingService(deps: ChannelBrandingDependencies) {
  const { attempts, delayMs } = deps.readBack ?? CHANNEL_BRANDING_READ_BACK;
  const version = (draftJson: string | null | undefined) => channelBrandingDraftVersion((value) => deps.sha256(value), draftJson);

  async function connectedChannel(channelId: string): Promise<{ connectedUserId: string | null }> {
    const channel = await deps.channel(channelId);
    if (!channel) throw new DomainError({ code: "channel_not_connected", message: "This channel is not connected on this computer", details: { channelId } });
    return channel;
  }

  async function stored(channelId: string) {
    const row = await deps.store.get(channelId);
    const read = readStoredDraft(row?.draftJson);
    return { row, draft: read.ok ? read.draft : null, problem: read.ok ? null : read.problem };
  }

  async function readLive(credentials: Parameters<ChannelBrandingDependencies["youtube"]["read"]>[0], channelId: string): Promise<LiveChannelBranding> {
    const live = await deps.youtube.read(credentials, channelId);
    if (!live) throw new DomainError({ code: "not_found", message: "YouTube does not return the channel", details: { channelId } });
    return live;
  }

  /** A read with the channel's own connected account (1 unit). */
  async function readWithChannelAccount(channelId: string): Promise<LiveChannelBranding> {
    const channel = await connectedChannel(channelId);
    if (!channel.connectedUserId) throw new DomainError({ code: "channel_not_connected", message: "The channel has no connected account", details: { channelId } });
    const credentials = await deps.auth.resolve({ credentialRef: { userId: channel.connectedUserId }, requiredScopes: [YOUTUBE_READ_SCOPE] });
    return readLive(credentials, channelId);
  }

  async function recordLastApply(channelId: string, result: ChannelBrandingLastApply): Promise<void> {
    await deps.store.saveLastApply(channelId, { lastApplyJson: JSON.stringify(result), lastApplyAt: new Date(result.at) });
  }

  function noDraft(channelId: string, problem: string | null): DomainError {
    return new DomainError({
      code: "validation_failed",
      message: problem ? `The saved branding draft cannot be used: ${problem}` : "No branding draft is saved for this channel: nothing to apply",
      details: { channelId },
    });
  }

  const service = {
    /** The stored draft and the last apply (local only). */
    async view(channelId: string): Promise<ChannelBrandingView> {
      await connectedChannel(channelId);
      const { row, draft, problem } = await stored(channelId);
      const by = row?.updatedBy;
      return {
        channelId,
        draft,
        problem,
        updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
        updatedBy: by === "owner" || by === "factory" || by === "worker" ? by : null,
        lastApply: parseLastApply(row?.lastApplyJson),
      };
    },

    /** The channel on YouTube now (a 1-unit read with the channel's account). */
    async live(channelId: string): Promise<ChannelBrandingLive> {
      return liveOf(await readWithChannelAccount(channelId));
    },

    /** AC-CB-10: the draft, the last result and the channel on YouTube now (`live: null` with the code when it cannot be read). */
    async get(channelId: string): Promise<ChannelBrandingGetView> {
      const view = await service.view(channelId);
      try {
        return { ...view, live: await service.live(channelId), liveUnavailable: null };
      } catch (error) {
        return { ...view, live: null, liveUnavailable: isDomainError(error) ? error.code : "failed" };
      }
    },

    /**
     * Local only (AC-CB-01): the draft replaces the stored one ({} clears it); a new banner is checked and copied into the app data
     * folder. Any refused field refuses the whole call (`validation_failed`, `details.refused`) and nothing is stored (AC-CB-02).
     * Nothing is sent to YouTube.
     */
    async save(channelId: string, input: ChannelBrandingSaveInput, by: ChannelBrandingActor): Promise<{ draft: ChannelBrandingDraft | null }> {
      await connectedChannel(channelId);
      const refused: ChannelBrandingRefusal[] = [];
      const draft: ChannelBrandingDraft = {};
      if (input.description !== undefined) {
        const checked = validateDescription(input.description);
        if ("refusal" in checked) refused.push(checked.refusal);
        else draft.description = checked.value;
      }
      if (input.keywords !== undefined) {
        const checked = validateKeywords(input.keywords);
        if ("refusals" in checked) refused.push(...checked.refusals);
        else draft.keywords = checked.value;
      }
      let newBanner: Buffer | null = null;
      const banner = input.banner;
      if (banner?.kind === "keep") {
        const current = await stored(channelId);
        if (current.draft?.banner) draft.banner = current.draft.banner;
      } else if (banner?.kind === "bytes") {
        newBanner = banner.bytes;
      } else if (banner?.kind === "workspace") {
        if (!isRelativeExchangePath(banner.path)) {
          refused.push({ field: "banner", reason: "banner_path_invalid", message: `"${banner.path}" is not a path relative to 99 Data Exchange/Sent to YTM (use / between folders, no .. or absolute paths)` });
        } else {
          try {
            const file = await deps.workspaceFile(channelId, banner.path);
            if (file.size > CHANNEL_BANNER_MAX_BYTES) {
              refused.push({ field: "banner", reason: "banner_too_large", message: `the banner is ${file.size} bytes; the limit is 6 MB (${CHANNEL_BANNER_MAX_BYTES} bytes)` });
            } else {
              newBanner = await file.read();
            }
          } catch (error) {
            // Review #3: the capped read found the file grown past 6 MB after the size check.
            if ((error as { code?: unknown } | null)?.code === "banner_too_large") {
              refused.push({ field: "banner", reason: "banner_too_large", message: `the banner is larger than 6 MB (${CHANNEL_BANNER_MAX_BYTES} bytes)` });
            } else {
              refused.push({ field: "banner", reason: "banner_unavailable", message: error instanceof Error ? error.message : "the banner file cannot be read" });
            }
          }
        }
      }
      if (newBanner) {
        const checked = checkBannerBytes(newBanner);
        if ("refusal" in checked) refused.push(checked.refusal);
        else draft.banner = { sha256: deps.sha256(newBanner), ...checked.meta };
      }
      if (refused.length > 0) {
        throw new DomainError({ code: "validation_failed", message: `The branding draft was refused: ${refused.map((r) => r.message).join("; ")}`, details: { channelId, refused } });
      }
      if (newBanner && draft.banner) await deps.banners.write(channelId, { bytes: newBanner, mimeType: draft.banner.mimeType });
      else if (!draft.banner) await deps.banners.remove(channelId);
      const fields = Object.keys(draft) as ChannelBrandingField[];
      await deps.store.saveDraft(channelId, { draftJson: fields.length > 0 ? JSON.stringify(draft) : null, updatedAt: deps.clock(), updatedBy: by });
      await deps.audit.record({ channelId, kind: "saved", detail: { fields, by, bannerSha256: draft.banner?.sha256 ?? null } });
      return { draft: fields.length > 0 ? draft : null };
    },

    /** The stored banner's bytes, for the card (null = none). */
    async bannerBytes(channelId: string): Promise<{ bytes: Buffer; mimeType: "image/jpeg" | "image/png" } | null> {
      await connectedChannel(channelId);
      const { draft } = await stored(channelId);
      if (!draft?.banner) return null;
      const bytes = await deps.banners.read(channelId, draft.banner.mimeType);
      return bytes ? { bytes, mimeType: draft.banner.mimeType } : null;
    },

    /** What «Применить» would do now (a 1-unit read; nothing is written), with the version of the draft it was computed from. */
    async preview(channelId: string): Promise<ChannelBrandingPreview> {
      const { row, draft, problem } = await stored(channelId);
      if (!draft) throw noDraft(channelId, problem);
      const live = await readWithChannelAccount(channelId);
      const plan = planBranding(draft, live, parseLastApply(row?.lastApplyJson));
      const writes = plan.fields.some((f) => f.status !== "unchanged") ? 1 + (plan.uploadBanner ? 1 : 0) : 0;
      return {
        fields: plan.fields,
        live: liveOf(live),
        banner: {
          current: live.bannerExternalUrl,
          next: draft.banner ? { width: draft.banner.width, height: draft.banner.height, bytes: draft.banner.bytes, mimeType: draft.banner.mimeType } : null,
        },
        quota: { readUnits: writes > 0 ? 3 : 1, writes, writeUnits: writes * WRITE_UNITS },
        draftVersion: version(row?.draftJson),
      };
    },

    /**
     * The owner's «Применить» (AGENTS.md §G, ADR 0050): the draft still the one previewed, identity, a fresh read, nothing different →
     * nothing written, a backup, the channel unchanged right before the writes, the banner upload (Live writes right before it), the
     * full `brandingSettings` (Live writes right before it), a read-back, the audit and the last result. Partial states are named.
     */
    async apply(channelId: string, credentialRef: unknown, draftVersion: unknown): Promise<ChannelBrandingLastApply> {
      let backupPath: string | null = null;
      let writes = 0;
      let fields: ChannelBrandingField[] = [];
      let uploadedBannerUrl: string | null = null;
      // Review #1: the banner a previous apply set stays recorded through any failure of this one (else the next preview would
      // upload it again). Review #2: once the update succeeded, a later failure says "written, not verified".
      let previousBanner: { sha256: string; url: string } | null = null;
      let draftBannerSha: string | null = null;
      let written = false;
      await connectedChannel(channelId);
      try {
        const { row, draft, problem } = await stored(channelId);
        const lastApply = parseLastApply(row?.lastApplyJson);
        previousBanner = lastApply?.banner ?? null;
        draftBannerSha = draft?.banner?.sha256 ?? null;
        // 0. The draft the owner previewed (AC-CB-07): the Operator, a worker or another tab may have saved another one since.
        if (typeof draftVersion !== "string" || draftVersion.length === 0) {
          throw new DomainError({ code: "validation_failed", message: "The version of the previewed draft is missing: check against YouTube first", details: { channelId } });
        }
        if (draftVersion !== version(row?.draftJson)) {
          throw new DomainError({ code: "branding_changed", message: "The saved branding draft changed since it was checked: check against YouTube again. Nothing was written", details: { channelId } });
        }
        if (!draft) throw noDraft(channelId, problem);
        let bannerBytes: Buffer | null = null;
        if (draft.banner) {
          bannerBytes = await deps.banners.read(channelId, draft.banner.mimeType);
          if (!bannerBytes || deps.sha256(bannerBytes) !== draft.banner.sha256) {
            throw new DomainError({ code: "branding_changed", message: "The saved banner file is missing or changed since it was saved: save the banner again. Nothing was written", details: { channelId } });
          }
        }

        // 1. Identity: the account is the channel's (fails closed, AC-CB-06).
        const credentials = await deps.auth.resolve({ credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] });
        await deps.writeContext.assertWriteChannel({ credentialRef, credentials, expectedChannelId: channelId });

        // 2. A fresh read and what the draft would change.
        const fresh = await readLive(credentials, channelId);
        const plan = planBranding(draft, fresh, lastApply);
        fields = plan.fields.filter((f) => f.status !== "unchanged").map((f) => f.field);
        if (fields.length === 0) {
          const result: ChannelBrandingLastApply = { at: deps.clock().toISOString(), ok: true, fields: [], writes: 0, backupPath: null, banner: lastApply?.banner ?? null };
          await deps.audit.record({ channelId, kind: "verification", detail: { verified: true, nothingToWrite: true } });
          await recordLastApply(channelId, result);
          return result;
        }

        // 3. Backup of the channel exactly as read.
        const health = await deps.backup.checkInfrastructureHealth();
        if (!health.healthy) throw new DomainError({ code: "backup_infrastructure_unavailable", message: health.error ?? "Backup storage is unreachable" });
        const backup = await deps.backup.captureBackup({
          channelId,
          operationId: deps.newId(),
          subjectId: channelId,
          snapshot: { kind: "channel_branding", title: fresh.title, brandingChannel: fresh.brandingChannel, bannerExternalUrl: fresh.bannerExternalUrl, localizations: fresh.localizations },
        });
        backupPath = backup.path;
        await deps.audit.record({ channelId, kind: "backup", detail: { backupPath } });

        // 4. Right before the writes: the channel still reads as the read the write is built from (an edit made in Studio meanwhile
        // would be undone by the part sent whole).
        if (changedBetweenReads(await readLive(credentials, channelId), fresh)) {
          throw new DomainError({ code: "update_failed", message: "The channel changed on YouTube while the branding was being prepared, so nothing was sent: apply again", details: { channelId } });
        }

        // 5. The banner (AC-CB-04): Live writes immediately before the upload.
        if (plan.uploadBanner && draft.banner && bannerBytes) {
          await deps.youtube.assertLiveWritesAuthorized();
          uploadedBannerUrl = (await deps.youtube.insertBanner(credentials, { mimeType: draft.banner.mimeType, bytes: bannerBytes })).url;
          writes++;
          await deps.audit.record({ channelId, kind: "banner_upload", detail: { sha256: draft.banner.sha256, url: uploadedBannerUrl } });
        }

        // 6. The full brandingSettings (AC-CB-03): Live writes immediately before the one update.
        const body = buildBrandingBody(fresh, draft, plan, uploadedBannerUrl);
        try {
          await deps.youtube.assertLiveWritesAuthorized();
          await deps.youtube.updateBranding(credentials, channelId, body);
        } catch (error) {
          if (uploadedBannerUrl === null) throw error;
          // AC-CB-05: the banner is on YouTube but not on the channel -- the channel keeps its old banner.
          const cause = isDomainError(error) ? error.code : "failed";
          throw new DomainError({
            code: "banner_uploaded_not_set",
            message: `The new banner was uploaded to YouTube but the channel update failed (${cause}): the channel keeps its old banner and the other fields were not changed. Apply again`,
            details: { channelId, cause },
          });
        }
        writes++;
        written = true;
        await deps.audit.record({ channelId, kind: "write", detail: { part: "brandingSettings", fields, sent: body } });

        // 7. Read-back (AC-CB-08).
        let after = await readLive(credentials, channelId);
        let problemText = readBackProblem(after, fresh, draft, uploadedBannerUrl);
        for (let attempt = 1; attempt < attempts && problemText !== null; attempt++) {
          await deps.sleep(delayMs);
          after = await readLive(credentials, channelId);
          problemText = readBackProblem(after, fresh, draft, uploadedBannerUrl);
        }
        const banner = draft.banner ? (uploadedBannerUrl ? { sha256: draft.banner.sha256, url: uploadedBannerUrl } : (lastApply?.banner ?? null)) : null;
        if (problemText !== null) {
          const result: ChannelBrandingLastApply = { at: deps.clock().toISOString(), ok: false, failure: "read_back_mismatch", detail: problemText, fields, writes, backupPath, banner };
          await deps.audit.record({ channelId, kind: "verification", detail: { verified: false, problem: problemText } });
          await recordLastApply(channelId, result);
          return result;
        }

        // 8. Audit and the last result.
        const result: ChannelBrandingLastApply = { at: deps.clock().toISOString(), ok: true, fields, writes, backupPath, banner };
        await deps.audit.record({ channelId, kind: "verification", detail: { verified: true, fields } });
        await recordLastApply(channelId, result);
        return result;
      } catch (caught) {
        let error = caught;
        if (written) {
          // Review #2: channels.update succeeded, then the audit or a read-back read failed -- the channel WAS written; only the
          // verification is missing. Never reported as a plain failure.
          const cause = isDomainError(caught) ? caught.code : "failed";
          error = new DomainError({
            code: "written_unverified",
            message: `The channel branding was written on YouTube, but checking it afterwards failed (${cause}): open the channel to check it, or check against YouTube again. The backup was kept`,
            details: { channelId, cause },
          });
        }
        const code = isDomainError(error) ? error.code : "failed";
        const message = error instanceof Error ? error.message : "Unknown error";
        const failure = code === "banner_uploaded_not_set" || code === "written_unverified" ? code : "failed";
        const detail = failure !== "failed" && isDomainError(error) ? String((error.details as { cause?: unknown } | undefined)?.cause ?? code) : code;
        // The banner on the channel now: the one uploaded here once the update carried it, else the one a previous apply set.
        const banner = written && uploadedBannerUrl && draftBannerSha ? { sha256: draftBannerSha, url: uploadedBannerUrl } : previousBanner;
        await deps.audit.record({ channelId, kind: "failed", detail: { code, message, writes, backupPath, bannerUrl: uploadedBannerUrl } }).catch(() => undefined);
        await recordLastApply(channelId, { at: deps.clock().toISOString(), ok: false, failure, detail, error: message, fields, writes, backupPath, banner }).catch(() => undefined);
        throw error;
      }
    },
  };
  return service;
}

export type ChannelBrandingService = ReturnType<typeof createChannelBrandingService>;
