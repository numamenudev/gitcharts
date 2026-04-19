"""Send a screenshot file to Telegram using credentials from .env."""
import os, sys, pathlib, re, requests

env_path = pathlib.Path(__file__).parent / ".env"
env = {}
for line in env_path.read_text(encoding="utf-8").splitlines():
    m = re.match(r"\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)", line)
    if m:
        env[m.group(1)] = m.group(2).strip().strip('"').strip("'")

token = env.get("TELEGRAM_TOKEN") or env.get("TELEGRAM_BOT_TOKEN")
chat_id = env.get("CHAT_ID") or env.get("TELEGRAM_CHAT_ID")
if not token or not chat_id:
    print("Missing TELEGRAM_TOKEN / CHAT_ID in .env", file=sys.stderr)
    sys.exit(2)

path = sys.argv[1]
caption = sys.argv[2] if len(sys.argv) > 2 else ""
with open(path, "rb") as fh:
    r = requests.post(
        f"https://api.telegram.org/bot{token}/sendPhoto",
        data={"chat_id": chat_id, "caption": caption},
        files={"photo": fh},
        timeout=60,
    )
print(r.status_code, r.text[:200])
r.raise_for_status()
