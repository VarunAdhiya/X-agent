# Operations and recovery

Run operator SQL in the Supabase SQL Editor as the migration owner. The application login deliberately cannot edit settings or tables. Keep all publishing flags off during investigation unless you intend a live post.

## Pause switches

```sql
-- Stops generation and NEW publishing claims. Reject/edit actions remain possible.
update agent.automation_settings set paused=true;

-- Stop only live publishing; leave drafting and approval available.
update agent.automation_settings set publishing_enabled=false;

-- Stop model calls and discovery.
update agent.automation_settings set generation_enabled=false;
```

A pause cannot recall a request already sent to X. Disable Workflow D as well when doing planned maintenance, then inspect `publication_attempts` for an in-flight request. Do not clear or recycle a claim just because a process restarted.

Resume explicitly:

```sql
update agent.automation_settings set paused=false, generation_enabled=true;
-- Live publishing stays off unless you separately opt in.
```

## Inspect status

```sql
select id, status, content_version, approved_version, scheduled_at,
       scheduled_at at time zone 'Asia/Kolkata' as scheduled_ist, x_post_id
from agent.tweet_drafts order by created_at desc limit 25;

select workflow_name,event_type,status,error_message,created_at
from agent.automation_logs order by id desc limit 50;

select * from agent.publication_attempts
where state in ('publishing','uncertain','failed') order by started_at desc;

select day,gemini_calls,last_call_at from agent.api_usage order by day desc;

select pg_size_pretty(pg_database_size(current_database()));
```

Application logs contain controlled codes rather than raw API responses or authorization URLs. n8n execution payload persistence is disabled because Telegram input contains a webhook secret. Temporary node output remains visible to the authenticated owner during a manual run; avoid screenshots/exports containing secrets.

## Rerun discovery or generation

Run Workflow A manually after fixing a source failure. It invokes B after discovery succeeds. Or run B's manual trigger after fixing a model/schema problem when sources are already available. A completed IST-day batch cannot create a second set of five; a failed run can be retried. A crashed generation lease becomes reclaimable after ten minutes. Waiting for the lease is safer than deleting the run.

No automatic daily catch-up is attempted after a VM outage. If you rerun after some publishing slots have passed, five pending drafts can still be created, but approval of elapsed slots expires them. They are not posted in a burst. The initial implementation chooses the user's permitted **skip** policy rather than automatic rescheduling.

If fewer than five suitable topics remain, add allowed RSS feeds or additional distinct evergreen prompts in `config/sources.json`; preserve the 14-day exclusion. If source failures prevent adequate evidence, resolve the feed/access issue. Do not mark missing excerpts as verified or invent a news item just to fill the batch.

## Telegram recovery

The webhook validates its shared secret plus sender and private chat IDs before persisting an update. Repeated `update_id` values are ignored. PostgreSQL state transitions check the exact content version. A revision in progress blocks approval.

- Inbox workers lease an item for five minutes, up to three attempts. They never replay a publication request.
- Outbox workers lease messages for five minutes, up to five attempts. A send that succeeds before its database acknowledgement can be delivered twice. This is intentional **at-least-once Telegram delivery**, not exactly-once delivery. Stale message/version buttons are rejected.
- Edit prompts are bound to prompt message ID, sender, chat, draft and version; they expire after one hour. A failed prompt delivery or regeneration cannot preserve the old approval. Monitoring releases abandoned edit/regeneration states to `pending` after one hour, without approving them.
- A draft sent before a process crash might have unusable buttons until delivery is recovered and its message ID is stored. Use the latest delivered message.
- Repeated approve presses before a slot are harmless. Rejecting an already locked/published draft reports a conflict and never deletes an X post.

Inspect exhausted items before retrying:

```sql
select update_id,state,attempts,leased_at from agent.inbox
where state<>'done' order by update_id;
select id,state,attempts,leased_at,payload->>'kind' as kind from agent.outbox
where state<>'done' order by id;
```

After repairing a Telegram token/network problem, an operator can requeue a **notification**:

```sql
update agent.outbox set state='pending',attempts=0,leased_at=null
where id=REPLACE_WITH_REVIEWED_OUTBOX_ID and state<>'done';
```

Avoid bulk resetting the inbox: a repeated edit/regenerate action can already have altered its draft. Inspect the exact content version and use a fresh Telegram action when needed. Prompt expiration, malformed input and authorization failures are not fixed by retries.

## Ambiguous X outcomes

An HTTP timeout may mean X created the post but the response never reached the service. A VM crash after claim is also ambiguous. There is no supported idempotency guarantee assumed for X post creation, so **no retry path automatically republishes that draft**.

1. Pause live publishing.
2. Inspect the attempt ID, draft content, claimed version and timestamp.
3. Look at your own X profile manually to determine whether that exact post exists. This does not require enabling additional paid API reads.
4. If found, copy its numeric post ID and reconcile the existing attempt:

```sql
select agent.command('finish', jsonb_build_object(
  'attempt_id','REPLACE_WITH_EXISTING_ATTEMPT_UUID',
  'state','published',
  'x_post_id','REPLACE_WITH_VERIFIED_NUMERIC_POST_ID'
));
```

This records the existing post; it makes no HTTP request. Only use a verified ID. If the result is still unclear, leave the attempt `uncertain`. Do not delete the attempt, reset the draft to `approved`, or use a database edit to bypass fresh approval. Uncertain attempts reserve capacity for their IST day.

Definite 400/401/403/404/422/429 failures are terminal. Fix permissions, access or quota and use a future fresh daily batch. The initial implementation does not retry failed drafts at a different time; this avoids surprising late posts and preserves attempt history.

## Backups

The `n8n_data` volume and its encryption key are essential. Supabase Free should not be treated as an operator-accessible automatic backup service. Back up both application data and n8n, and keep a copy off the VM.

Install `age` and a `pg_dump` client **at least as new as the database server's major version**. On Ubuntu, `sudo apt-get install age postgresql-client` may supply an older PostgreSQL client; check `pg_dump --version` against `select version()` and install the matching official PostgreSQL package if needed.

On a trusted computer, generate an age identity:

```bash
age-keygen -o x-agent-backup-key.txt
```

Keep that private identity offline. Put only its public `age1...` recipient on the VPS. On the VPS:

```bash
export BACKUP_AGE_RECIPIENT='age1_REPLACE_WITH_PUBLIC_RECIPIENT'
export BACKUP_DATABASE_URL='postgresql://BACKUP_USER:ENCODED_PASSWORD@DB_HOST:5432/postgres?sslmode=verify-full'
# Add sslrootcert=/trusted/path/to/ca.crt to the URL if your connection requires it.
bash deploy/backup.sh
unset BACKUP_DATABASE_URL
```

Use a trusted administrator or dedicated backup connection, not the restricted runtime login. Prefer a protected `.pgpass`/service file instead of an interactive URL if your shell history is shared. The script dumps only the `agent` schema, briefly stops n8n for a consistent cold SQLite copy, includes config/secrets/encryption key, encrypts the archive with age, and restarts n8n even if backup fails. The two databases are not one distributed transaction; on restore, recheck outstanding Telegram and publishing leases.

Copy `backups/TIMESTAMP.tar.gz.age` to a location you already control, for example your local computer. No paid object storage is provisioned. Keep seven daily and four weekly copies only if you have enough free storage; remove old encrypted copies after checking a newer backup. Schedule the script via cron using a root-only wrapper that supplies the protected backup credentials. See `deploy/backup.cron.example`. Check backup logs and periodically test decryption; a file existing is not proof that restore works.

## Restore onto an empty deployment

The deployed `deploy/backup-container.sh` variant uses a PostgreSQL 17 client pinned by image digest and `.env.backup` (mode 0600), with `PGSSLMODE=verify-full`. It reads an age recipient from `secrets/backup-recipient.txt`. This deployment uses the SSH **public** key as the recipient; decrypt with the matching SSH **private** key kept on the laptop. Losing that private key also loses access to these backups. Keep a separate protected copy of the key.

The dedicated `agent_backup` login has SELECT on the private schema's tables/sequences and BYPASSRLS so pg_dump can include all rows. It has no write grants or access to `agent.command`. It is an operator backup credential, never an application credential. `deploy/init-backup.py` creates the protected connection file and emits a SCRAM verifier for an administrator to install; it refuses to overwrite an existing file. Roles/passwords are not included in the schema-only-scope dump and must be recreated on restoration.

`deploy/backup-container.cron` is installed for 03:30 IST, with a lock to prevent overlap and seven-day local retention. `deploy/backup.logrotate` bounds the log. The first archive was copied to the laptop; **automatic off-VM replication is not configured**. Download fresh encrypted copies periodically. Same-VM backups alone do not protect against VM loss.

For this variant, the archive contains `.env` and `.env.backup`; the original host-client script instead names the primary environment file `env`. Restore the appropriate file to `.env`. The following restore steps apply to either variant.

1. Keep the old VM stopped/paused so two schedulers cannot run simultaneously. Provision another eligible free VM and install Docker.
2. Restore only in a private directory. Decrypted archives contain credentials.

```bash
umask 077
mkdir -p restore
age -d -i /trusted/path/x-agent-backup-key.txt backups/TIMESTAMP.tar.gz.age | tar -xz -C restore
```

3. Create a **blank** Supabase Free database/project as needed. Do not apply the initial schema migration on top of a schema restored by `pg_restore`. Create `agent_runtime` first if absent, then restore as the database owner:

```sql
create role agent_runtime nologin;
```

```bash
pg_restore --dbname="$RESTORE_ADMIN_DATABASE_URL" --no-owner --no-acl --exit-on-error restore/agent.dump
```

4. Reapply access grants and pause the restored system before starting any worker:

```sql
revoke all on schema agent from public;
revoke all on all tables in schema agent from public,agent_runtime;
revoke all on all functions in schema agent from public;
grant usage on schema agent to agent_runtime;
grant execute on function agent.command(text,jsonb) to agent_runtime;
alter default privileges in schema agent revoke execute on functions from public;
update agent.automation_settings set paused=true,publishing_enabled=false;
```

Create a fresh runtime login and grant `agent_runtime` as described in the README. RLS is preserved in the dump. Test that the login can execute `settings` and cannot select tables.

5. Copy `restore/env` to `.env` and restore `config` and any CA files. Update database hostname/login and DNS as needed. Set `PUBLISHING_ENABLED=false`, `X_COST_APPROVED=false` and retain the original `N8N_ENCRYPTION_KEY`. Rotate credentials if the prior machine was compromised.
6. Create stopped containers and restore the n8n directory into the persistent volume:

```bash
docker compose create
docker compose cp restore/n8n/. n8n:/home/node/.n8n/
docker compose run --rm --no-deps --user root --entrypoint sh n8n -c 'chown -R node:node /home/node/.n8n'
docker compose up -d
```

Do not copy this directory over an active n8n SQLite database. The generated initial deployment does not contain any backup to restore automatically.

7. Keep the database paused while checking workflow credentials, references, webhook ownership and outstanding publishing attempts. Run monitor once: old claims become uncertain, never automatically retryable. Then resume generation and dry-run acceptance tests. Delete the decrypted restore directory securely according to your storage policy and retain the encrypted archive.

## Troubleshooting

| Symptom | Check |
|---|---|
| HTTPS certificate fails | DNS A/AAAA, inbound 80/443, hostname, Caddy logs and ACME limits. No purchase is required for a certificate. |
| Webhook is 404 | Workflow C active/published; production `/webhook/telegram-approval`, not `/webhook-test/...`; correct domain. |
| Webhook is 401/403 | Both header credentials, bot webhook secret, user/chat allowlists in env **and** database. |
| Database TLS fails | Correct CA/session-pooler host, encoded password, no SSL URL override; do not disable verification in production. |
| `permission denied` | Login inherits `agent_runtime`; schema usage + function execution granted; direct table denial is expected. |
| Gemini 429 | Your actual free quota may be below the local cap. Wait; reduce usage, never upgrade automatically. |
| Invalid AI JSON | Inspect model support and bounded output; rerun B after fixing it. No partial batch is saved. |
| Draft skipped | Approval arrived after slot, or scheduler missed its five-minute grace. It will not catch up later. |
| `uncertain` publishing | Follow reconciliation, not replay. |
| Bot receives no messages | Bot started, token valid, chat correct, outbox leases/dead letters, E active. |
| VPS stopped/reclaimed | Restore from off-VM backup; same-machine monitoring cannot alert while its VM is offline. |

Emergency n8n alerts have a one-hour best-effort throttle using workflow static data. Normal alerts deduplicate transactionally in PostgreSQL. n8n static data is saved on successful active executions; it is not a distributed exactly-once guarantee, particularly during concurrent outage errors or manual tests.
