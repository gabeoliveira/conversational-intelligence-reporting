# Conversation Enrichment

A generic webhook surface that lets upstream systems (Twilio Studio, customer
backends, dispatchers, CRMs, anything) attach arbitrary metadata to a
conversation by correlation key. CIRL stores the metadata and merges it into
conversation responses at both write time and read time, so dashboards and BI
tools see it alongside the rest of the conversation data without needing to
know where it came from.

The original driver: **Inter needed Genesys interaction IDs to surface on
their dashboard**, but that ID is not part of the Voice Intelligence
transcript — it lives in upstream Studio context. Rather than build a
Genesys-specific integration, CIRL exposes a generic enrichment surface that
works for any "upstream data tied to a Twilio call SID" use case.

## When to use it

- Attaching CRM ticket numbers, campaign IDs, dispatcher routing reasons, or
  other system-of-record references to a Twilio call.
- Backfilling historical conversations with compliance review state, manual
  QA tags, or other operator-driven metadata.
- Surfacing data from sibling Twilio products (Studio, Functions, TaskRouter)
  that isn't part of the CI transcript payload.

If the data is *already* in the CI transcript payload (any field the operator
outputs), you don't need enrichment — wire it through the existing operator
config (`config/operator-metrics.json`) instead.

## Feature flag

The feature is **off by default**. Enable per environment via either:

- **Env var**: `CIRL_ENRICHMENT_ENABLED=true` in the loaded `.env` file before deploy
- **CDK context**: `--context enrichment=true` on the deploy command

When disabled:

- The `POST /tenants/{tenantId}/enrichment` route is not registered in API
  Gateway (returns the API Gateway 403 for unmapped paths).
- The processor's write-time merge is a no-op.
- The API's read-time merge is a no-op.
- No additional DynamoDB reads happen anywhere in the request path.

Flipping the flag does not require any data migration. Existing rows in
DynamoDB don't reference enrichment records, so toggling on/off is safe.

## Producer contract

```http
POST /enrichment
Content-Type: application/json

{
  "callSid": "CA64efd5154e2de818b6edd9d5136df049",
  "fields": {
    "interaction_id": "genesys-12345",
    "agent_skill": "support-l2",
    "any_other_key": "any value"
  },
  "source": "studio"
}
```

The endpoint lives at the API root (not under `/tenants/{tenantId}/`) and
mirrors `/webhook/ci` — both are write-side endpoints called by external
producers. Since CIRL is single-tenant-per-deployment, the tenant is
resolved from `CIRL_TENANT_ID` at deploy time, with an optional
`X-Tenant-Id` header override for local testing.

The endpoint **does not require an API key**, even when the rest of the API
is configured with `CIRL_AUTH=apikey`. This is intentional — Twilio Studio's
HTTP Request widget has minimal auth options (no clean way to attach an
`x-api-key` header per environment), and requiring API keys here would force
every producer through a Function-widget wrapper. The trade-off is captured
in the [Security](#security) section below.

Field rules:

| Field | Required | Notes |
|---|---|---|
| `callSid` | One of these two | Twilio voice call SID. Use this for voice channels (Recording, ConversationRelay). |
| `conversationSid` | One of these two | Twilio Conversations SID. Use this for messaging. |
| `fields` | Yes | Arbitrary object of key/value metadata. CIRL doesn't validate keys — they're whatever the producer wants to attach. |
| `source` | No | Free-form label for who sent the enrichment ("studio", "salesforce-webhook", "qa-tool"). Defaults to `"unknown"`. Helpful for debugging when multiple producers send for the same conversation. |

Responses:

- `202 Accepted` — record stored
- `400 Bad Request` — missing/invalid body, no correlation key, or `fields` is not an object
- `404 Not Found` — feature flag is off
- `403 Forbidden` — API key required and missing/incorrect (when `CIRL_AUTH=apikey`)

## Where it lives in storage

A single DynamoDB item per (tenant, correlation key) pair:

| Attribute | Example |
|---|---|
| `PK` | `TENANT#inter-mvp#ENRICHMENT#CALL#CA64efd5...` |
| `SK` | `META` |
| `entityType` | `ENRICHMENT` |
| `tenantId` | `inter-mvp` |
| `correlationType` | `CALL` or `CONV` |
| `correlationKey` | `CA64efd5...` |
| `callSid` | `CA64efd5...` (or null) |
| `conversationSid` | `CH...` (or null) |
| `fields` | `{ "interaction_id": "...", ... }` |
| `source` | `"studio"` |
| `receivedAt` | ISO 8601 timestamp |
| `ttl` | Unix epoch, 90 days from receivedAt |

The TTL is enforced by DynamoDB Time-to-Live (the table has
`timeToLiveAttribute: 'ttl'` configured). Stale enrichment older than 90 days
disappears automatically. If long-term retention is needed, raise the TTL
constant in `services/ingest/src/enrichment.ts`.

PUTs are idempotent — re-posting the same correlation key with new fields
overwrites the existing record. Use this to update values over the call
lifecycle (e.g., dispatcher posts initial routing, then later posts final
disposition).

## Two-stage merge

Enrichment may arrive **before** or **after** the corresponding CI transcript.
Both paths are handled, with different mechanisms.

### Write-time merge (fast path)

When the processor's `writeConversation` runs (triggered by each operator
result from the CI webhook), it extracts the `callSid` from the channel
payload and issues a `GetItem` for the enrichment record. If found, the
fields are merged into the spine payload under the `enrichment` key.

This handles the common case where the producer (e.g., Studio) fires at call
setup time and the CI transcript arrives at call completion — the enrichment
record exists by the time the processor runs.

### Read-time merge (late-arrival path)

The conversations API (`/conversations`, `/conversations/{id}`, indexed
lookups) does a `BatchGetItem` for enrichment records keyed by the callSid /
conversationSid of every row in the response, then merges into each row.
This always reflects the latest stored state, so:

- Producers that arrive *after* the CI transcript still appear in dashboards
  on the next API call (no processor re-run needed).
- Producers that update fields over time (e.g., dispatcher posts routing,
  agent later posts disposition) propagate without any processor activity.

The read-time merge always wins when the values differ — the API result
reflects the latest stored enrichment, not what was cached on the spine.

### Cost of the read-time merge

`BatchGetItem` is one round trip for up to 100 keys. For a typical 50-row
conversations page, that's one extra DDB call returning up to 50 items.
Adds ~5-10ms of latency and ~$0.10/month at Inter's volume (20k convs).
Chunked at 100 keys per BatchGet for the rare 500-row page.

If the BatchGet fails (transient DDB error), the response degrades gracefully
to whatever was cached on the spine — never fails the whole conversations
query.

## Making enrichment fields filterable

Surfacing a field in API responses isn't the same as making it filterable in
query strings. By default, posting `interaction_id` via `/enrichment` means
each conversation row carries `enrichment.interaction_id` — but
`?interaction_id=...` on `/conversations` does nothing.

To make specific enrichment fields filterable, set
`CIRL_ENRICHMENT_FILTERABLE_FIELDS` in your environment (comma-separated):

```
CIRL_ENRICHMENT_FILTERABLE_FIELDS=interaction_id,crm_ticket
```

What this changes:

- The processor's `writeConversation` reads enrichment fields after merging
  them into the spine, and for each name in the filterable list, writes an
  inverse index record at `TENANT#x#IDX#<fieldName>#<value>`.
- The conversations API recognizes the same field names as valid query
  parameters and resolves them via the index (O(1) lookup, same path as
  `?primary_topic=...`).

After redeploy, `?interaction_id=92a3af33-9ce5-4e84-9291-7869516e28b8`
returns just the conversation tied to that Genesys interaction.

### Limits worth knowing

- **Index records are written at spine-write time, not enrichment-POST time.**
  If enrichment arrives *after* the CI webhook (late-arriving case), the
  field surfaces on the conversation via the API's read-time merge, but
  there's no inverse index record yet — `?<field>=` filters miss it. In
  practice (Studio posts at call setup, CI completes at call end), this
  is fine.
- **Only top-level keys in `fields` are indexable.** Nested objects aren't
  walked. Producers wanting filterable nested values should flatten before
  posting (`{ "agent_id": "a-1" }` instead of `{ "agent": { "id": "a-1" } }`).
- **Re-deploy is required** to add or remove filterable fields — the
  Lambda env var is read at cold start.

## Built-in filterable fields (always available)

Two filterable fields are wired in for every deployment, separate from
the enrichment list above:

| Filter param | Source | Use case |
|---|---|---|
| `customer_phone_last4` | Last 4 digits of the raw customer phone (extracted at spine-write time, works for both E.164 and SIP URI input) | Support lookup by partial phone — "the customer whose number ends in 2682" |
| `handoff_reason`, `primary_topic`, `subtopic`, `inferred_csat`, `actual_csat` | Operator-config primitives marked `surfaceInList: true` | Dashboard drill-down |

`customer_phone_last4` exposes a useful handle for support without putting
the full PII number into URL query strings (which would otherwise end up
in API Gateway access logs).

## Consumer experience

Once `CIRL_ENRICHMENT_ENABLED=true`, every conversation in API responses
gains a top-level `enrichment` field:

```json
{
  "conversationId": "GT...",
  "callSid": "CA64efd5...",
  "customerPhone": "+5511****2682",
  "enrichment": {
    "interaction_id": "genesys-12345",
    "agent_skill": "support-l2"
  },
  ...
}
```

`enrichment` is `null` when no record exists for the row's callSid /
conversationSid. The keys inside `enrichment` are whatever the producer
posted — CIRL doesn't dictate them.

In Grafana / Power BI / etc., dashboards reference nested fields:
`row.enrichment.interaction_id`, `row.enrichment.agent_skill`. JSONata in
Infinity datasource: `enrichment.interaction_id`. Athena (lakehouse mode):
`json_extract_scalar(enrichment, '$.interaction_id')`.

## Examples

### Twilio Studio (HTTP Request widget)

Add an HTTP Request widget at the start of the Studio flow, pointed at the
enrichment endpoint:

```
URL:    https://<api-host>/v1/enrichment
Method: POST
Body:   {
          "callSid": "{{trigger.call.CallSid}}",
          "fields": {
            "interaction_id": "{{flow.variables.interaction_id}}"
          },
          "source": "studio"
        }
```

No authentication headers required — the endpoint is intentionally open.
See [Security](#security) for the rationale.

This fires at call setup, so by the time CI completes processing the
conversation, the enrichment is already there for the write-time merge.

### Customer backend (post-call)

A backend service listening on call-completion events from Twilio (or any
other source) can post enrichment after the fact. The read-time merge will
surface it on the next dashboard refresh:

```bash
curl -X POST "${API_URL}enrichment" \
  -H "Content-Type: application/json" \
  -d '{
    "callSid": "CA64efd5...",
    "fields": { "disposition": "resolved", "wrap_code": "BILLING" },
    "source": "agent-disposition-tool"
  }'
```

### Backfill from a CSV

For one-off historical tagging (e.g., QA team reviewed a batch of calls and
wants to mark them):

```bash
while IFS=, read -r call_sid review_status reviewer; do
  curl -s -X POST "${API_URL}enrichment" \
    -H "Content-Type: application/json" \
    -d "{\"callSid\":\"$call_sid\",\"fields\":{\"qa_status\":\"$review_status\",\"qa_reviewer\":\"$reviewer\"},\"source\":\"qa-backfill\"}"
done < reviews.csv
```

## Design decisions

- **Generic, not per-customer.** Inter's interaction ID is the motivating
  use case, but the endpoint accepts arbitrary `fields` — future customers
  post different keys without any CIRL code changes.

- **Correlation by callSid (or conversationSid) only.** These are the most
  reliable Twilio identifiers available at every layer of the call lifecycle
  — Studio context, CI transcript channel, Conversations API. Other
  identifiers (customer phone number, agent extension, account SID) are
  either ambiguous or insufficient.

- **No automatic spine-update on enrichment write.** The enrichment endpoint
  only writes its own record. It does *not* try to look up the corresponding
  conversation and update its spine. Reasons:
  - The spine's PK pattern doesn't index by callSid, so finding the spine
    would require a GSI or a scan.
  - The read-time merge handles late arrivals correctly and consistently —
    a write-time spine update would be redundant.
  - Less moving code = fewer race conditions and failure modes.

- **TTL = 90 days.** Long enough to cover any reasonable call-completion
  delay (transcripts typically finish within minutes). Long enough for
  backfill jobs to land before expiry. Short enough that abandoned data
  doesn't accumulate forever. Tunable in `enrichment.ts` if a customer needs
  longer.

- **Read-time merge always wins.** When both paths produce a value, the API
  serves the read-time result. This makes "post a correction" the simple
  developer model — producers don't need to coordinate with the processor.

- **No filtering by enrichment values.** You can't currently query
  `/conversations?interaction_id=genesys-12345`. To make a specific field
  filterable, write a `surfaceInList`-style index on enrichment writes (same
  pattern as the existing operator-config indexes). Easy to add when a
  customer asks; not built up front because the field names are
  customer-specific.

## Security

The enrichment endpoint is **open** — it does not require an API key, even
when `CIRL_AUTH=apikey` protects the dashboard endpoints. Same trust posture
as `/webhook/ci`.

This is a deliberate design decision driven by Twilio Studio's limited auth
options on its HTTP Request widget. Forcing API key auth here would push
every producer through a Function-widget wrapper to attach headers, which
defeats the "any HTTP client can enrich" goal.

The trade-offs:

- **What an attacker with the URL can do**: attach arbitrary `fields` to any
  callSid they can guess (or harvest from a leaked log). The data appears
  under `enrichment` on the corresponding conversation.
- **What they can't do**: read existing enrichment values (the endpoint is
  write-only), cross tenants (the `tenantId` path parameter scopes writes),
  delete or modify the conversation itself, or persist beyond the 90-day
  TTL.
- **Practical mitigation**: don't share the API URL more widely than
  necessary. Twilio callSid is a 34-character random string — guessable in
  bulk but useless without knowing valid SIDs. Records expire automatically.

If a deployment needs stronger auth on enrichment specifically, three paths:

1. **Add `apiKeyMethodOptions` to the route** in `api-stack.ts`. Reverts to
   the API key requirement; producers must include `x-api-key`.
2. **Layer signature validation** inside the handler (mirroring the webhook
   pattern). Twilio-originated producers can sign; non-Twilio producers
   need a different path.
3. **Per-tenant HMAC with a shared secret**. Self-contained, doesn't
   depend on Twilio. Adds ~30 lines of handler code.

For the typical use case (Studio + customer backend producers tied to a
tenant), the open-endpoint trade-off is acceptable. The threat model is
data integrity, not data exfiltration.

## Disabling enrichment after enabling

Switching `CIRL_ENRICHMENT_ENABLED` back to `false` and redeploying:

- Removes the `POST /tenants/{tenantId}/enrichment` route from API Gateway
- Skips the write-time and read-time merges (no extra DDB calls)
- Leaves any previously-written enrichment records in DynamoDB (they'll
  expire via TTL after 90 days, or you can delete them manually)
- Surfaces `enrichment: null` on every API response

No data is lost when toggling, just hidden from the API surface.
