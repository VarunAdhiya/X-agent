# Security checklist

## Before first activation

- [ ] Oracle resources are marked Always Free eligible; account has not been upgraded to Pay As You Go.
- [ ] SSH uses a key; root/password SSH login is disabled after confirming key access and recovery console access.
- [ ] OCI ingress permits 22 only from the operator's current IP, and 80/443 publicly. Ports 3000, 5432 and 5678 are not open in the VCN.
- [ ] `docker compose ps` shows only loopback binding for n8n. The internal agent has no published host port.
- [ ] Public `GET /`, `/rest/`, `/health`, `/webhook-test/telegram-approval` and `/api/v1/` return 404.
- [ ] n8n has an owner account and strong password before importing/activating workflows.
- [ ] `.env` is mode 600; `secrets` and `backups` are private; Git ignores them. API tokens exist only in environment variables and n8n's encrypted credential store.
- [ ] Encryption key is unique and included in encrypted backups. Each API/webhook secret was generated independently.
- [ ] Supabase runtime login has only private-schema usage and restricted function execution; no service-role key, admin login, table grants, or public RLS policies.
- [ ] Database TLS verifies the hostname and CA. `LOCAL_DATABASE_NO_TLS=false`.
- [ ] `agent` is not exposed via Supabase's Data API. Function execution is revoked from PUBLIC. Run Supabase's security advisors after applying the migration.
- [ ] Telegram uses a private chat and exact allowlisted sender IDs. Both service and database lists agree.
- [ ] Gemini billing remains disabled and model eligibility was checked in the actual account. No paid tools/search grounding are configured.
- [ ] X opt-ins remain false unless separately authorized. Dry-run data cannot become live publishing data automatically.

## Host firewall

OCI NSG/security-list rules are the primary outer boundary. Docker-published ports can bypass ordinary UFW INPUT rules; do not assume `ufw deny 5678` secures a `0.0.0.0:5678` Docker mapping. This Compose file avoids that mapping entirely. See [Docker's Ubuntu firewall guidance](https://docs.docker.com/engine/install/ubuntu/).

On a clean Ubuntu host using UFW, and only after checking your current SSH port and recovery access:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from YOUR_PUBLIC_IP/32 to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Replace `YOUR_PUBLIC_IP` first. Do not remove Oracle image firewall rules blindly or mix conflicting iptables/UFW managers. If your image has an INPUT reject rule, use its existing manager to allow the required ports before that rule; verify from an external client. An SSH tunnel is for administration only; ordinary workflow execution does not depend on the laptop.

## Application controls and limits

Sources are untrusted. Discovery uses HTTPS only, rejects URL credentials/nonstandard ports, validates resolved socket addresses, rejects private/link-local/reserved IPs, checks redirects, limits bytes/time, and rejects XML entity declarations. An inaccessible source is skipped. An article is not assumed primary just because it was linked by HN; Telegram shows the source so the editor can judge its authority. Feed collection does not claim X-trend evidence.

Model instructions explicitly treat source excerpts as data. Generated source URLs must belong to the selected topic, factual claim excerpts must occur in fetched text, and copied long clauses are rejected. These are filters, **not a proof of correctness or comprehensive plagiarism detection**. Human approval remains necessary.

PostgreSQL serializes short state transitions on one settings row. This is intentionally simple for a five-post/day workload. No network request holds that transaction lock. Atomic claims, version-bound approval, unique content hashes/revisions, unique post IDs and permanent attempt records prevent normal duplicate publishing. A privileged database owner can override data and remains a trusted operator.

The backend credential is powerful: it can submit allowed commands, including approval with an allowlisted actor. It is only for n8n-to-service communication, never a user-facing API key. Do not expose the service or distribute that credential. A compromised VM or database owner is outside this approval boundary.

Use OS security updates, reviewed image updates, log rotation, storage checks and encrypted backups. Images are explicitly version-pinned; manifests were resolvable during local verification, but container scanning and live image startup still need deployment checks. No automatic image updater is included.

The global pause blocks new claims. It does not cancel an already-sent X request. Free VM reclamation, total network loss and total disk failure require monitoring outside that VM if independent alerting is needed; no paid monitoring service is assumed or provisioned.
