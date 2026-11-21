"""用真实会话上下文复跑一次候选生成，便于评测提示词/闸门改动（不写任何载荷）。

用法：python3 scripts/replay.py 40            # turn 40
环境变量：REPLAY_SESSION / REPLAY_MODE(new|old) / REPLAY_SAMPLES / REPLAY_TURNS
"""
#!/usr/bin/env python3
"""用真实 turn 90 的上下文重跑一次生成，比较「旧提示词 vs 新提示词」的输出是否还含 trace。"""
import json, os, subprocess, sys, urllib.request

SESSION = os.environ.get('REPLAY_SESSION') or os.path.expanduser('~/.dsh/sessions/--Users-manton-CC-projects-dsh~5F00~53D1--/session-4f2dadb1-5a8c-4254-b708-58be95c28e04/session.v4.jsonl.zstd')
MAX_TURNS = 4
MAX_TRANSCRIPT_CHARS = 4000

def text_of(data):
    parts = []
    for block in data.get('content') or []:
        if block.get('type') == 'text' and isinstance(block.get('text'), str):
            parts.append(block['text'])
    return '\n'.join(parts).strip()

def events():
    raw = subprocess.run(['zstd', '-dc', SESSION], capture_output=True).stdout.decode('utf-8', 'ignore')
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except Exception:
            continue

def messages_until_turn_end(target_turn):
    out = []
    for ev in events():
        t = ev.get('type')
        if t in ('user/message', 'assistant/message'):
            data = ev.get('data') or {}
            if t == 'assistant/message':
                data = data.get('message') or {}
            text = text_of(data)
            role = 'user' if t == 'user/message' else 'assistant'
            if text:
                out.append({'role': role, 'text': text})
        elif t == 'turn/end':
            turn = ((ev.get('data') or {}).get('turn') or {}).get('turn') if isinstance((ev.get('data') or {}).get('turn'), dict) else (ev.get('data') or {}).get('turn')
            if turn == target_turn:
                break
    return out

def frame(all_msgs):
    kept, chars, budget = [], 0, MAX_TRANSCRIPT_CHARS
    for msg in reversed(all_msgs):
        text = msg['text']
        if text == '':
            continue
        size = len(text) + 3
        if size > budget:
            if not kept and budget > 40:
                tail = text[-(budget - 3):]
                kept.append({'role': msg['role'], 'text': tail})
                chars += len(tail)
            break
        budget -= size
        chars += len(text)
        kept.append(msg)
        if len(kept) >= MAX_TURNS * 2:
            break
    lines = [f"{'用户' if m['role'] == 'user' else 'AI'}：{m['text']}" for m in reversed(kept)]
    tail = ''
    for m in reversed(kept):
        if m['role'] == 'assistant':
            tail = m['text'][-400:]
            break
    prompt = '\n'.join([p for p in [
        '以下是这条会话最近的对话：',
        '\n'.join(lines),
        f'AI 最后一条的结尾（节选）：{tail}' if tail else '',
        '判断用户此刻最有价值的下一步，写成他可以直接发送的一句话。',
    ] if p])
    return prompt, chars

def system_prompt(path, marker):
    src = open(path, encoding='utf-8').read()
    start = src.index('const SYSTEM = [')
    end = src.index("].join('\\n')", start)
    body = src[start:end]
    parts = []
    for line in body.split('\n')[1:]:
        line = line.strip().rstrip(',')
        if line.startswith("'"):
            parts.append(line[1:-1] if line.endswith("'") else line[1:])
    return '\n'.join(parts)

def call(system, prompt, model):
    key = os.environ.get('MOARK_API_KEY', '').strip()
    if not key:
        got = subprocess.run(['security', 'find-generic-password', '-s', 'CC/MOARK_API_KEY', '-w'],
                             capture_output=True, text=True).stdout.strip()
        key = got
    if not key:
        import re as _re
        text = open(os.path.expanduser('~/.dsh/.credentials.yaml'), encoding='utf-8').read()
        m = _re.search(r'^\s*MOARK_API_KEY\s*:\s*(\S+)\s*$', text, _re.MULTILINE)
        key = m.group(1) if m else ''
    if not key:
        raise SystemExit('no MOARK key')
    body = json.dumps({
        'model': model,
        'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': prompt}],
        'max_tokens': int(os.environ.get('REPLAY_MAX_TOKENS', '1200')),
        'temperature': 0.3,
    }).encode()
    req = urllib.request.Request('https://api.moark.com/v1/chat/completions', data=body,
                                 headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read())
    ch = data['choices'][0]
    print(f"  (finish={ch.get('finish_reason')} usage={data.get('usage',{}).get('completion_tokens')})")
    return (ch['message'].get('content') or '').strip()

target = int(sys.argv[1]) if len(sys.argv) > 1 else 90
msgs = messages_until_turn_end(target)
print(f'turn {target} 结束前的消息数: {len(msgs)}')
prompt, chars = frame(msgs)
print(f'prompt 字符数: {chars}')
print('--- prompt 末尾 300 字 ---')
print(prompt[-300:])
print('---')

path = '/Users/manton/CC/projects/dsh开发/dsh-saynext/lib/index.js'
new_sys = system_prompt(path, 'new')
old_sys = new_sys.replace('\n- 不要复用你上一条回答里的术语、变量名、命令名或代号（例如 trace、repeat-user、publish ok），\n   也不要用它们造句；用户已经看过那句话，不需要你把话再说一遍；', '')
print('新提示词含「不要复用」规则:', '不要复用你上一条回答里的术语' in new_sys)

mode = os.environ.get('REPLAY_MODE', 'both')
sample_n = int(os.environ.get('REPLAY_SAMPLES', '1'))
pairs = []
if mode in ('both', 'old'):
    pairs.append(('旧', old_sys))
if mode in ('both', 'new'):
    pairs.append(('新', new_sys))
if mode == 'variant':
    variant = new_sys.replace(
        '   也不要用它们造句；用户已经看过那句话，不需要你把话再说一遍；',
        '   也不要用它们造句；凡是上一条回答里出现过的英文词、文件名、命令名（trace.log、repeat-user 这类），整句都不要出现；用户已经看过那句话，不需要你再讲一遍；')
    pairs.append(('变体', variant))
for label, sysprompt in pairs:
    hits = 0
    for i in range(sample_n):
        out = call(sysprompt, prompt, 'DeepSeek-V4.1-Flash-1017')
        hit = 'trace' in out.lower()
        hits += hit
        print(f'[{label}{i+1}] {out or "<空>"} | trace={hit}')
    print(f'[{label}] 含 trace 次数 {hits}/{sample_n}')
