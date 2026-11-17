#!/usr/bin/env python3
"""Proof for the stage B split. Usage: verify_split.py <repo> <orig-rev>
Every non-empty line of the original SYSTEM_MAP.md / ARCHITECTURE.md must appear byte-identical in the new
files (multiset check: count in new files >= count in original, no original line lost, none duplicated),
and every line that is NOT from the original must match the allowed additions (index table/header lines,
one origin line per moved file). Also checks each original ### / ## heading appears in exactly one new file
and that no relative markdown link needed a `../` fix."""
import sys, re, glob, os, subprocess, collections

repo, rev = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from split_docs import RENAMES  # the review-fix id renames in component-status.md and one reference
def show(p): return subprocess.run(['git','-C',repo,'show',f'{rev}:{p}'],check=True,capture_output=True).stdout.decode()
def lines_of(t):
    out = []
    for l in t.split('\n'):
        for a, b in RENAMES:  # expected renamed form of the original line
            if a in l: l = l.replace(a, b, 1)
        if l.strip(): out.append(l)
    return out
ok = True
ALLOWED = [r'^> Moved verbatim from (SYSTEM_MAP|ARCHITECTURE)\.md( §\d)? on 2026-11-17; index: \.\./(SYSTEM_MAP|ARCHITECTURE)\.md$',
           r'^Read this index whole; open only the subsystem file you touch\.$',
           r'^\| .* \|$', r'^Каждая строка — один подраздел', r'^Every section below was moved verbatim',
           r'^## Sections 4 and later$', r'^## 4\. Статус компонентов$', r'^Перенесён дословно в `docs/system/component-status\.md`',
           r'^\|[-|]+\|$', r'^---$', r'^## 2\. Подсистемы$']  # table rows (| ... |) cover the component-status rows too
for doc, sub in (('SYSTEM_MAP','system'), ('ARCHITECTURE','architecture')):
    orig = lines_of(show(f'docs/{doc}.md'))
    index = lines_of(open(f'{repo}/docs/{doc}.md',encoding='utf-8').read())
    files = sorted(glob.glob(f'{repo}/docs/{sub}/*.md'))
    new = list(index)
    per = {}
    for f in files:
        ls = lines_of(open(f,encoding='utf-8').read())
        per[f] = ls
        new += ls
    co, cn = collections.Counter(orig), collections.Counter(new)
    lost = co - cn
    extra = cn - co
    print(f'[{doc}] original non-empty lines: {len(orig)}; new total: {len(new)}; files: {len(files)}')
    print(f'  lost original lines: {sum(lost.values())}')
    for l,n in list(lost.items())[:10]: print('   LOST', n, l[:100])
    bad = [l for l in extra.elements() if not any(re.search(p,l) for p in ALLOWED)]
    print(f'  added lines: {sum(extra.values())} (not matching allowed patterns: {len(bad)})')
    for l in bad[:10]: print('   UNEXPECTED', l[:100])
    # heading uniqueness: every original ##/### heading must be present in new files exactly as many times as original
    hs = [l for l in orig if re.match(r'#{2,3} ', l)]
    hc = collections.Counter(hs)
    sub_count = collections.Counter(l for ls in per.values() for l in ls if re.match(r'#{2,3} ', l))
    idx_count = collections.Counter(l for l in index if re.match(r'#{2,3} ', l))
    multi = {h:(hc[h], sub_count[h]) for h in hc if sub_count[h] + idx_count[h] < hc[h]}
    print(f'  headings missing from new files: {len(multi)}')
    # each moved heading lives in exactly one subsystem file (or the index for kept sections)
    where = collections.defaultdict(set)
    for f, ls in per.items():
        for l in ls:
            if re.match(r'#{2,3} ', l): where[l].add(os.path.basename(f))
    spread = {h: s for h, s in where.items() if len(s) > 1 and hc.get(h, 0) <= 1}
    print(f'  headings (unique in original) found in more than one file: {len(spread)}')
    links = [l for l in orig if re.search(r'\]\((?!https?:|#)[^)]+\)', l)]
    print(f'  original lines with relative markdown links (would need ../): {len(links)}')
    if lost or bad or multi or spread or links: ok = False
    sz = os.path.getsize(f'{repo}/docs/{doc}.md')
    print(f'  index size: {sz} bytes (limit 30720)')
    if sz > 30720: ok = False
print('PROOF OK' if ok else 'PROOF FAILED')
sys.exit(0 if ok else 1)
