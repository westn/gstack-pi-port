#!/usr/bin/env bash
set -euo pipefail

echo "Searching GitHub for gstack ports/wrappers..."
echo

json1=$(gh search repos "garrytan gstack" --limit 50 --json fullName,description,url,isFork,updatedAt)
python - "$json1" <<'PY'
import json
import re
import sys

items = json.loads(sys.argv[1])
keywords = re.compile(r"(pi|codex|cursor|wrapper|plugin|port)", re.I)

print("Matches for 'garrytan gstack':")
for it in items:
    text = f"{it.get('fullName','')} {it.get('description') or ''}"
    if keywords.search(text):
        print(f"- {it['fullName']}: {it.get('description') or ''}")
        print(f"  {it['url']}")
print()
PY

echo "Direct query: 'gstack pi'"
json2=$(gh search repos "gstack pi" --limit 20 --json fullName,description,url)
python - "$json2" <<'PY'
import json
import sys

items = json.loads(sys.argv[1])
if not items:
    print("- No repositories returned for 'gstack pi'.")
else:
    for it in items:
        print(f"- {it['fullName']}: {it.get('description') or ''}")
        print(f"  {it['url']}")
PY
