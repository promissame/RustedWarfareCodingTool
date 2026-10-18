import os, re, html, sys

p = os.path.join(os.environ['TEMP'], 'zzddj.html')
raw = open(p, encoding='utf-8', errors='replace').read()

m = re.search(r'<div id="page-content">(.*?)<div class="page-tags"', raw, re.S)
if not m:
    m = re.search(r'<div id="page-content">(.*)', raw, re.S)
t = m.group(1) if m else raw

# keep block-level line structure
t = re.sub(r'<script.*?</script>', '', t, flags=re.S)
t = re.sub(r'<style.*?</style>', '', t, flags=re.S)
t = re.sub(r'<br\s*/?>', '\n', t)
t = re.sub(r'</(p|div|h1|h2|h3|h4|li|tr|blockquote)>', '\n', t)
t = re.sub(r'<td[^>]*>', ' | ', t)
t = re.sub(r'<[^>]+>', '', t)
t = html.unescape(t)
t = t.replace('\u00a0', ' ')
t = re.sub(r'[ \t]+\n', '\n', t)
t = re.sub(r'\n{3,}', '\n\n', t)

out = t.strip()
open(os.path.join(os.environ['TEMP'], 'zzddj.txt'), 'w', encoding='utf-8').write(out)
sys.stdout.reconfigure(encoding='utf-8')
print('CHARS:', len(out))
print(out)
