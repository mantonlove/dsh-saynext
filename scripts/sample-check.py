#!/usr/bin/env python3
"""统计采样日志里每组「三行是否完整」。

判定（三条同时成立才算完整）：
  1. finish=stop（模型自己收尾，不是被 max_tokens 截断）；
  2. 恰好三行非空候选；
  3. 每行都不以空格/半截结尾（这里用「行数 + finish」间接判定，另给出行长分布）。

用法：
  python3 scripts/sample-check.py samples.log
日志由 `REPLAY_JSON=1 python3 scripts/replay.py 40 > samples.log` 生成。
"""
import json
import re
import sys

path = sys.argv[1]
raw = open(path, encoding='utf-8').read()

finishes = re.findall(r'\(finish=([a-z_]+)', raw)
records = []
for m in re.finditer(r'^JSON (\{.*\})$', raw, re.M):
    records.append(json.loads(m.group(1)))

rows = []
for i, rec in enumerate(records):
    lines = [line.strip() for line in (rec.get('out') or '').split('\n') if line.strip()]
    finish = finishes[i] if i < len(finishes) else 'unknown'
    complete = finish == 'stop' and len(lines) == 3 and all(line[-1] not in '，、' for line in lines)
    rows.append({'i': rec.get('i'), 'finish': finish, 'lines': len(lines),
                 'complete': complete, 'preview': lines[0][:40] if lines else ''})

print(f'样本数 {len(rows)}')
ok = sum(1 for r in rows if r['complete'])
for r in rows:
    print(f"  #{r['i']} finish={r['finish']} lines={r['lines']} 完整={'是' if r['complete'] else '否'} | {r['preview']}")
print(f'三行完整率 {ok}/{len(rows)} = {ok / max(len(rows), 1):.0%}')
