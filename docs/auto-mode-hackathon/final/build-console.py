# Собирает автономный HTML консоли: шаблон + данные + встроенные шрифты + логотипы (data URI).
# Запуск: python -X utf8 D:/itmo/_e2e/corpus/build-console.py
import base64, json, os, glob, mimetypes

ROOT = "D:/itmo/_e2e"
SCRATCH = "C:/Users/magom/AppData/Local/Temp/claude/D--itmo/b82770ba-793e-4737-87ae-833ea23b53d2/scratchpad"
TEMPLATE = f"{ROOT}/corpus/console.template.html"
DATA = f"{SCRATCH}/demo-data.json"
OUT = [f"{ROOT}/auto-mode-console.html", f"{SCRATCH}/auto-mode-console.html"]

t = open(TEMPLATE, encoding="utf8").read()

# --- шрифты: один @font-face на подмножество, Inter как вариативный (400–700)
faces = []
seen = set()
for m in json.load(open(f"{ROOT}/fonts/manifest.json")):
    key = (m["family"], m["subset"]) if m["family"] == "Inter" else (m["family"], m["weight"], m["subset"])
    if key in seen:
        continue
    seen.add(key)
    b64 = base64.b64encode(open(f"{ROOT}/fonts/{m['file']}", "rb").read()).decode()
    weight = "400 700" if m["family"] == "Inter" else m["weight"]
    faces.append(f"@font-face{{font-family:'{m['family']}';font-style:normal;font-weight:{weight};font-display:swap;src:url(data:font/woff2;base64,{b64}) format('woff2');unicode-range:{m['range']};}}")
t = t.replace("/*__FONTS__*/", "\n".join(faces))

# --- логотипы: alfa, aith, itmo в этом порядке, только существующие файлы
order = ["alfa", "aith", "itmo"]
alt = {"alfa": "Альфа-Банк", "aith": "AI Talent Hub", "itmo": "Университет ИТМО"}
imgs = []
for name in order:
    files = sorted(glob.glob(f"{ROOT}/logos/{name}.*"))
    if not files:
        continue
    f = files[0]
    mime = mimetypes.guess_type(f)[0] or "image/png"
    b64 = base64.b64encode(open(f, "rb").read()).decode()
    imgs.append(f'<img src="data:{mime};base64,{b64}" alt="{alt[name]}" class="logo logo-{name}">')
t = t.replace("/*__LOGOS__*/", '<span class="sep"></span>'.join(imgs))

# --- данные
d = open(DATA, encoding="utf8").read().replace("</", r"<\/")
t = t.replace("/*__DATA__*/", d)

for o in OUT:
    os.makedirs(os.path.dirname(o), exist_ok=True)
    open(o, "w", encoding="utf8").write(t)
print("built", [o for o in OUT], "bytes", len(t), "logos", len(imgs), "faces", len(faces))
