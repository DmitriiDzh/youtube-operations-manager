import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  XlsxBufferError,
  XlsxInvalidWorkbookError,
  XlsxRowLimitError,
  assertDataRowCountWithinLimit,
  buildHeaderIndex,
  buildWorkbook,
  cellText,
  findMissingColumns,
  loadWorkbookFromBuffer,
  readKeyValueSheet,
  workbookToBuffer,
} from "./index";

test("cellText reads plain strings/numbers/booleans/dates as text", () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("S");
  sheet.addRow(["hello", 42, true, new Date("2026-01-01T00:00:00.000Z")]);
  const row = sheet.getRow(1);
  assert.equal(cellText(row.getCell(1)), "hello");
  assert.equal(cellText(row.getCell(2)), "42");
  assert.equal(cellText(row.getCell(3)), "true");
  assert.equal(cellText(row.getCell(4)), "2026-01-01T00:00:00.000Z");
});

test("cellText returns empty string for an undefined/blank cell", () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("S");
  sheet.addRow([]);
  assert.equal(cellText(sheet.getRow(1).getCell(1)), "");
  assert.equal(cellText(undefined), "");
});

test("cellText reads a formula cell's cached result, never the formula text itself", () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("S");
  const row = sheet.addRow([]);
  row.getCell(1).value = { formula: "=1+1", result: 2 };
  assert.equal(cellText(row.getCell(1)), "2");
});

test("buildHeaderIndex maps lowercased header names to their column index", () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("S");
  sheet.addRow(["Video_ID", "Language", "Title"]);
  const index = buildHeaderIndex(sheet.getRow(1));
  assert.equal(index.get("video_id"), 1);
  assert.equal(index.get("language"), 2);
  assert.equal(index.get("title"), 3);
});

test("findMissingColumns returns only the required columns absent from the header index", () => {
  const index = new Map([["a", 1], ["b", 2]]);
  assert.deepEqual(findMissingColumns(index, ["a", "b", "c", "d"]), ["c", "d"]);
  assert.deepEqual(findMissingColumns(index, ["a", "b"]), []);
});

test("buildWorkbook produces a sheet with the given columns, rows, autofilter range, and wrapped text", async () => {
  const workbook = buildWorkbook([
    {
      name: "Widgets",
      columns: [
        { header: "id", key: "id", width: 10 },
        { header: "name", key: "name", width: 20 },
        { header: "notes", key: "notes", width: 30 },
      ],
      rows: [
        { id: "w1", name: "Widget One", notes: "long note" },
        { id: "w2", name: "Widget Two", notes: "another note" },
      ],
      freezeHeaderRow: true,
      autoFilter: true,
      wrapTextColumns: ["notes"],
    },
  ]);

  const sheet = workbook.getWorksheet("Widgets");
  assert.ok(sheet);
  assert.equal(sheet!.rowCount, 3); // header + 2 rows
  assert.deepEqual(Array.from(sheet!.getRow(1).values as unknown[]), [undefined, "id", "name", "notes"]);
  assert.equal(sheet!.getRow(2).getCell("id").value, "w1");
  // 3 columns -> autofilter should span A1:C1
  assert.deepEqual(sheet!.autoFilter, { from: "A1", to: "C1" });
  assert.equal(sheet!.getRow(2).getCell("notes").alignment?.wrapText, true);
  // A column NOT listed in wrapTextColumns must not get wrapText.
  assert.notEqual(sheet!.getRow(2).getCell("name").alignment?.wrapText, true);
});

test("buildWorkbook omits autofilter when not requested (e.g. a plain Meta-style sheet)", () => {
  const workbook = buildWorkbook([
    { name: "Meta", columns: [{ header: "key", key: "key" }, { header: "value", key: "value" }], rows: [{ key: "a", value: "b" }] },
  ]);
  const sheet = workbook.getWorksheet("Meta");
  assert.equal(sheet!.autoFilter, null);
});

test("buildWorkbook computes a two-letter autofilter column for more than 26 columns", () => {
  const columns = Array.from({ length: 27 }, (_, i) => ({ header: `c${i}`, key: `c${i}` }));
  const workbook = buildWorkbook([{ name: "Wide", columns, rows: [], autoFilter: true }]);
  const sheet = workbook.getWorksheet("Wide");
  assert.deepEqual(sheet!.autoFilter, { from: "A1", to: "AA1" });
});

// Independent review finding (2026-09-26): the 27-column case above proves the two-letter
// rollover works, but never exercised the exact single-letter/two-letter boundary itself
// (26 columns -> "Z", the last single-letter column) -- hand-verified against the real
// spreadsheet-column-letter convention (A=1 ... Z=26, AA=27), not derived from the
// implementation under test.
test("buildWorkbook computes a single-letter autofilter column for exactly 26 columns (the A-Z boundary)", () => {
  const columns = Array.from({ length: 26 }, (_, i) => ({ header: `c${i}`, key: `c${i}` }));
  const workbook = buildWorkbook([{ name: "Exact26", columns, rows: [], autoFilter: true }]);
  const sheet = workbook.getWorksheet("Exact26");
  assert.deepEqual(sheet!.autoFilter, { from: "A1", to: "Z1" });
});

test("workbookToBuffer round-trips through loadWorkbookFromBuffer", async () => {
  const workbook = buildWorkbook([{ name: "S", columns: [{ header: "x", key: "x" }], rows: [{ x: "1" }] }]);
  const buffer = await workbookToBuffer(workbook);
  const loaded = await loadWorkbookFromBuffer(buffer, { maxBytes: 10 * 1024 * 1024 });
  assert.ok(loaded.getWorksheet("S"));
});

test("loadWorkbookFromBuffer rejects an empty buffer", async () => {
  await assert.rejects(
    () => loadWorkbookFromBuffer(Buffer.alloc(0), { maxBytes: 1024 }),
    (error: unknown) => error instanceof XlsxBufferError && error.kind === "empty"
  );
});

test("loadWorkbookFromBuffer rejects a buffer larger than maxBytes, without reporting it as invalid", async () => {
  await assert.rejects(
    () => loadWorkbookFromBuffer(Buffer.alloc(1025), { maxBytes: 1024 }),
    (error: unknown) => error instanceof XlsxBufferError && error.kind === "too_large" && error.maxBytes === 1024
  );
});

test("loadWorkbookFromBuffer rejects bytes that are not a real workbook", async () => {
  await assert.rejects(
    () => loadWorkbookFromBuffer(Buffer.from("not an xlsx file"), { maxBytes: 1024 * 1024 }),
    (error: unknown) => error instanceof XlsxInvalidWorkbookError
  );
});

test("assertDataRowCountWithinLimit passes when at or under the limit, throws with the actual count when over", () => {
  const workbook = buildWorkbook([
    { name: "S", columns: [{ header: "x", key: "x" }], rows: [{ x: "1" }, { x: "2" }] },
  ]);
  const sheet = workbook.getWorksheet("S")!;
  assertDataRowCountWithinLimit(sheet, 2); // exactly at the limit -- must not throw

  assert.throws(
    () => assertDataRowCountWithinLimit(sheet, 1),
    (error: unknown) => error instanceof XlsxRowLimitError && error.actualRows === 2 && error.maxRows === 1
  );
});

test("readKeyValueSheet returns null when the named sheet does not exist", () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Other");
  assert.equal(readKeyValueSheet(workbook, "Meta"), null);
});

test("readKeyValueSheet reads key/value pairs, lowercasing keys and skipping the header row", () => {
  const workbook = buildWorkbook([
    {
      name: "Meta",
      columns: [{ header: "key", key: "key" }, { header: "value", key: "value" }],
      rows: [
        { key: "Schema_Version", value: "2" },
        { key: "channel_id", value: "UC_TEST" },
      ],
    },
  ]);
  assert.deepEqual(readKeyValueSheet(workbook, "Meta"), { schema_version: "2", channel_id: "UC_TEST" });
});
