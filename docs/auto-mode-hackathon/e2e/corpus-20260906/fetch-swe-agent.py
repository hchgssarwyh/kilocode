import json, sys, time, re, urllib.request, urllib.parse
DS = "nebius/SWE-agent-trajectories"
OUT = "D:/itmo/_e2e/corpus/swe-agent-actions.jsonl"
offsets = [0, 7000, 14000, 21000, 28000, 35000, 42000, 49000, 56000, 63000, 70000, 77000]
fence = re.compile(r"```(?:\w+)?\n(.*?)```", re.S)
rows_total = 0; actions = 0; nofence = 0
with open(OUT, "w", encoding="utf8") as out:
    for off in offsets:
        url = f"https://datasets-server.huggingface.co/rows?dataset={urllib.parse.quote(DS, safe='')}&config=default&split=train&offset={off}&length=25"
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=180) as r:
                    d = json.load(r)
                break
            except Exception as e:
                print("retry", off, attempt, e, file=sys.stderr); time.sleep(3)
        else:
            continue
        for row in d.get("rows", []):
            row = row["row"]; rows_total += 1
            for item in row.get("trajectory", []):
                if item.get("role") not in ("assistant", "ai"): continue
                text = item.get("text") or ""
                blocks = fence.findall(text)
                if not blocks:
                    nofence += 1; continue
                act = blocks[-1].strip()
                if not act: continue
                actions += 1
                out.write(json.dumps({"instance": row.get("instance_id"), "model": row.get("model_name"), "action": act}, ensure_ascii=False) + "\n")
        print(f"offset {off}: rows {len(d.get('rows', []))}, actions so far {actions}", file=sys.stderr)
print(json.dumps({"rows": rows_total, "actions": actions, "assistant_without_fence": nofence}))
