"""Copies the third-party built-in Skills into this directory with front matter our parser accepts (roadmap-6 A3).

Usage: python3 packages/server/skills/import.py [<dir with the repos already cloned>]
Clones each repo at the commit pinned in COMMITS unless a directory is given; bump a commit there to update a Skill.
Needs PyYAML. Skills written by hand (generative-ui) are not touched.
"""
import os, re, shutil, subprocess, sys, tempfile
import yaml

DEST = os.path.dirname(os.path.abspath(__file__))
COMMITS = {
  'op7418_Humanizer-zh': 'f4518a8eab97b8bfebc66a89d34320a89bef6930',
  'anthropics_skills': '2c5958ecac7cee2b583967a2c4981d0f4a75c579',
  'K-Dense-AI_scientific-agent-skills': '2d2065fb4520fa3f3f2bcf61cff26ec8b7eba4b5',
  'JimLiu_baoyu-skills': 'ca703c2d7c2c4399a1dc0cf82224f8551e05a96d',
  'xstongxue_best-skills': '9aa4e555950da6e43e7d98c5f0c7b70264204850',
}

SKILLS = [
  # (dest name, repo dir, path in repo, repo url, license file in repo, excluded paths, extra description, body replacements)
  ('humanizer-zh', 'op7418_Humanizer-zh', '.', 'https://github.com/op7418/Humanizer-zh', 'LICENSE', ['tests', 'README.md', 'CHANGELOG.md', '.git', '.github'], '触发词：去 AI 味、润色、改得自然一点。', []),
  ('pdf', 'anthropics_skills', 'skills/pdf', 'https://github.com/anthropics/skills', 'skills/pdf/LICENSE.txt', [], '触发词：PDF、合并、拆分、提取表格、填表。', [(
    '### reportlab - Create PDFs\n',
    '### reportlab - Create PDFs\n\n**Chinese, Japanese or Korean text**: reportlab\'s standard fonts (Helvetica, Times) have no CJK glyphs and print black boxes. Register the built-in CID font and use it for every CJK string: `from reportlab.pdfbase import pdfmetrics; from reportlab.pdfbase.cidfonts import UnicodeCIDFont; pdfmetrics.registerFont(UnicodeCIDFont(\'STSong-Light\'))`, then `c.setFont(\'STSong-Light\', 12)` or `ParagraphStyle(..., fontName=\'STSong-Light\')`. Do not point `TTFont` at the Noto CJK files: they are CFF-based OpenType, which reportlab cannot embed.\n',
    '在 reportlab 一节加上中日韩文字要注册 CID 字体的说明')]),
  ('xlsx', 'anthropics_skills', 'skills/xlsx', 'https://github.com/anthropics/skills', 'skills/xlsx/LICENSE.txt', [], '触发词：Excel、表格文件、xlsx、csv。', []),
  ('docx', 'anthropics_skills', 'skills/docx', 'https://github.com/anthropics/skills', 'skills/docx/LICENSE.txt', [], '触发词：Word、docx、做成 Word 文档。', []),
  ('markitdown', 'K-Dense-AI_scientific-agent-skills', 'skills/markitdown', 'https://github.com/K-Dense-AI/scientific-agent-skills', 'LICENSE.md', [], '触发词：把文档转成文本、读取 Word / PPT / Excel / PDF 内容。', []),
  ('paper-lookup', 'K-Dense-AI_scientific-agent-skills', 'skills/paper-lookup', 'https://github.com/K-Dense-AI/scientific-agent-skills', 'LICENSE.md', [], '触发词：查论文、查 DOI、谁引用了这篇、找 PDF。', []),
  ('literature-review', 'K-Dense-AI_scientific-agent-skills', 'skills/literature-review', 'https://github.com/K-Dense-AI/scientific-agent-skills', 'LICENSE.md', [], '触发词：文献综述、调研某个方向的论文。', []),
  ('baoyu-translate', 'JimLiu_baoyu-skills', 'skills/baoyu-translate', 'https://github.com/JimLiu/baoyu-skills', 'LICENSE', [], '', [(
    '- **Not found** → **BLOCKING** first-time setup before any translation; never silently use defaults. Ask all questions in [references/config/first-time-setup.md](references/config/first-time-setup.md) (target language, mode, audience, style, save location) in ONE call, write EXTEND.md at the chosen location, confirm "Preferences saved to [path]", then continue.',
    '- **Not found** → translate with defaults (target: 简体中文, or English when the source is already Chinese; mode: normal; audience: general; style: storytelling), and after the translation mention once that the user can save preferences by going through [references/config/first-time-setup.md](references/config/first-time-setup.md). Run that setup only when the user asks for it.', '没有偏好文件时不再阻塞式询问，直接用默认值翻译')]),
  ('md-report-summary', 'xstongxue_best-skills', 'skills/md-report-summary', 'https://github.com/xstongxue/best-skills', 'LICENSE', [], '', [('`WebSearch`', '`web_search`', '把 `WebSearch` 换成本项目的 `web_search`')]),
]

if len(sys.argv) > 1: SRC = sys.argv[1]
else:
  SRC = tempfile.mkdtemp()
  for repo, commit in COMMITS.items():
    target = os.path.join(SRC, repo)
    subprocess.check_call(['git', 'init', '-q', target])
    subprocess.check_call(['git', '-C', target, 'fetch', '-q', '--depth', '1', 'https://github.com/' + repo.replace('_', '/', 1), commit])
    subprocess.check_call(['git', '-C', target, 'checkout', '-q', 'FETCH_HEAD'])

FRONT = re.compile(r'^---\r?\n(.*?)\r?\n---\r?\n?(.*)$', re.S)

for name, repo, path, url, license_file, excluded, extra, replacements in SKILLS:
  src = os.path.join(SRC, repo, path)
  dest = os.path.join(DEST, name)
  shutil.rmtree(dest, ignore_errors=True)
  shutil.copytree(src, dest, ignore=lambda d, names: [n for n in names if os.path.relpath(os.path.join(d, n), src) in excluded or n == '.git'])
  commit = subprocess.check_output(['git', '-C', os.path.join(SRC, repo), 'rev-parse', 'HEAD'], text=True).strip()
  assert commit == COMMITS[repo], (repo, commit)
  raw = open(os.path.join(dest, 'SKILL.md'), encoding='utf-8').read()
  m = FRONT.match(raw)
  meta, body = yaml.safe_load(m.group(1)), m.group(2)
  front = {'name': name, 'description': ' '.join(str(meta['description']).split()) + (' ' + extra if extra else '')}
  if meta.get('license'): front['license'] = str(meta['license'])
  if meta.get('compatibility'): front['compatibility'] = str(meta['compatibility'])
  flat = {k: str(v) for k, v in (meta.get('metadata') or {}).items() if isinstance(v, (str, int, float))}
  flat.update({'source': f'{url}/tree/{commit}/{path}'.replace('/.', '').rstrip('/')})
  front['metadata'] = flat
  for old, new, _ in replacements:
    assert old in body, (name, old[:40])
    body = body.replace(old, new)
  out = '---\n' + yaml.safe_dump(front, allow_unicode=True, sort_keys=False, width=10**6) + '---\n' + ('' if body.startswith('\n') else '\n') + body
  open(os.path.join(dest, 'SKILL.md'), 'w', encoding='utf-8').write(out)
  lic = os.path.join(SRC, repo, license_file)
  if os.path.relpath(lic, src).startswith('..'): shutil.copy(lic, os.path.join(dest, os.path.basename(license_file)))
  changes = '改了 SKILL.md 的 front matter（去掉本项目不用的字段，补中文触发词，加 metadata.source）' + ('，并改了正文：' + '；'.join(d for _, _, d in replacements) if replacements else '') + '。'
  if excluded: changes += f"没有复制：{'、'.join(e for e in excluded if e not in ('.git', '.github'))}。"
  open(os.path.join(dest, 'SOURCE.md'), 'w', encoding='utf-8').write(f'# 来源\n\n由 `../import.py` 生成，不要手改。\n\n- 上游：{url}（`{path}`）\n- 提交：`{commit}`\n- 许可证：见本目录的 {os.path.basename(license_file)}\n- 改动：{changes}\n')
  print(name, len(front['description']))
