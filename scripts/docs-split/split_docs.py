#!/usr/bin/env python3
"""Stage B split of docs/SYSTEM_MAP.md and docs/ARCHITECTURE.md (docs/roadmap/plans/DOCS_SPLIT_PLAN.md).

Usage: split_docs.py <repo> <system|architecture> [--src-dir DIR]
Reads the ORIGINAL document (from `git show <orig-rev>:docs/X.md`, default HEAD) and writes the index plus
docs/system/*.md or docs/architecture/*.md. Moves are verbatim by whole section.
"""
import re, subprocess, sys, os, collections

DATE = '2026-11-17'

SYS_MAP = {
 'auth-identity': '2.1 2.2 2.3 2.15',
 'youtube-gateways': '2.4 2.9f 2.9g 2.9k 2.9at',
 'persistence-tests': '2.5 2.14',
 'channel-video-sync': '2.6 2.7',
 'localization': '2.8 2.9u 2.9ay',
 'changesets-batches': '2.9 2.9a 2.9au',
 'ai-localization': '2.9b 2.9c',
 'video-details': '2.9d 2.9e',
 'device-sync': '2.9h 2.9m 2.16a 2.16',
 'analytics': '2.9i 2.9n 2.9o 2.9p 2.9q 2.9t 2.9z',
 'analytics-stored-data': '2.9ad 2.9ae 2.9af 2.9ap 2.9ah',
 'cloud': '2.9j 2.9l 2.9ap2',
 'agent-operations': '2.9r 2.9s 2.9y 2.9aa 2.9ab 2.9ba 2.9bh',
 'market-intelligence': '2.9v 2.9ac',
 'decision-engine': '2.9w 2.9ag',
 'channel-workspaces': '2.9x 2.9w2',
 'media-generation': '2.9x2 2.9ai 2.9ax 2.9ak 2.9aw 2.9bb 2.9av',
 'media-review': '2.9al 2.9ao 2.9aj 2.9az 2.9bg 2.9bd',
 'video-costs': '2.9aq',
 'live-streams': '2.9am',
 'publishing': '2.9an 2.9bc 2.9bf 2.9bl 2.9bn 2.9bm',
 'web-ui': '2.10 2.9ar 2.9as',
 'interfaces': '2.11 2.12 2.13',
 'disk-hygiene': '2.9be',
}
ARCH_MAP = {
 'youtube-gateways': '22 24',
 'persistence-tests': '7',
 'channel-video-sync': '4 8',
 'localization': '5 46',
 'changesets-batches': '6 10 11 12',
 'video-details': '9',
 'device-sync': '13 23 30 31',
 'analytics': '14',
 'analytics-stored-data': '36 37 38 39 40 49',
 'cloud': '15 16 50',
 'agent-operations': '17 21 25 34 BL-228 BL-248 BL-271',
 'market-intelligence': '18 35',
 'decision-engine': '19',
 'channel-workspaces': '20',
 'media-generation': '26 29',
 'media-generation-runpod': '41 BL-199/BL-134 BL-200',
 'media-generation-gemini': '43',
 'media-review': '42 44 48 BL-229 BL-236 BL-241',
 'video-costs': '51 52',
 'live-streams': '45 BL-207',
 'publishing': '47 BL-225 BL-238 BL-255 BL-257 BL-263 BL-265 BL-267 BL-269',
 'channel-identity-writers': 'BL-210 BL-223',
 'web-ui': '32 33 BL-221',
 'disk-hygiene': 'BL-237',
}

# Review fix: ids that were duplicated between SYSTEM_MAP §2 and §4 (status entries) become unique. verify_split.py imports this.
RENAMES = [
    ('### 2.9bm Мелкие', '### 2.9bm2 Мелкие'),
    ('### 2.9bn Ожидание', '### 2.9bn2 Ожидание'),
    ('### 2.9bm Английские', '### 2.9bm3 Английские'),
    ('### 2.9bl Замена', '### 2.9bl2 Замена'),
    ('субтитры — BL-269 `video-captions`, §2.9bm)', 'субтитры — BL-269 `video-captions`, §2.9bm3)'),
]

def apply_renames(lines):
    for a, b in RENAMES:
        hit = [i for i, l in enumerate(lines) if a in l]
        assert len(hit) == 1, (a, hit)
        lines[hit[0]] = lines[hit[0]].replace(a, b, 1)
    return lines

def git_show(repo, rev, path):
    return subprocess.run(['git', '-C', repo, 'show', f'{rev}:{path}'], check=True, capture_output=True).stdout.decode('utf-8')

def headings(lines, pat):
    out, fence = [], False
    for i, l in enumerate(lines):
        if l.startswith('```'):
            fence = not fence
        if not fence and re.match(pat, l):
            out.append(i)
    return out

def inverse(m):
    inv = {}
    for f, ids in m.items():
        for i in ids.split():
            assert i not in inv, i
            inv[i] = f
    return inv

def trunc(s, n):
    s = s.strip()
    return s if len(s) <= n else s[:n - 1].rstrip() + '…'

def esc(s):
    return s.replace('|', '\\|')

def main():
    repo, kind = sys.argv[1], sys.argv[2]
    rev = sys.argv[3] if len(sys.argv) > 3 else 'HEAD'
    if kind == 'system':
        src, mp = 'docs/SYSTEM_MAP.md', SYS_MAP
    else:
        src, mp = 'docs/ARCHITECTURE.md', ARCH_MAP
    text = git_show(repo, rev, src)
    lines = text.split('\n')
    assert lines[-1] == ''
    lines = lines[:-1]  # drop empty tail from final newline; re-add on write
    if kind == 'system':
        lines = apply_renames(lines)
    inv = inverse(mp)
    outdir = os.path.join(repo, 'docs', 'system' if kind == 'system' else 'architecture')
    os.makedirs(outdir, exist_ok=True)
    files = collections.OrderedDict((f, []) for f in mp)
    rows = []
    if kind == 'system':
        h2 = headings(lines, r'## ')
        idx_of = {lines[i].split()[1]: i for i in h2}
        # top-level ## sections: 1,2,3,4,5
        starts = {lines[i][3:].split('.')[0]: i for i in h2}
        end = len(lines)
        def seg(a, b): return lines[a:b]
        header = seg(0, starts['1'])
        s1 = seg(starts['1'], starts['2'])
        s2_start, s3_start = starts['2'], starts['3']
        s3 = seg(starts['3'], starts['4'])
        s4 = seg(starts['4'], starts['5'])
        s5 = seg(starts['5'], end)
        h3 = [i for i in headings(lines, r'### ') if s2_start < i < s3_start]
        s2_intro = seg(s2_start, h3[0])
        for k, i in enumerate(h3):
            j = h3[k + 1] if k + 1 < len(h3) else s3_start
            h = lines[i]
            sid = h.split()[1]
            f = inv.get(sid)
            assert f, f'section {sid} not mapped'
            files[f].append(lines[i:j])
            rest = h.split(None, 2)[2] if len(h.split(None, 2)) > 2 else ''
            name = re.split(r' — |\s\(', rest)[0]
            m = re.search(r'—\s*\*\*(.+?)\*\*', h) or re.search(r'\*\*(.+?)\*\*', h)
            status = m.group(1) if m else '—'
            rows.append((sid, name, status, f))
        assert set(inv) == {r[0] for r in rows}, set(inv) ^ {r[0] for r in rows}
        files['component-status'] = [s4]
        for i in headings(s4, r'###? '):
            h = s4[i]
            m = re.match(r'### (\S+)\s+(.*)', h)
            if not m:
                continue
            sid, rest = m.group(1), m.group(2)
            name = re.split(r' — |\s\(', rest)[0]
            mm = re.search(r'—\s*\*\*(.+?)\*\*', h) or re.search(r'\*\*(.+?)\*\*', h)
            rows.append((sid, name, mm.group(1) if mm else '—', 'component-status'))
        rows.append(('4', 'Статус компонентов (весь §4, подразделы выше — его записи)', '—', 'component-status'))
        mp = dict(mp); mp['component-status'] = ''
        origin = 'SYSTEM_MAP.md §2'
        idxname = '../SYSTEM_MAP.md'
        for f, secs in files.items():
            org = 'SYSTEM_MAP.md §4' if f == 'component-status' else origin
            write(os.path.join(outdir, f + '.md'), org, idxname, secs)
        idx = ['Read this index whole; open only the subsystem file you touch.', '']
        idx += header + s1
        idx += [s2_intro[0], '',
                'Каждая строка — один подраздел §2: он перенесён дословно, с тем же заголовком и номером, в файл из последней колонки '
                f'(перенос {DATE}, `docs/roadmap/plans/DOCS_SPLIT_PLAN.md`). `§2.9am` ищется по номеру в этой таблице; '
                'вторые 2.9w/2.9x/2.9ap названы 2.9w2/2.9x2/2.9ap2. Новый подраздел — новая строка здесь и запись в файле домена.',
                '', '| № | Подсистема | Статус | Файл |', '|---|---|---|---|']
        for sid, name, status, f in rows:
            idx.append(f'| {sid} | {esc(trunc(name, 70))} | {esc(trunc(status, 40))} | `docs/system/{f}.md` |')
        idx += ['']
        idx += s3
        idx += ['## 4. Статус компонентов', '',
                'Перенесён дословно в `docs/system/component-status.md` (20 КБ, список статусов по подсистемам и ключевые ограничения 4.0).',
                '', '---', '']
        idx += s5
        write_raw(os.path.join(repo, src), idx)
    else:
        h2 = headings(lines, r'## ')
        first = next(i for i in h2 if re.match(r'## 4\.', lines[i]))
        index_part = lines[:first]
        for k, i in enumerate(h2):
            if i < first:
                continue
            j = h2[k + 1] if k + 1 < len(h2) else len(lines)
            h = lines[i]
            m = re.match(r'## (\d+)\.\s+(.*)', h)
            if m:
                sid, title = m.group(1), m.group(2)
            else:
                m = re.match(r'## (BL-\d+(?: / BL-\d+)?) — (.*)', h)
                assert m, h
                sid = m.group(1).replace(' / ', '/').replace('/BL-', '/BL-')
                title = m.group(2)
            f = inv.get(sid)
            assert f, f'section {sid} not mapped'
            files[f].append(lines[i:j])
            rows.append((sid, title, f))
        assert set(inv) == {r[0] for r in rows}, set(inv) ^ {r[0] for r in rows}
        for f, secs in files.items():
            write(os.path.join(outdir, f + '.md'), 'ARCHITECTURE.md', '../ARCHITECTURE.md', secs)
        idx = ['Read this index whole; open only the subsystem file you touch.', '']
        idx += index_part
        idx += ['## Sections 4 and later', '',
                f'Every section below was moved verbatim ({DATE}, `docs/roadmap/plans/DOCS_SPLIT_PLAN.md`), with its original heading and number, '
                'into the file in the last column; `ARCHITECTURE.md §47` is found by its number here. A new section is a new row here and an entry in the domain file.',
                '', '| § | Section | File |', '|---|---|---|']
        for sid, title, f in rows:
            idx.append(f'| {sid} | {esc(trunc(re.split(r" — | \(", title)[0], 80))} | `docs/architecture/{f}.md` |')
        write_raw(os.path.join(repo, src), idx)

def write(path, origin, idxname, secs):
    out = [f'> Moved verbatim from {origin} on {DATE}; index: {idxname}', '']
    for s in secs:
        out += s
    write_raw(path, out)

def write_raw(path, out):
    while out and out[-1] == '':
        out = out[:-1]
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(out) + '\n')

if __name__ == '__main__':
    main()
