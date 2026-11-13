#!/usr/bin/env python3
"""Configure Telegram secrets and n8n monitoring after verifying the private chat.

Stage the bot token in secrets/telegram-token.txt (0600) on the VPS first.
The database allowlist must be configured separately by its administrator.
This does not activate workflows, register a webhook, or enable X publishing.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--user-id', required=True)
args = parser.parse_args()
if not re.fullmatch(r'[1-9][0-9]{0,15}', args.user_id):
    raise SystemExit('Expected a positive numeric Telegram user ID')
root = Path(__file__).resolve().parent.parent
os.chdir(root)
token = (root / 'secrets/telegram-token.txt').read_text().strip()
if not re.fullmatch(r'[0-9]+:[A-Za-z0-9_-]{20,}', token):
    raise SystemExit('Invalid token file')
base = ['docker', 'compose', 'exec', '-T', 'n8n']
temporary = '/tmp/x-agent-telegram-' + uuid.uuid4().hex + '.json'
marker = root / 'secrets/telegram-credential.json'
credential_id = json.loads(marker.read_text())['id'] if marker.exists() else uuid.uuid4().hex[:16]
try:
    # Export the actual installed workflow so unrelated settings are preserved.
    subprocess.run(base + ['n8n', 'export:workflow', '--id=XAgentMonitoring', '--output=' + temporary], check=True)
    exported = subprocess.run(base + ['cat', temporary], capture_output=True, check=True)
    workflows = json.loads(exported.stdout)
    if len(workflows) != 1 or workflows[0]['id'] != 'XAgentMonitoring' or workflows[0].get('active'):
        raise SystemExit('Expected the inactive monitoring workflow; unpublish it before configuration')
    nodes = [node for node in workflows[0]['nodes'] if node['name'] == 'Emergency Telegram alert']
    if len(nodes) != 1:
        raise SystemExit('Expected exactly one emergency Telegram node')
    nodes[0]['parameters']['chatId'] = args.user_id
    nodes[0]['credentials']['telegramApi'] = {'id': credential_id, 'name': 'X Agent Telegram bot'}
    credentials = [{'id': credential_id, 'name': 'X Agent Telegram bot', 'type': 'telegramApi',
                    'data': {'accessToken': token, 'baseUrl': 'https://api.telegram.org'}}]
    if not marker.exists():
        with os.fdopen(os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
            json.dump({'id': credential_id}, out)
    for kind, payload in [('credentials', credentials), ('workflow', workflows)]:
        subprocess.run(base + ['sh', '-c', 'umask 077; cat > "$1"', 'sh', temporary],
                       input=json.dumps(payload).encode(), check=True)
        subprocess.run(base + ['n8n', 'import:' + kind, '--input=' + temporary], check=True)
    values = {'TELEGRAM_BOT_TOKEN': token, 'TELEGRAM_CHAT_ID': args.user_id,
              'TELEGRAM_ALLOWED_USER_IDS': args.user_id}
    lines = (root / '.env').read_text().splitlines()
    configured = []
    for line in lines:
        key = line.split('=', 1)[0]
        configured.append(f'{key}={values.pop(key)}' if key in values else line)
    configured.extend(f'{key}={value}' for key, value in values.items())
    temp_env = root / ('.env.telegram-' + uuid.uuid4().hex)
    with os.fdopen(os.open(temp_env, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
        out.write('\n'.join(configured) + '\n')
    os.replace(temp_env, root / '.env')
    print('Configured bot credential, private chat, and service allowlist. Recreate agent to load changes.')
finally:
    subprocess.run(base + ['rm', '-f', temporary], check=False)
