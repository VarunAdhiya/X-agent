# Verification record and deployment acceptance

## Local evidence

Verification date: **9 November 2026 (Asia/Kolkata)**.

- `npm run verify`: workflow structure checks and **34 passing tests** on Node 24.19.0.
- The initial SQL migration was executed against PGlite's PostgreSQL engine, including PL/pgSQL and runtime role checks. Runtime direct SELECT/UPDATE was denied; allowed function execution succeeded.
- A full five-draft generation used deterministic mock model output. A Telegram update was authenticated and persisted, the exact version approved, then an actual HTTP request reached a **local mock X server**. Its returned ID was saved. A repeat publishing execution sent no second request.
- Dry-run used the same approval and claim path, produced `simulated`, and never invoked X transport.
- An embedded database was closed and reopened on disk; stored data and a version-bound approval survived.
- `docker compose config --quiet` succeeded with a temporary placeholder-only `.env`. That file was removed afterward. Compose validation does not start containers.
- Registry manifests resolved for `n8nio/n8n:2.46.6`, `caddy:2.11.9-alpine` and `node:24.19.0-alpine`.
- `npm audit --omit=dev` reported zero known vulnerabilities at verification time. This is not a container/host security audit.

## Cloud setup evidence — 12 November 2026 (Asia/Kolkata)

- Connected through SSH to the user-created Oracle Ubuntu 24.04 ARM64 VM, with approximately 6 GB RAM and a 45 GB root filesystem.
- Installed Docker Engine and Compose from Docker's Ubuntu repository; verified the Docker service is enabled at boot.
- Built the agent image on the VM and pulled the pinned n8n/Caddy images.
- Imported all five workflow JSON files successfully into an ephemeral n8n 2.46.6 container. This validates import, not workflow execution; the temporary database was discarded.
- Created the dedicated Supabase project after its cost check returned $0/month. Applied the schema and created a restricted runtime login using a server-generated password.
- Verified 11 private tables have RLS, no runtime direct table read/update access, and only the intended command execution grant. Security advisors returned only informational notices for private RLS tables with no public policies.
- Connected from the production agent container using the Supavisor session pooler with certificate and hostname verification enabled. The Supabase CA came from the official dashboard's HTTPS download URL. Database settings reported publishing disabled, Asia/Kolkata timezone and a daily limit of five.
- Started persistent agent and n8n containers; both passed Docker health checks. n8n binds only to VM loopback port 5678.
- Verified the private editor returns HTTP 200 through a local SSH tunnel and `/healthz` returns `ok`. The user completed owner account setup.
- Imported all five workflows into persistent n8n, with two generated internal header credentials bound to their nodes. They were initially inactive; current activation status is recorded below.
- Executed Workflow D through the actual n8n CLI with dry-run enabled and an empty queue. Its authenticated HTTP node reached the agent and Supabase successfully and returned `{"claimed":false}`. This is a connection/orchestration smoke test, not a complete approved-draft cloud flow.
- Stopped and restarted the persistent n8n container around the CLI execution (its task broker otherwise conflicts with the running server). The editor returned healthy after startup; workflow records persisted.
- Configured the user's DuckDNS hostname and started Caddy. Let's Encrypt issued a public certificate successfully. External HTTPS requests passed normal trust verification; `/`, `/rest/settings`, `/setup` and the test webhook path returned 404. HTTP redirected to HTTPS with status 308. No email or paid certificate service was required.
- Recreated agent and n8n with the hostname configuration; both became healthy again and all five workflows persisted.
- Telegram `getMe` verified the supplied bot token, but initial polling returned no messages. The user subsequently supplied their numeric ID. A Bot API test message succeeded in that private chat; the same ID was allowlisted in both the service and database. The token was transferred over SSH and imported into encrypted n8n credentials without being printed or committed.
- Added an allowlisted `/start` and `/help` response. Re-ran the suite with **35 passing tests**, including a durable `/start` update, an unauthorized sender rejection, and proof that onboarding changes no draft approval. Rebuilt the agent image on the VM with this change.
- Configured the monitoring workflow's Telegram credential and private chat. Published only C (approval) and E (monitoring), restarted n8n, and verified both active. A, B and D remain inactive; X publishing remains disabled.
- Registered Telegram's HTTPS webhook with its secret. External requests without the secret returned 403. Telegram reported zero pending deliveries and no webhook error. A real user `/start` reached the durable inbox and completed with state `done`; the user confirmed receiving the bot's connection reply. This verifies actual Telegram ingress and response, not approval buttons or live X posting.

- The user confirmed Gemini Free tier and supplied a key through a private ignored file. Model metadata authenticated successfully. Gemini 2.5 Flash was listed but its generation endpoint rejected new users with 404. Configured `gemini-3.8-flash` after verifying the current official Standard Free Tier pricing. No billing, paid grounding, or paid fallback was enabled.
- Actual n8n discovery fetched and researched 16 topics with zero source failures. Its Execute Workflow step rejected B as inactive during CLI execution, even after B was published and its stored active version verified. This orchestration issue remains unresolved; A remains inactive. B has only manual/sub-workflow triggers, so publishing it adds no daily schedule.
- Direct n8n generation and internal API generation were exercised. No batch was saved: the first 3.8 attempt ended after the original timeout, and two subsequent calls returned Gemini HTTP 503. Increased the model request timeout to 180 seconds, within the HTTP node's 300-second timeout. The daily API-call cap remains enforced, and no further immediate retries were made.
- Re-ran `npm run verify`: all 35 tests passed after the timeout adjustment. Current published workflows are B, C and E; scheduled discovery A and scheduled publishing D remain inactive.

## Successful first live batch — 12 November 2026

- Retested after n8n's asynchronous publication had populated the published-version record. A successfully called B; no bypass or database modification was needed. Wait for publication reconciliation after CLI publishing before immediately stopping n8n for a CLI test.
- Switched explicitly to `gemini-3.1-flash-lite` after verifying its Standard Free Tier input/output pricing. The project remains user-confirmed Free tier; no billing settings were changed.
- Fixed shortlist starvation: category-diverse candidates are selected before filling remaining places by rank. Previously, psychology articles crowded out evergreen emotions/career/growth candidates. Added a regression test.
- Tightened prompt length targets and evidence quotation instructions without weakening validation. Invalid batches were rejected atomically. Final `npm run verify`: **36 tests passed**.
- The actual n8n A → B → monitor chain exited successfully. Exactly five drafts were saved for 12 November, in AI, engineering, emotions, career and growth, scheduled for 10:00, 13:00, 16:00, 19:00 and 22:00 IST. All remain pending. Each has a Telegram delivery message ID.
- External TCP checks from the laptop could not connect to VM ports 3000, 5432 or 5678.
- Verified A, B, C and E are published after enabling the 07:00 IST discovery schedule. Publishing D remains inactive; X billing/publishing flags remain false. Approved drafts will not be consumed by a dry-run scheduler at this stage.
- Real Telegram actions verified: the growth draft is approved with `approved_version=content_version=1`; the engineering draft is rejected; the emotions draft was edited to version 2, returned to pending, and has null approval fields. Its generated and edited revisions are preserved, and the new Telegram draft message has its own ID. A late approval of the 10:00 draft set it to expired. Approval history records these actions.

- Rebooted the actual VM with generation paused. Docker restarted all services, n8n returned healthy, and all draft states and version-bound approvals survived. Resumed processing afterward; live publishing remained false.
- Created an encrypted PostgreSQL + cold n8n backup, downloaded it to a protected laptop directory, and successfully decrypted it using the off-VM SSH private key. The offline n8n database contained five workflows and three credentials.
- Restored the PostgreSQL dump into an isolated, network-disabled temporary container on the VM. Verified all five draft states, version 2 of the edited draft, and the approved version survived. Reapplied documented runtime grants and verified direct runtime table reads are denied while the settings function works. Removed the test container and temporary decrypted files.
- Installed daily encrypted backups at 03:30 IST with seven-day retention. One off-VM encrypted copy exists locally; automatic off-VM replication remains unconfigured.

**Not completed:** cloud dry-run publication of a due approved draft, real Telegram regeneration acceptance, live X authorization/posting, full fresh-VM n8n restore/startup, automatic off-VM backup replication, or GitHub push. The infrastructure is partially deployed; do not describe it as live-production verified.

## Automated coverage

| Requirement | Executable coverage |
|---|---|
| Topic failures | Isolated failures and fail-closed insufficient-evidence result |
| Freshness / duplicates | 72-hour window, URL canonicalization, 14-day used topics, title/hash matching |
| AI JSON | Malformed, truncated and wrong-cardinality responses; free-tier gate |
| Exactly five drafts | Atomic migration-backed batch, no partial insert, idempotent rerun |
| Tweet length | X weighted text, URL shortening, emoji, CJK and invalid controls |
| Telegram auth | Secret, allowlisted sender, chat, callback syntax, duplicate update IDs |
| Approve/reject | Authorized version-bound approval, repeat press, rejection lock |
| Edit/regenerate | Prompt binding, revised content, history, cleared approval, stale versions |
| Approval safeguards | Database rejects null/mismatched approved version and invalid published state |
| Scheduling | Future slots withheld, late approval expires, missed slots never catch up |
| Claims / daily budget | Competing claims, locked editing, five uncertain reservations block a sixth eligible fixture |
| Missing X credentials | No claim or HTTP call; approved draft stays queued |
| X rate limit / timeout | 429 terminal failure; 5xx, timeout and malformed success uncertain; no retries |
| Full flow | Generated draft → durable Telegram approval → local HTTP mock X → persisted ID |
| Pause/recovery | No claims while paused, stuck claims uncertain, abandoned revision needs fresh approval |
| Alerts | Transactional deduplication of repeated alerts |
| Restart | Embedded PostgreSQL data and approval survive close/reopen |
| API security | Internal auth and invalid JSON checks; source SSRF address rejection |

Run all checks:

```bash
npm ci --ignore-scripts
npm run verify
```

PGlite processes calls within one embedded engine. Its competing-claim test checks exclusive state transitions, not two separate PostgreSQL server connections. Confirm the hosted row-lock behavior with two runtime sessions before live publishing.

## Cloud acceptance checklist

Keep X cost/publishing switches false throughout these checks.

### Infrastructure and ingress

```bash
docker compose ps
docker compose exec agent node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1); console.log(r.status)})"
curl -I https://YOUR_HOST/
curl -I https://YOUR_HOST/rest/
```

- [ ] All containers are healthy/running; public editor routes return 404.
- [ ] Private SSH tunnel reaches n8n and requires owner authentication.
- [ ] External connection attempts to 3000, 5432 and 5678 fail.
- [ ] Unauthenticated POST to the Telegram webhook is rejected. Do not put secrets in a public curl log.
- [ ] Bot webhook information shows your expected URL and no unresolved delivery errors.
- [ ] Supabase private schema permissions and TLS checks pass with the actual runtime login.

### n8n import and end-to-end dry run

- [ ] Import all five JSON files; verify every node loads without an unknown type/version error.
- [ ] Bind header and Telegram credentials; replace emergency chat ID.
- [ ] Select B explicitly in A; select E as A–D's error workflow.
- [ ] Verify every schedule uses `Asia/Kolkata`. Ensure only one copy of each scheduler is active.
- [ ] Run A. Check stored source URLs and fetched timestamps; confirm unavailable sources produce one deduplicated alert.
- [ ] With a confirmed free-tier model, B creates exactly five pending drafts for the IST day. Run B again and confirm no second batch appears.
- [ ] Receive all five Telegram messages. Reject one, edit one and regenerate one. Confirm edits/regenerations return to pending and old buttons cannot approve the new content.
- [ ] Try a different Telegram user/private chat. Confirm no approval changes occur.
- [ ] Approve a valid draft **before** its slot. With `DRY_RUN=true`, D marks it simulated at the slot and sends a simulation notice. There must be no X post ID or X HTTP request.
- [ ] In two database sessions against a **test** project, call `select agent.command('claim','{"mode":"dry"}');` concurrently for a due approved draft. Exactly one gets a claim. Leave it for monitor to mark uncertain, or finish it as simulated through the function.
- [ ] Trigger a controlled failure in a test copy of a workflow. Confirm E records a sanitized event and alerts. Manual node errors do not necessarily invoke n8n's Error Trigger; use an active test execution.
- [ ] Stop the internal service temporarily; confirm emergency Telegram alerts work and are throttled. Restart it and verify queued messages recover.

### Restart checks on the actual VM

Before restarting, pause the database and record draft counts/version state. Do this first in the dry-run deployment:

```bash
docker compose restart agent n8n
docker compose ps
docker compose logs --tail=50 agent n8n
sudo systemctl is-enabled docker
sudo reboot
```

Reconnect after reboot and repeat `docker compose ps`. Confirm n8n workflows, credentials and owner account persisted; application records and approvals remain in Supabase. A claim left in `publishing` must become `uncertain`, never produce a duplicate request. Resume the database explicitly after inspection. A systemd-enabled Docker daemon plus `restart: unless-stopped` is configuration evidence; the reboot check is needed for operational evidence.

### Backup and live opt-in gates

- [ ] Create and decrypt an encrypted backup using an off-VM key.
- [ ] Restore into an empty test deployment and verify private table grants, function access, credentials and workflow references.
- [ ] Confirm storage use remains under the free allowance and backups cannot fill the boot volume.
- [ ] Supply personal writing samples and review draft quality over several days.
- [ ] Only if explicitly choosing X charges: configure user-context access, verify current billing, enable all opt-ins, and approve one fresh draft for a future slot. Confirm one live ID before considering unattended scheduled publishing.

The initial implementation does not automatically approve, catch up missed slots, repair permissions by widening grants, retry ambiguous publishing, or claim guaranteed factuality. Those boundaries must remain intact during recovery.
# Manual additional batches — November 12 update

37 automated tests pass, including two extra five-draft batches after the scheduled batch, same-request deduplication, invalid request IDs, approval of unscheduled drafts without publication, and preservation of the five-post publishing limit. The migration preserves existing drafts and approval versions. A/B request expressions were updated and republished on the VPS with installed credentials preserved. The service was rebuilt and n8n restarted. Live additional Gemini generation has not been executed: today's configured request cap is exhausted. Extra batches remain subject to this separate free-tier budget.


Manual mode correction: n8n expression execution.mode uses test/production, not manual/production. A/B expressions corrected and republished; 39 tests pass, including expression evaluation and explicit quota failure. A live manual request reached the quota gate (HTTP 429), consumed no extra Gemini requests, and queued a clear Telegram notice. This does not verify successful extra-batch Gemini generation.


Daily Gemini application cap removed at user request. Usage tracking and 15-second pacing remain; all 39 tests pass, including a request beyond 1,000 recorded daily attempts. Live database quota command accepted the existing usage above the former limit in a rolled-back verification transaction. No Gemini API request was made by that check. Free-tier requirement and X-off gates remain unchanged.

