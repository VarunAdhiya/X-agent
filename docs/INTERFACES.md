# Internal interfaces

The service is reachable only over the Docker network, at `http://agent:3000`. Every POST requires `X-Agent-Token`. Never forward this API publicly. JSON bodies are limited to 64 KiB. Credentials are not accepted in request bodies (the forwarded Telegram webhook secret is checked only on ingress).

| Route | Caller / input | Result and durable side effect |
|---|---|---|
| `GET /health` | Container health check | Process readiness only; it is not a database connectivity test. |
| `POST /discover` | A, `{}` | Normalizes/ranks/researches sources, persists eligible topics. Returns `discovered`, `source_failures`. |
| `POST /generate` | B, `{}` | Claims today's generation run, calls Gemini, validates and atomically saves five pending drafts plus five notification jobs; otherwise saves no partial batch. |
| `POST /telegram` | C, `{update, secret}` | Validates sender/chat/secret and inserts unique Telegram `update_id`; returns `{ok:true}` only after commit. |
| `POST /approval` | C or recovery, `{}` | Processes at most ten leased inbox items, with version-bound database commands. |
| `POST /publish` | D, `{}` | Applies cost/settings gates; atomically claims at most one due draft; simulates or sends exactly one X request; stores outcome. |
| `POST /monitor` | E and B, `{}` | Detects stale claims, prunes bounded data, recovers inbox work, delivers at most ten outbox messages and checks database size. |
| `POST /error` | E, n8n error event | Stores sanitized workflow/execution identifiers and queues/delivers a deduplicated alert. Raw error messages are discarded. |

Overlapping jobs on the same route return `{busy:true}` within one process. Telegram ingress is exempt and never dropped by that optimization. Database leases, uniqueness constraints and locks provide cross-execution safety. Exactly-once HTTP delivery is not claimed.

## Database boundary

`agent.command(operation, payload)` is the only runtime SQL entry point. It is parameterized and uses a fixed private schema. Operations cover read context/settings, topic persistence, generation leases/batches, model quota reservations, inbox/outbox leasing, approval/revision transitions, publishing claims/outcomes, and sanitized logging/monitoring. The runtime role cannot change configuration, create a login or manipulate tables directly.

Five base tables requested by the project are present: `topics`, `tweet_drafts`, `tweet_revisions`, `automation_settings`, `automation_logs`. Additional tables implement `generation_runs`, `publication_attempts`, `inbox`, `outbox`, `edit_sessions` and `api_usage`.

Important state transitions:

```text
generation -> pending -> approved -> publishing -> published
                |           |            |------> simulated (dry only)
                |           |            |------> failed (definite refusal)
                |           |            `------> uncertain (never auto-retried)
                |           `-> editing/regenerating -> pending, new version
                |-> rejected
                `-> expired (late approval)
approved -> expired (missed slot when publishing resumes)
```

Editing/regenerating first clears approval. The original content is already stored in revision history; a successful revision adds a version. An abandoned revision becomes pending after an hour, retaining no approval. Reconciliation can move an uncertain attempt to published with a verified existing X ID; it sends no creation request.

Database timestamps determine the IST calendar day and slots. There is no production clock override or endpoint to simulate a user approval. Tests manipulate fixture clocks only through their isolated administrator connection.

## AI contract

Gemini returns an array of five objects with `topic_id`, `category`, `content`, `source_urls`, `rationale` and `claims`. A claim contains `source_url` and an exact `excerpt`. The service checks these fields rather than trusting model-produced validation. PostgreSQL assigns each draft's UUID and publishing slot, and the service attaches weighted-length and duplicate-check results. Example persisted and workflow payloads are in `samples/`.

## Workflow credentials and activation

Exported JSON uses stable local **workflow IDs** for internal links but only names for **credential placeholders**. After import, select actual workflows/credentials in the editor; n8n may remap IDs. All exports are inactive. A JSON structural pass is not an execution test. See `VERIFICATION.md` for the required live import checks.
