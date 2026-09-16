import ExcelJS from "exceljs";
import { DomainError } from "./contracts";
import type { ImportRowError, ParsedFieldOutcome, ParsedRowResult, ParsedWorkbook, StoredVideoRecord } from "./contracts";
import {
  YOUTUBE_DESCRIPTION_MAX_LENGTH,
  YOUTUBE_TITLE_MAX_LENGTH,
  classifyFieldChange,
  computeConflictStatus,
  isValidLanguageCode,
} from "./diff";

// Resource-safety limits (docs/PROJECT_SPEC.md §7 "Resource safety"): bound file size
// and row count so a malformed/huge workbook cannot exhaust memory or hang the import.
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
 * Reads a cell's displayed text as plain data only. Formula cells use only their
 * cached `result` (never the formula string itself), so imported content is always
 * treated as inert data, never as something to evaluate (docs/PROJECT_SPEC.md §7).
 */
function cellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return "";
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    if ("richText" in value && Array.isArray((value as { richText: unknown[] }).richText)) {
      return (value as { richText: Array<{ text?: string }> }).richText
        .map((part) => part.text ?? "")
        .join("");
    }
    if ("result" in value) {
      const result = (value as { result: unknown }).result;
      if (typeof result === "string") return result;
      if (typeof result === "number") return String(result);
      return "";
    }
    if ("text" in value) {
      return String((value as { text: unknown }).text ?? "");
    }
  }

  return "";
}

function buildHeaderIndex(headerRow: ExcelJS.Row): Map<string, number> {
  const index = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const name = cellText(cell).trim().toLowerCase();
    if (name) index.set(name, colNumber);
  });
  return index;
}

function readMetaSheet(workbook: ExcelJS.Workbook): {
  schemaVersion: string | null;
  exportedAt: string | null;
  channelId: string | null;
} {
  const sheet = workbook.getWorksheet("Meta");
  if (!sheet) {
    return { schemaVersion: null, exportedAt: null, channelId: null };
  }

  const values: Record<string, string> = {};
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const key = cellText(row.getCell(1)).trim().toLowerCase();
    const value = cellText(row.getCell(2)).trim();
    if (key) values[key] = value;
  });

  return {
    schemaVersion: values.schema_version || null,
    exportedAt: values.exported_at || null,
    channelId: values.channel_id || null,
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
  if (args.buffer.length === 0) {
    throw structuralError("Uploaded file is empty");
  }
  if (args.buffer.length > MAX_WORKBOOK_BYTES) {
    throw structuralError("Workbook exceeds the maximum supported file size", {
      maxBytes: MAX_WORKBOOK_BYTES,
    });
  }

  const workbook = new ExcelJS.Workbook();
  try {
    // Pre-existing @types/node vs. exceljs Buffer-generic mismatch (same as
    // localization/adapters/xlsx.test.ts) -- cast is data-safe, load() only reads bytes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(args.buffer as any);
  } catch (error) {
    throw structuralError("File is not a valid XLSX workbook", {
      cause: error instanceof Error ? error.message : String(error),
    });
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
  const missingColumns = REQUIRED_LOCALIZATION_COLUMNS.filter((col) => !headerIndex.has(col));
  if (missingColumns.length > 0) {
    throw structuralError("Localizations worksheet is missing required columns", {
      missingColumns,
    });
  }

  const totalDataRows = Math.max(0, localizationsSheet.rowCount - 1);
  if (totalDataRows > MAX_LOCALIZATION_ROWS) {
    throw structuralError("Workbook has too many localization rows", {
      rowCount: totalDataRows,
      maxRows: MAX_LOCALIZATION_ROWS,
    });
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

      const currentRemoteValue = syncedVideo.existingLocalizations[language]?.[spec.field] ?? "";
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
