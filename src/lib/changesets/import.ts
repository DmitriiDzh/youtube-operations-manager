import type { Workbook } from "exceljs";
import {
  XlsxBufferError,
  XlsxInvalidWorkbookError,
  XlsxRowLimitError,
  assertDataRowCountWithinLimit,
  buildHeaderIndex,
  cellText,
  findMissingColumns,
  loadWorkbookFromBuffer,
  readKeyValueSheet,
} from "@/lib/shared-xlsx";
import { DomainError } from "./contracts";
import type { ImportRowError, ParsedFieldOutcome, ParsedRowResult, ParsedWorkbook, StoredVideoRecord } from "./contracts";
import {
  YOUTUBE_DESCRIPTION_MAX_LENGTH,
  YOUTUBE_TITLE_MAX_LENGTH,
  classifyFieldChange,
  computeConflictStatus,
  currentRemoteValueFor,
  isValidLanguageCode,
} from "./diff";

// Resource-safety limits (docs/PROJECT_SPEC.md §7 "Resource safety"): bound file size
// and row count so a malformed/huge workbook cannot exhaust memory or hang the import.
// The values are this app's own tuning decision; the enforcement mechanism itself lives
// in @/lib/shared-xlsx (loadWorkbookFromBuffer/assertDataRowCountWithinLimit) -- see
// docs/TECHNICAL_DEBT.md RISK-01 for this check's known limitation.
export const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024; // 25MB
export const MAX_LOCALIZATION_ROWS = 20_000;

const REQUIRED_LOCALIZATION_COLUMNS = [
  "video_id",
  "language",
  "title",
  "description",
  "remote_title",
  "remote_description",
] as const;

function structuralError(message: string, details?: unknown): DomainError {
  return new DomainError({ code: "validation_failed", message, details });
}

/**
 * Reads this workbook's "Meta" sheet (schema_version/exported_at/channel_id) via the
 * generic key-value reader -- returns all-null when the sheet is absent (an older export
 * without it remains importable, see the doc comment on this shape's writer).
 */
function readMetaSheet(workbook: Workbook): {
  schemaVersion: string | null;
  exportedAt: string | null;
  channelId: string | null;
} {
  const values = readKeyValueSheet(workbook, "Meta");
  return {
    schemaVersion: values?.schema_version || null,
    exportedAt: values?.exported_at || null,
    channelId: values?.channel_id || null,
  };
}

/**
 * Parses and validates an XLSX workbook produced by (or compatible with) the Phase 3
 * localization export. Pure with respect to persistence: takes the currently
 * synchronized videos as an input snapshot and returns a fully classified result --
 * it never touches the database itself (services.ts decides what to persist).
 *
 * Structural problems (missing required sheet/columns, oversized file, workbook
 * exported for a different channel) throw and block the entire import. Row/field
 * problems are collected per-row so valid rows can still be imported even when
 * unrelated rows are broken (docs/PROJECT_SPEC.md §5/§19).
 */
export async function parseAndValidateWorkbook(args: {
  buffer: Buffer;
  channelId: string;
  syncedVideos: StoredVideoRecord[];
}): Promise<ParsedWorkbook> {
  let workbook;
  try {
    workbook = await loadWorkbookFromBuffer(args.buffer, { maxBytes: MAX_WORKBOOK_BYTES });
  } catch (error) {
    if (error instanceof XlsxBufferError) {
      throw error.kind === "empty"
        ? structuralError("Uploaded file is empty")
        : structuralError("Workbook exceeds the maximum supported file size", { maxBytes: MAX_WORKBOOK_BYTES });
    }
    if (error instanceof XlsxInvalidWorkbookError) {
      throw structuralError("File is not a valid XLSX workbook", { cause: error.sourceMessage });
    }
    throw error;
  }

  const localizationsSheet = workbook.getWorksheet("Localizations");
  if (!localizationsSheet) {
    throw structuralError('Workbook is missing the required "Localizations" worksheet');
  }

  const meta = readMetaSheet(workbook);
  if (meta.channelId && meta.channelId !== args.channelId) {
    throw structuralError(
      "This workbook was exported from a different channel and cannot be imported here",
      { workbookChannelId: meta.channelId, selectedChannelId: args.channelId }
    );
  }

  const headerRow = localizationsSheet.getRow(1);
  const headerIndex = buildHeaderIndex(headerRow);
  const missingColumns = findMissingColumns(headerIndex, REQUIRED_LOCALIZATION_COLUMNS);
  if (missingColumns.length > 0) {
    throw structuralError("Localizations worksheet is missing required columns", {
      missingColumns,
    });
  }

  try {
    assertDataRowCountWithinLimit(localizationsSheet, MAX_LOCALIZATION_ROWS);
  } catch (error) {
    if (error instanceof XlsxRowLimitError) {
      throw structuralError("Workbook has too many localization rows", {
        rowCount: error.actualRows,
        maxRows: MAX_LOCALIZATION_ROWS,
      });
    }
    throw error;
  }

  const syncedVideoMap = new Map(args.syncedVideos.map((v) => [v.videoId, v]));
  const videoIdCol = headerIndex.get("video_id")!;
  const languageCol = headerIndex.get("language")!;
  const titleCol = headerIndex.get("title")!;
  const descriptionCol = headerIndex.get("description")!;
  const remoteTitleCol = headerIndex.get("remote_title")!;
  const remoteDescriptionCol = headerIndex.get("remote_description")!;

  const rows: ParsedRowResult[] = [];
  const errors: ImportRowError[] = [];
  const seenRowKeys = new Set<string>();
  const videoIdsSeen = new Set<string>();

  localizationsSheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const videoId = cellText(row.getCell(videoIdCol)).trim();
    const language = cellText(row.getCell(languageCol)).trim();
    const titleRaw = cellText(row.getCell(titleCol)).trim();
    const descriptionRaw = cellText(row.getCell(descriptionCol)).trim();
    const remoteTitle = cellText(row.getCell(remoteTitleCol)).trim();
    const remoteDescription = cellText(row.getCell(remoteDescriptionCol)).trim();

    const isBlankRow = !videoId && !language && !titleRaw && !descriptionRaw;
    if (isBlankRow) return;

    if (!videoId) {
      errors.push({ row: rowNumber, videoId: null, language: language || null, message: "video_id is required" });
      return;
    }

    if (!language) {
      errors.push({ row: rowNumber, videoId, language: null, message: "language is required" });
      return;
    }

    if (!isValidLanguageCode(language)) {
      errors.push({ row: rowNumber, videoId, language, message: `Invalid language code format: "${language}"` });
      return;
    }

    const syncedVideo = syncedVideoMap.get(videoId);
    if (!syncedVideo) {
      errors.push({
        row: rowNumber,
        videoId,
        language,
        message: "video_id does not belong to this channel's synchronized data (wrong channel, or not synced)",
      });
      return;
    }

    const rowKey = `${videoId}::${language}`;
    if (seenRowKeys.has(rowKey)) {
      errors.push({ row: rowNumber, videoId, language, message: "Duplicate row for this video_id + language" });
      return;
    }
    seenRowKeys.add(rowKey);
    videoIdsSeen.add(videoId);

    const fields: ParsedFieldOutcome[] = [];

    const fieldSpecs: Array<{
      field: "title" | "description";
      proposedRaw: string;
      baselineRaw: string;
      maxLength: number;
    }> = [
      { field: "title", proposedRaw: titleRaw, baselineRaw: remoteTitle, maxLength: YOUTUBE_TITLE_MAX_LENGTH },
      {
        field: "description",
        proposedRaw: descriptionRaw,
        baselineRaw: remoteDescription,
        maxLength: YOUTUBE_DESCRIPTION_MAX_LENGTH,
      },
    ];

    for (const spec of fieldSpecs) {
      // Blank cell = no proposed change for this field (docs/PROJECT_SPEC.md §8).
      if (spec.proposedRaw.length === 0) continue;

      const currentRemoteValue = currentRemoteValueFor(syncedVideo, language, spec.field);
      const validationError =
        spec.proposedRaw.length > spec.maxLength
          ? `${spec.field} exceeds ${spec.maxLength} characters (${spec.proposedRaw.length})`
          : null;

      fields.push({
        videoId,
        language,
        field: spec.field,
        baselineValue: spec.baselineRaw,
        proposedValue: spec.proposedRaw,
        changeType: classifyFieldChange(currentRemoteValue, spec.proposedRaw),
        validationStatus: validationError ? "invalid" : "valid",
        validationError,
        conflictStatus: computeConflictStatus(spec.baselineRaw, currentRemoteValue),
      });
    }

    rows.push({ row: rowNumber, videoId, language, rowError: null, fields });
  });

  return {
    schemaVersion: meta.schemaVersion,
    exportedAt: meta.exportedAt,
    rows,
    errors,
    videosFound: videoIdsSeen.size,
  };
}

export type RowSummaryClass = "valid" | "unchanged" | "invalid" | "conflict";

export function classifyRowForSummary(row: ParsedRowResult): RowSummaryClass {
  if (row.fields.some((f) => f.validationStatus === "invalid")) return "invalid";
  if (row.fields.some((f) => f.conflictStatus === "conflict")) return "conflict";
  if (row.fields.some((f) => f.changeType === "add" || f.changeType === "modify")) return "valid";
  return "unchanged";
}

export function summarizeParsedWorkbook(parsed: ParsedWorkbook): {
  videosFound: number;
  localizationRows: number;
  validChanges: number;
  unchangedValues: number;
  invalidRows: number;
  conflicts: number;
} {
  let validChanges = 0;
  let unchangedValues = 0;
  let invalidRows = parsed.errors.length;
  let conflicts = 0;

  for (const row of parsed.rows) {
    const cls = classifyRowForSummary(row);
    if (cls === "valid") validChanges += 1;
    else if (cls === "unchanged") unchangedValues += 1;
    else if (cls === "invalid") invalidRows += 1;
    else if (cls === "conflict") conflicts += 1;
  }

  return {
    videosFound: parsed.videosFound,
    localizationRows: parsed.rows.length + parsed.errors.length,
    validChanges,
    unchangedValues,
    invalidRows,
    conflicts,
  };
}
