// Index guard for the split docs (docs/roadmap/plans/DOCS_SPLIT_PLAN.md §5): every `##`/`###` heading of a
// docs/system/*.md (except component-status.md) and docs/architecture/*.md must have a row in its index
// (docs/SYSTEM_MAP.md, docs/ARCHITECTURE.md), and every index row's file must exist and contain that section.
// Usage: node scripts/check-doc-index.mjs   (exit 1 with a list of problems)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZE_LIMIT = 30 * 1024;

function headingLines(text) {
  const out = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) fence = !fence;
    if (!fence && /^#{2,3} /.test(line)) out.push(line);
  }
  return out;
}

function rows(indexText, folder) {
  const re = new RegExp("^\\| (\\S+(?: / \\S+)?) \\|.*`docs/" + folder + "/([a-z0-9-]+)\\.md` \\|$");
  return indexText.split("\n").map((l) => re.exec(l)).filter(Boolean).map((m) => ({ id: m[1], file: m[2] }));
}

export function checkDocIndex(repoRoot) {
  const problems = [];
  const docs = path.join(repoRoot, "docs");
  const specs = [
    { index: "SYSTEM_MAP.md", folder: "system", idOf: (h) => /^### (\S+)/.exec(h)?.[1], levels: /^### /, skip: ["component-status"] },
    { index: "ARCHITECTURE.md", folder: "architecture", idOf: (h) => { const m = /^## (\d+)\./.exec(h) ?? /^## (BL-\d+(?: \/ BL-\d+)?) —/.exec(h); return m?.[1].replace(" / ", "/"); }, levels: /^## / , skip: [] },
  ];
  for (const s of specs) {
    const indexPath = path.join(docs, s.index);
    const indexText = readFileSync(indexPath, "utf8");
    if (Buffer.byteLength(indexText) > SIZE_LIMIT) problems.push(`${s.index} is larger than 30 KB`);
    if (indexText.split("\n")[0] !== "Read this index whole; open only the subsystem file you touch.") problems.push(`${s.index}: first line is not the read-whole-index line`);
    const tableRows = rows(indexText, s.folder);
    const folderPath = path.join(docs, s.folder);
    const files = readdirSync(folderPath).filter((f) => f.endsWith(".md"));
    const seen = new Map();
    for (const f of files) {
      const name = f.replace(/\.md$/, "");
      if (s.skip.includes(name)) continue;
      for (const h of headingLines(readFileSync(path.join(folderPath, f), "utf8"))) {
        if (!s.levels.test(h)) continue;
        const id = s.idOf(h);
        if (!id) { problems.push(`${s.folder}/${f}: heading without a recognizable id: ${h.slice(0, 60)}`); continue; }
        if (seen.has(id)) problems.push(`${s.folder}: id ${id} appears in ${seen.get(id)} and ${f}`);
        seen.set(id, f);
      }
    }
    const byId = new Map(tableRows.map((r) => [r.id, r.file + ".md"]));
    for (const r of tableRows) {
      if (!existsSync(path.join(folderPath, r.file + ".md"))) problems.push(`${s.index}: row ${r.id} points to missing file ${r.file}.md`);
    }
    for (const [id, f] of seen) {
      if (!byId.has(id)) problems.push(`${s.index}: no row for ${id} (in ${s.folder}/${f})`);
      else if (byId.get(id) !== f) problems.push(`${s.index}: row ${id} says ${byId.get(id)} but the section is in ${f}`);
    }
    for (const id of byId.keys()) if (!seen.has(id)) problems.push(`${s.index}: row ${id} has no section in ${s.folder}/`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkDocIndex(root);
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log("doc indexes OK");
}
