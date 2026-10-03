import assert from "node:assert/strict";
import test from "node:test";
import { guardFormula, toCsv } from "./csv";

// Expected strings are written out by hand from RFC 4180 and the guard rule in csv.ts's header (AGENTS.md §L).

test("header and rows are CRLF-terminated, null is an empty cell, numbers and booleans are written as-is", () => {
  const csv = toCsv(["a", "b", "c", "d"], [{ a: "x", b: 12, c: null, d: false }]);
  assert.equal(csv, "a,b,c,d\r\nx,12,,false\r\n");
});

test("a field with a comma, quote, CR or LF is quoted and its quotes doubled", () => {
  const csv = toCsv(["t"], [{ t: 'He said "hi", twice' }, { t: "line1\nline2" }, { t: "a\r\nb" }]);
  assert.equal(csv, 't\r\n"He said ""hi"", twice"\r\n"line1\nline2"\r\n"a\r\nb"\r\n');
});

test("a text cell that could be read as a spreadsheet formula gets an apostrophe; a negative NUMBER is left alone", () => {
  assert.equal(guardFormula("=HYPERLINK(\"http://x\")"), "'=HYPERLINK(\"http://x\")");
  assert.equal(guardFormula("+1"), "'+1");
  assert.equal(guardFormula("-5 degrees"), "'-5 degrees");
  assert.equal(guardFormula("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(guardFormula("\tcmd"), "'\tcmd");
  assert.equal(guardFormula("plain = title"), "plain = title");
  assert.equal(guardFormula(""), "");
  assert.equal(toCsv(["n", "t"], [{ n: -5, t: "-5" }], ["t"]), "n,t\r\n-5,'-5\r\n");
});

test("only the named columns are guarded: an unguarded column keeps a leading @ or - exactly (handles and ids are join keys)", () => {
  assert.equal(toCsv(["handle", "title"], [{ handle: "@TheNeiro", title: "@TheNeiro" }], ["title"]), "handle,title\r\n@TheNeiro,'@TheNeiro\r\n");
  assert.equal(toCsv(["id"], [{ id: "-abc_DEF" }]), "id\r\n-abc_DEF\r\n");
});

test("hostile title: formula lead AND comma AND quote together is guarded first, then quoted", () => {
  // guarded text is `'=A,"B"` -> contains comma and quote -> wrapped, quotes doubled
  assert.equal(toCsv(["t"], [{ t: '=A,"B"' }], ["t"]), 't\r\n"\'=A,""B"""\r\n');
});

test("no rows: just the header line", () => {
  assert.equal(toCsv(["a", "b"], []), "a,b\r\n");
});
