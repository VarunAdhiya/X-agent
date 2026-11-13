# How the system works

The VM is the always-on computer. Docker runs n8n, the internal JavaScript service, and the HTTPS reverse proxy. Supabase stores topics, drafts, revisions, approvals, and publication attempts. Your laptop is only needed to administer the system through its private SSH tunnel.

## A day of operation

1. At 07:00 Asia/Kolkata, workflow A starts discovery. Public feeds provide candidates; the service filters duplicates, ranks them, reads supporting articles, and preserves a mix of categories.
2. A calls workflow B. Gemini receives the shortlisted evidence and writing preferences. It returns five drafts in structured JSON. All five must pass validation before the database saves the batch. A failed batch produces no partial set of tweets.
3. The database outbox records messages to deliver. Workflow B and the monitoring workflow deliver them to Telegram with approval buttons.
4. Your Telegram action reaches workflow C through HTTPS. A webhook secret authenticates Telegram's request, and your private chat and numeric user ID are checked by both the service and database. The incoming update is saved before Telegram receives acknowledgement.
5. Approve records the exact content version. Reject blocks it. Edit requests a reply to a specific prompt. Edit and Regenerate invalidate prior approval and preserve revision history.
6. Workflow D checks due drafts every minute when activated. A database transaction claims one eligible approved version and reserves daily capacity. Live publishing also requires every X opt-in and credential. Dry-run records a simulation instead. Late approvals are skipped, and ambiguous X failures require reconciliation rather than automatic retry.
7. Workflow E processes delivery queues, checks abandoned jobs, and sends deduplicated alerts. It never approves content or bypasses publishing gates.

## Why there is code as well as n8n

Manual execution of A (or B directly) requests five additional drafts, even after today's scheduled batch is complete. The n8n execution ID identifies the batch: retrying the same request does not duplicate it; a new execution can create a new batch. A also refreshes topics first. Enough unused topics and Gemini free-tier request budget must remain. Manual drafts are labelled unscheduled in Telegram; approving them does not assign a posting slot. They can be used for manual posting, or explicitly scheduled later through an administrator. The five-post daily publishing limit remains unchanged. There is no automatic rollover into tomorrow's slots.

The current design uses native n8n Schedule, HTTP Request, Execute Workflow, Webhook, Respond to Webhook, Error Trigger, and Telegram nodes. One Code node throttles emergency alerts. Most editorial and approval business logic currently lives in the internal JavaScript service; it is not all visible as separate canvas blocks.

RSS/API fetching, Gemini requests, Telegram messaging, and branching could instead be expressed with native n8n nodes. The service is an implementation choice, not an n8n limitation. It centralizes logic and enables repeatable tests, at the cost of a less visual workflow.

Weighted X length, similarity checks, source validation, and OAuth signing are custom logic. Atomic approval/version checks and exclusive publication claims belong in PostgreSQL transactions. Moving orchestration into more n8n blocks would not remove the need for these safeguards or make separate database writes atomic.

There are three distinct concerns: n8n decides when steps run; validation decides whether their data is acceptable; PostgreSQL enforces state transitions even if two executions race. A node-only prototype is simpler, but production reliability still requires careful state handling.

This describes intended operation. See [VERIFICATION.md](VERIFICATION.md) for which live checks have actually passed and which schedules are enabled. Nothing here implies that X access or paid infrastructure has been authorized.
