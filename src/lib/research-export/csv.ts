/**
 * Pure CSV serialization for the research export (RFC 4180: CRLF row ends, a field containing a comma, a double quote, CR or LF is
 * wrapped in double quotes with embedded quotes doubled). A text cell that a spreadsheet could read as a formula (first character
 * `=`, `+`, `-`, `@`, TAB or CR) is prefixed with an apostrophe -- the usual guard against formula injection from a hostile video
 * title. Numbers and booleans are never altered (a negative number is data, not a formula); the JSON twin of every file keeps
 * text exactly as stored for a script that must not see the guard.
 */
export type CsvCell = string | number | boolean | null;

const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function guardFormula(text: string, exempt: readonly string[] = []): string {
  return text.length > 0 && FORMULA_LEAD.has(text[0]) && !exempt.includes(text[0]) ? `'${text}` : text;
}

function encodeCell(cell: CsvCell, guard: boolean, exempt: readonly string[]): string {
  if (cell === null) return "";
  const raw = typeof cell === "string" && guard ? guardFormula(cell, exempt) : String(cell);
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

/**
 * `guardColumns` names the free-text columns (video titles) that get the formula guard. It is per column, not global, because a handle such
 * as `@TheNeiro` legitimately starts with `@` and an id may start with `-` -- guarding those would corrupt the very keys a script joins on.
 */
export function toCsv<C extends string>(
  columns: readonly C[],
  rows: ReadonlyArray<Record<C, CsvCell>>,
  guardColumns: readonly C[] = [],
  /** Columns guarded except for a leading `@` or `-` (a channel handle such as `@TheNeiro` is a legitimate value there). */
  handleColumns: readonly C[] = []
): string {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(
      columns
        .map((column) =>
          guardColumns.includes(column)
            ? encodeCell(row[column], true, [])
            : handleColumns.includes(column)
              ? encodeCell(row[column], true, ["@", "-"])
              : encodeCell(row[column], false, [])
        )
        .join(",")
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
