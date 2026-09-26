import ExcelJS from "exceljs";

// ---------------------------------------------------------------------------
// Generic XLSX (spreadsheet) I/O mechanics — reading and writing workbooks shaped by
// caller-supplied sheet/column definitions. This module has ZERO knowledge of channels,
// videos, or localization: everything domain-specific (which sheet/columns are required,
// what a row means, per-field business validation, diff/conflict logic) stays in the
// caller (today: `src/lib/localization/adapters/xlsx.ts` for export,
// `src/lib/changesets/import.ts` for import).
//
// Extracted 2026-09-26 per the project owner's Telegram instruction ("вынести и обобщить
// этот функционал — экспорт / импорт в эксель... отдельный модуль который мы будем
// подключать к разным экранам в будущем при необходимости... подключенным только к
// переводам [сейчас]... его статус всегда должен быть как вспомогательный,
// дополнительный инструмент и он никогда не задействован в стандартном процессе хранения
// данных"). See `docs/roadmap/plans/SHARED_XLSX_MODULE_PLAN.md` for the full design and
// exactly which functions moved from where. The "always auxiliary" requirement is
// mechanically enforced by `usage-inventory.test.ts` in this directory, not merely
// documented here — this module has no dependency on any domain's persistence or
// `DomainError` type, and no domain's core persistence path may depend on this one.
// ---------------------------------------------------------------------------

/** Buffer-level problem reading an uploaded/provided workbook, before any sheet is parsed. */
export class XlsxBufferError extends Error {
  readonly kind: "empty" | "too_large";
  readonly maxBytes?: number;

  constructor(kind: "empty" | "too_large", message: string, maxBytes?: number) {
    super(message);
    this.name = "XlsxBufferError";
    this.kind = kind;
    this.maxBytes = maxBytes;
  }
}

/** The buffer parsed as bytes but is not a workbook `exceljs` can read. */
export class XlsxInvalidWorkbookError extends Error {
  /** The underlying parser error's own message, for callers that want to surface it. */
  readonly sourceMessage: string;

  constructor(sourceMessage: string) {
    super("File is not a valid XLSX workbook");
    this.name = "XlsxInvalidWorkbookError";
    this.sourceMessage = sourceMessage;
  }
}

/** A worksheet has more data rows than the caller's configured limit. */
export class XlsxRowLimitError extends Error {
  readonly maxRows: number;
  readonly actualRows: number;

  constructor(maxRows: number, actualRows: number) {
    super(`Worksheet has ${actualRows} data rows, exceeding the limit of ${maxRows}`);
    this.name = "XlsxRowLimitError";
    this.maxRows = maxRows;
    this.actualRows = actualRows;
  }
}

/**
 * Reads a cell's displayed text as plain data only. Formula cells use only their cached
 * `result` (never the formula string itself), so imported content is always treated as
 * inert data, never as something to evaluate (`docs/PROJECT_SPEC.md` §16's import-safety
 * requirement — moved here unchanged from the original `changesets/import.ts`).
 */
export function cellText(cell: ExcelJS.Cell | undefined): string {
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

/** Header-name (lowercased) → 1-based column-index map, so a workbook survives column reordering. */
export function buildHeaderIndex(headerRow: ExcelJS.Row): Map<string, number> {
  const index = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const name = cellText(cell).trim().toLowerCase();
    if (name) index.set(name, colNumber);
  });
  return index;
}

/** Pure set-difference — which of `required` (lowercase header names) are absent from `headerIndex`. */
export function findMissingColumns(headerIndex: Map<string, number>, required: readonly string[]): string[] {
  return required.filter((column) => !headerIndex.has(column));
}

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true };
  row.alignment = { vertical: "middle" };
}

/** 1-based column index → spreadsheet column letter (1→"A", 26→"Z", 27→"AA", ...). */
function columnLetter(n: number): string {
  let result = "";
  let remaining = n;
  while (remaining > 0) {
    const rem = (remaining - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return result;
}

export type XlsxColumnDef = { header: string; key: string; width?: number };

export type XlsxSheetSpec = {
  name: string;
  columns: XlsxColumnDef[];
  /** Row objects keyed by each column's `key`. */
  rows: Array<Record<string, unknown>>;
  /** Freeze the header row (`views: [{state: "frozen", ySplit: 1}]`). */
  freezeHeaderRow?: boolean;
  /** Add an autofilter spanning the full header row. */
  autoFilter?: boolean;
  /** Column keys whose cells get `{wrapText: true, vertical: "top"}` on every data row. */
  wrapTextColumns?: string[];
};

/**
 * Builds a workbook from caller-supplied sheet specs: bold/frozen header, optional
 * autofilter, optional wrapped-text columns, sensible column widths from each spec. Pure
 * with respect to any domain meaning — the caller decides what each sheet/column/row means.
 */
export function buildWorkbook(sheets: XlsxSheetSpec[]): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();

  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(
      spec.name,
      spec.freezeHeaderRow ? { views: [{ state: "frozen", ySplit: 1 }] } : undefined
    );
    sheet.columns = spec.columns.map((column) => ({ header: column.header, key: column.key, width: column.width }));
    styleHeaderRow(sheet.getRow(1));

    if (spec.autoFilter) {
      sheet.autoFilter = { from: "A1", to: `${columnLetter(spec.columns.length)}1` };
    }

    for (const rowData of spec.rows) {
      const row = sheet.addRow(rowData);
      for (const key of spec.wrapTextColumns ?? []) {
        row.getCell(key).alignment = { wrapText: true, vertical: "top" };
      }
    }
  }

  return workbook;
}

export async function workbookToBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Loads a workbook from an untrusted buffer, enforcing a byte-size ceiling before ever
 * handing the bytes to `exceljs` (`docs/PROJECT_SPEC.md` §7 "Resource safety" — a
 * malformed/huge workbook must never be allowed to exhaust memory or hang the process).
 * See `docs/TECHNICAL_DEBT.md` RISK-01 for this check's known limitation (it runs after
 * the request body itself has already been buffered by the HTTP layer — unchanged by this
 * extraction, only relocated).
 */
export async function loadWorkbookFromBuffer(buffer: Buffer, opts: { maxBytes: number }): Promise<ExcelJS.Workbook> {
  if (buffer.length === 0) {
    throw new XlsxBufferError("empty", "Uploaded file is empty");
  }
  if (buffer.length > opts.maxBytes) {
    throw new XlsxBufferError("too_large", "Workbook exceeds the maximum supported file size", opts.maxBytes);
  }

  const workbook = new ExcelJS.Workbook();
  try {
    // Pre-existing @types/node vs. exceljs Buffer-generic mismatch (typescript@5.9.3 makes
    // Uint8Array/Buffer generic; exceljs's own bundled Buffer typing stub predates that) --
    // cast is data-safe, load() only reads bytes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);
  } catch (error) {
    throw new XlsxInvalidWorkbookError(error instanceof Error ? error.message : String(error));
  }

  return workbook;
}

/** Throws `XlsxRowLimitError` if `sheet` (row 1 = header) has more than `maxRows` data rows. */
export function assertDataRowCountWithinLimit(sheet: ExcelJS.Worksheet, maxRows: number): void {
  const totalDataRows = Math.max(0, sheet.rowCount - 1);
  if (totalDataRows > maxRows) {
    throw new XlsxRowLimitError(maxRows, totalDataRows);
  }
}

/**
 * Reads a generic two-column (key, value) sheet — e.g. a workbook's own "Meta" convention
 * (`schema_version`/`exported_at`/`subject_id`-style provenance). Returns `null` if the
 * sheet doesn't exist at all, so an older export missing this sheet degrades gracefully
 * rather than failing the whole read (the caller decides what a missing sheet means).
 */
export function readKeyValueSheet(workbook: ExcelJS.Workbook, sheetName: string): Record<string, string> | null {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) return null;

  const values: Record<string, string> = {};
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const key = cellText(row.getCell(1)).trim().toLowerCase();
    const value = cellText(row.getCell(2)).trim();
    if (key) values[key] = value;
  });

  return values;
}
