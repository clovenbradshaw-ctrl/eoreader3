#!/usr/bin/env python3
"""
Aozora Bunko HTML -> clean UTF-8 plain text.

Aozora files are Shift_JIS HTML with a specific markup vocabulary:
  - <ruby><rb>KANJI</rb><rp>(</rp><rt>READING</rt><rp>)</rp></ruby>  furigana
  - 《READING》 inline furigana (in the text-file convention; some HTML keeps it)
  - ｜ (U+FF5C) ruby anchor marking where a reading group starts
  - ［＃...］ editorial annotation (gaiji notes, emphasis dots, indentation)
  - a bibliographic header block and a 底本 (source edition) footer block

This strips all of that and emits the body prose only, so the reading engine
sees what a Japanese reader sees: the base text, no reading aids, no markup.
"""
import re
import sys
import os

def clean_aozora(raw_bytes):
    # 1. Decode Shift_JIS (Aozora's encoding). Fall back to cp932 (superset).
    for enc in ('shift_jis', 'cp932', 'euc_jp'):
        try:
            html = raw_bytes.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        html = raw_bytes.decode('shift_jis', errors='replace')

    # 2. Pull the title from <title> for a header line (kept, it's real text).
    m = re.search(r'<title>(.*?)</title>', html, re.S)
    title = re.sub(r'\s+', ' ', m.group(1)).strip() if m else ''

    # 3. Isolate the main body. Aozora opens it with <div class="main_text">
    #    and the body can contain NESTED <div> (jisage indentation blocks), so
    #    a non-greedy match to the first </div> truncates. Instead, slice from
    #    main_text to the bibliographic footer (or end of file).
    start = html.find('<div class="main_text">')
    if start >= 0:
        start += len('<div class="main_text">')
        end = html.find('<div class="bibliographical_information">', start)
        if end < 0:
            end = html.find('<div class="after_text">', start)
        if end < 0:
            end = len(html)
        body = html[start:end]
    else:
        body = html

    # 4. Remove ruby furigana entirely (keep base, drop reading).
    #    <ruby>...<rb>BASE</rb>...<rt>READING</rt>...</ruby>  -> BASE
    def strip_ruby(match):
        chunk = match.group(0)
        rb = re.findall(r'<rb>(.*?)</rb>', chunk, re.S)
        if rb:
            return ''.join(rb)
        # no <rb>: base text sits as bare text nodes; drop <rt>...</rt> then tags
        chunk = re.sub(r'<rt>.*?</rt>', '', chunk, flags=re.S)
        chunk = re.sub(r'<rp>.*?</rp>', '', chunk, flags=re.S)
        return re.sub(r'<[^>]+>', '', chunk)
    body = re.sub(r'<ruby>.*?</ruby>', strip_ruby, body, flags=re.S)

    # 5. Editorial annotations ［＃...］ -> drop.
    body = re.sub(r'［＃.*?］', '', body)

    # 6. Inline furigana 《...》 and ruby anchor ｜ (text-convention residue).
    body = re.sub(r'《.*?》', '', body)
    body = body.replace('｜', '').replace('\uFF5C', '')

    # 7. <br/> -> newline; strip all remaining tags.
    body = re.sub(r'<br\s*/?>', '\n', body)
    body = re.sub(r'<[^>]+>', '', body)

    # 8. HTML entities we care about.
    for a, b in (('&nbsp;', ' '), ('&lt;', '<'), ('&gt;', '>'),
                 ('&amp;', '&'), ('&quot;', '"')):
        body = body.replace(a, b)

    # 9. Whitespace: collapse runs of blank lines, strip line-leading spaces
    #    that are layout, keep paragraph structure.
    lines = [ln.rstrip() for ln in body.splitlines()]
    out, blank = [], 0
    for ln in lines:
        s = ln.strip()
        if not s:
            blank += 1
            if blank <= 1 and out:
                out.append('')
            continue
        blank = 0
        out.append(s)
    text = '\n'.join(out).strip()

    return title, text

def main():
    src_dir = sys.argv[1] if len(sys.argv) > 1 else 'evo/fixtures/japanese/raw'
    out_dir = sys.argv[2] if len(sys.argv) > 2 else 'evo/fixtures/japanese'
    os.makedirs(out_dir, exist_ok=True)
    rows = []
    for fn in sorted(os.listdir(src_dir)):
        if not fn.endswith('.html'):
            continue
        stem = fn[:-5]
        raw = open(os.path.join(src_dir, fn), 'rb').read()
        title, text = clean_aozora(raw)
        outp = os.path.join(out_dir, stem + '.txt')
        with open(outp, 'w', encoding='utf-8') as f:
            f.write(text + '\n')
        chars = len(text)
        # crude sentence count on Japanese full stop
        sents = text.count('。')
        rows.append((stem, title, chars, sents))
    # report
    print(f"{'file':28} {'title':24} {'chars':>8} {'sentences':>10}")
    print('-' * 74)
    for stem, title, chars, sents in rows:
        print(f"{stem:28} {title[:24]:24} {chars:>8} {sents:>10}")

if __name__ == '__main__':
    main()
