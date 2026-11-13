#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo 'Copy .env.example to .env and configure it first'; exit 1; }
chmod 600 .env
mkdir -p secrets backups
chmod 700 secrets backups
docker compose config --quiet
docker compose build --pull agent
docker compose pull n8n caddy
docker compose up -d
docker compose ps
echo 'Configure the private n8n editor through the SSH tunnel. Workflows are inactive until imported and configured.'
