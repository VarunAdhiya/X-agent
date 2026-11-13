#!/usr/bin/env python3
"""Create a private initial .env and emit only a PostgreSQL SCRAM verifier.

Run on the trusted VPS before setting up its dedicated database login.
The generated plaintext password remains in .env; it is never printed.
"""
import argparse
import base64
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets

parser = argparse.ArgumentParser()
parser.add_argument('--project-ref', required=True)
args = parser.parse_args()
if not re.fullmatch(r'[a-z]{20}', args.project_ref):
    raise SystemExit('Invalid project reference')
root = Path(__file__).resolve().parent.parent
target = root / '.env'
if target.exists():
    raise SystemExit('.env already exists; refusing to overwrite credentials')
password = secrets.token_urlsafe(36)
values = {
    'N8N_ENCRYPTION_KEY': secrets.token_hex(32),
    'INTERNAL_API_TOKEN': secrets.token_hex(32),
    'TELEGRAM_WEBHOOK_SECRET': secrets.token_hex(32),
    'DATABASE_URL': f'postgresql://agent_login.{args.project_ref}:{password}@POOLER_HOST_PENDING:5432/postgres',
}
lines = []
for line in (root / '.env.example').read_text().splitlines():
    key = line.split('=', 1)[0]
    lines.append(f'{key}={values[key]}' if key in values else line)
descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, 'w') as output:
    output.write('\n'.join(lines) + '\n')
salt = secrets.token_bytes(16)
salted = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 4096)
stored = hashlib.sha256(hmac.digest(salted, b'Client Key', 'sha256')).digest()
server = hmac.digest(salted, b'Server Key', 'sha256')
b64 = lambda value: base64.b64encode(value).decode('ascii')
print(f'SCRAM-SHA-256$4096:{b64(salt)}${b64(stored)}:{b64(server)}')
