#!/usr/bin/env python3
"""One-time import of inactive workflows and internal credentials after owner setup.

Run on the VPS from a trusted account with Docker access. Credentials travel over
stdin into a private temporary file and are encrypted by n8n during import.
Existing workflow IDs must not be in use. A marker prevents accidental reruns.
"""
import json
import os
from pathlib import Path
import subprocess
import uuid

root = Path(__file__).resolve().parent.parent
os.chdir(root)
marker = root / 'secrets' / 'n8n-bootstrap.json'
if marker.exists():
    raise SystemExit('Bootstrap was already attempted. Inspect its marker and n8n before retrying.')
base = ['docker', 'compose', 'exec', '-T', 'n8n']
existing = subprocess.run(base + ['n8n', 'list:workflow', '--onlyId'],
                          capture_output=True, text=True, check=True)
if existing.stdout.strip():
    raise SystemExit('Expected an empty n8n workflow list. Import manually to preserve existing workflows.')
env = {}
for line in (root / '.env').read_text().splitlines():
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        env[key] = value
specs = [
    ('Agent internal API — configure after import', 'X-Agent-Token', 'INTERNAL_API_TOKEN'),
    ('Telegram webhook secret — configure after import', 'X-Telegram-Bot-Api-Secret-Token', 'TELEGRAM_WEBHOOK_SECRET'),
]
credentials = []
for name, header, key in specs:
    if len(env.get(key, '')) < 32:
        raise SystemExit('Configure strong internal/webhook secrets first')
    credentials.append({'id': uuid.uuid4().hex[:16], 'name': name, 'type': 'httpHeaderAuth',
                        'data': {'name': header, 'value': env[key]}})
ids = {item['name']: item['id'] for item in credentials}
workflows = []
for path in sorted((root / 'workflows').glob('*.json')):
    workflow = json.loads(path.read_text())
    workflow['active'] = False
    for node in workflow['nodes']:
        for credential in node.get('credentials', {}).values():
            if credential['name'] in ids:
                credential['id'] = ids[credential['name']]
    workflows.append(workflow)
if len(workflows) != 5:
    raise SystemExit('Expected five workflow files')
marker.parent.mkdir(exist_ok=True)
with os.fdopen(os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
    json.dump({'status': 'started', 'credential_ids': ids}, output)
temporary = '/tmp/x-agent-bootstrap-' + uuid.uuid4().hex + '.json'
try:
    for kind, payload in [('credentials', credentials), ('workflow', workflows)]:
        subprocess.run(base + ['sh', '-c', 'umask 077; cat > "$1"', 'sh', temporary],
                       input=json.dumps(payload).encode(), check=True)
        subprocess.run(base + ['n8n', 'import:' + kind, '--input=' + temporary], check=True)
    marker.write_text(json.dumps({'status': 'complete', 'credential_ids': ids}) + '\n')
    print('Imported five inactive workflows and two internal header credentials. Telegram bot credential remains pending.')
finally:
    subprocess.run(base + ['rm', '-f', temporary], check=False)
