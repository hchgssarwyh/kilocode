# Извлекает bash-команды из локальных транскриптов Claude Code этого проекта (только команды, без вывода).
import json, glob, os
OUT = "D:/itmo/_e2e/corpus/claude-code-commands.jsonl"
n = 0; files = 0
with open(OUT, "w", encoding="utf8") as out:
    for p in glob.glob(os.path.expanduser("~/.claude/projects/D--itmo/*.jsonl")):
        files += 1
        for line in open(p, encoding="utf8", errors="ignore"):
            try: r = json.loads(line)
            except Exception: continue
            msg = r.get("message") or {}
            if r.get("type") != "assistant" or not isinstance(msg.get("content"), list): continue
            for block in msg["content"]:
                if block.get("type") == "tool_use" and block.get("name") == "Bash":
                    cmd = (block.get("input") or {}).get("command")
                    if cmd:
                        out.write(json.dumps({"command": cmd}, ensure_ascii=False) + "\n"); n += 1
print(json.dumps({"files": files, "commands": n}))
