#!/usr/bin/env python3
"""Create a backup-only connection file and emit its SCRAM verifier, never its password."""
import base64
import hashlib
import hmac
import os
from pathlib import Path
import secrets
from urllib.parse import urlsplit

root = Path(__file__).resolve().parent.parent
env = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines()
           if line and not line.startswith('#') and '=' in line)
url = urlsplit(env['DATABASE_URL'])
ref = url.username.split('.', 1)[1]
password = secrets.token_urlsafe(36)
values = {'PGHOST': url.hostname, 'PGPORT': str(url.port or 5432),
          'PGUSER': 'agent_backup.' + ref, 'PGPASSWORD': password, 'PGDATABASE': 'postgres',
          'PGSSLMODE': 'verify-full', 'PGSSLROOTCERT': '/run/secrets/db-ca.crt',
          'PGOPTIONS': '-c default_transaction_read_only=on'}
with os.fdopen(os.open(root / '.env.backup', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
    out.write('\n'.join(f'{k}={v}' for k, v in values.items()) + '\n')
salt = secrets.token_bytes(16)
salted = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 4096)
stored = hashlib.sha256(hmac.digest(salted, b'Client Key', 'sha256')).digest()
server = hmac.digest(salted, b'Server Key', 'sha256')
b64 = lambda v: base64.b64encode(v).decode()
print(f'SCRAM-SHA-256$4096:{b64(salt)}${b64(stored)}:{b64(server)}')
