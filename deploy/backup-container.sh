#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Pinned digest of the official PostgreSQL 17 client image verified for this deployment.
image=postgres@sha256:e5d2edd28b1f8d40a0a6c0c9cdc545b19b56a0d5d88f94bc11a97d970d4700d0
[[ -f .env.backup && -f secrets/backup-recipient.txt ]]
command -v age >/dev/null
umask 077
mkdir -p backups
chown --reference="$PWD" backups
stage=$(mktemp -d)
stopped=false
finish() {
  if "$stopped"; then docker compose start n8n >/dev/null; fi
  rm -rf -- "$stage"
}
trap finish EXIT
docker run --rm --env-file .env.backup -v "$PWD/secrets:/run/secrets:ro" \
  -v "$stage:/backup" "$image" pg_dump --schema=agent --no-owner --no-acl \
  --format=custom --file=/backup/agent.dump
docker compose stop n8n
stopped=true
docker compose cp n8n:/home/node/.n8n "$stage/n8n"
cp .env .env.backup "$stage/"
cp -r config secrets "$stage/"
output="backups/$(date -u +%Y%m%dT%H%M%SZ).tar.gz.age"
tar -C "$stage" -czf - . | age -r "$(cat secrets/backup-recipient.txt)" -o "$output"
chown --reference="$PWD" "$output"
echo "Encrypted backup: $output"
# Retain seven days; off-VM copies must be managed separately.
find "$PWD/backups" -maxdepth 1 -type f -name '*.tar.gz.age' -mmin +10080 -delete
