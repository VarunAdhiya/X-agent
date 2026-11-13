#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${BACKUP_DATABASE_URL:?Use a backup-only/admin PostgreSQL connection with TLS verification}"
: "${BACKUP_AGE_RECIPIENT:?Set an age PUBLIC recipient; keep its private key off the VPS}"
command -v age >/dev/null
command -v pg_dump >/dev/null
umask 077
mkdir -p backups
stage=$(mktemp -d)
finish() { docker compose start n8n >/dev/null; rm -rf -- "$stage"; }
trap finish EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)
# Application changes are transactionally consistent within the PostgreSQL dump.
pg_dump "$BACKUP_DATABASE_URL" --schema=agent --no-owner --no-acl --format=custom --file="$stage/agent.dump"
# Cold copy SQLite, including any journal files; never copy a live SQLite file.
docker compose stop n8n
docker compose cp n8n:/home/node/.n8n "$stage/n8n"
cp .env "$stage/env"
cp -r config secrets "$stage/"
tar -C "$stage" -czf - . | age -r "$BACKUP_AGE_RECIPIENT" -o "backups/$stamp.tar.gz.age"
echo "Encrypted backup created: backups/$stamp.tar.gz.age"
echo 'Copy it to storage you already own; VM-local backups do not survive VM loss.'
