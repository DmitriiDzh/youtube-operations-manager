import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkDocIndex } from "../../scripts/check-doc-index.mjs";

// docs/roadmap/plans/DOCS_SPLIT_PLAN.md §5: SYSTEM_MAP.md and ARCHITECTURE.md are indexes (<= 30 KB) over
// docs/system/*.md and docs/architecture/*.md; every section is listed in its index and every row has its section.
test("SYSTEM_MAP.md and ARCHITECTURE.md indexes list every section of their subsystem files", () => {
  assert.deepEqual(checkDocIndex(path.resolve(process.cwd())), []);
});

const FIRST = "Read this index whole; open only the subsystem file you touch.";

type Fixture = { sysRows: string[]; archRows: string[]; sysFiles: Record<string, string>; archFiles: Record<string, string> };

function baseFixture(): Fixture {
  return {
    sysRows: ["| 2.1 | One | IMPLEMENTED | `docs/system/a.md` |", "| 2.2 | Two | IMPLEMENTED | `docs/system/a.md` |", "| 2.9bm2 | Status only | — | `docs/system/component-status.md` |", "| 4 | Status | — | `docs/system/component-status.md` |"],
    archRows: ["| 4 | Sync | `docs/architecture/a.md` |", "| BL-210 | Own | `docs/architecture/a.md` |"],
    sysFiles: { "a.md": "> origin\n\n### 2.1 One\ntext\n\n### 2.2 Two\ntext\n", "component-status.md": "> origin\n\n## 4. Status\n\n### 2.9bm2 Status only\ntext\n" },
    archFiles: { "a.md": "> origin\n\n## 4. Phase 2 sync\n\n### 4.1 sub\n\n## BL-210 — Own\n" },
  };
}

function check(mutate: (f: Fixture) => void): string[] {
  const root = mkdtempSync(path.join(os.tmpdir(), "doc-index-"));
  try {
    const f = baseFixture();
    mutate(f);
    mkdirSync(path.join(root, "docs", "system"), { recursive: true });
    mkdirSync(path.join(root, "docs", "architecture"), { recursive: true });
    writeFileSync(path.join(root, "docs", "SYSTEM_MAP.md"), `${FIRST}\n\n| № | Name | Status | File |\n|---|---|---|---|\n${f.sysRows.join("\n")}\n`);
    writeFileSync(path.join(root, "docs", "ARCHITECTURE.md"), `${FIRST}\n\n| § | Section | File |\n|---|---|---|\n${f.archRows.join("\n")}\n`);
    for (const [n, t] of Object.entries(f.sysFiles)) writeFileSync(path.join(root, "docs", "system", n), t);
    for (const [n, t] of Object.entries(f.archFiles)) writeFileSync(path.join(root, "docs", "architecture", n), t);
    return checkDocIndex(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("guard: a consistent fixture has no problems", () => {
  assert.deepEqual(check(() => {}), []);
});

test("guard: a section without an index row fails", () => {
  const p = check((f) => { f.sysRows = f.sysRows.filter((r) => !r.startsWith("| 2.2 ")); });
  assert.ok(p.some((x) => x.includes("no row for 2.2")), p.join("\n"));
});

test("guard: an index row pointing at a missing file or without a section fails", () => {
  const p = check((f) => { f.sysRows.push("| 2.5 | Ghost | — | `docs/system/missing.md` |"); });
  assert.ok(p.some((x) => x.includes("missing file")), p.join("\n"));
  assert.ok(p.some((x) => x.includes("row 2.5 has no section")), p.join("\n"));
});

test("guard: a ### id that lives only in component-status.md needs a row", () => {
  const p = check((f) => { f.sysRows = f.sysRows.filter((r) => !r.startsWith("| 2.9bm2 ")); });
  assert.ok(p.some((x) => x.includes("no row for 2.9bm2")), p.join("\n"));
});

test("guard: a numbered ## heading in docs/system needs a row", () => {
  const p = check((f) => { f.sysRows = f.sysRows.filter((r) => !r.startsWith("| 4 ")); });
  assert.ok(p.some((x) => x.includes("no row for 4 ")), p.join("\n"));
});

test("guard: duplicate index row ids fail", () => {
  const p = check((f) => { f.archRows.push("| BL-210 | Own again | `docs/architecture/a.md` |"); });
  assert.ok(p.some((x) => x.includes("duplicate index row id BL-210")), p.join("\n"));
});

test("guard: the same heading id in two files fails", () => {
  const p = check((f) => { f.sysFiles["b.md"] = "> origin\n\n### 2.1 Again\n"; });
  assert.ok(p.some((x) => x.includes("id 2.1 appears in")), p.join("\n"));
});

test("guard: a row naming the wrong file fails", () => {
  const p = check((f) => { f.sysFiles["b.md"] = "> origin\n\n### 2.7 Seven\n"; f.sysRows.push("| 2.7 | Seven | — | `docs/system/a.md` |"); });
  assert.ok(p.some((x) => x.includes("row 2.7 says a.md but the section is in b.md")), p.join("\n"));
});
