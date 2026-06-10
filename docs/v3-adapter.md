# Conversational Intelligence v3 Support

CIRL ingests webhooks from **both** Twilio Conversational Intelligence versions:

- **v2 (classic)** — transcript-centric, post-call. Twilio fires one notification per
  transcript; CIRL fetches the operator results via REST.
- **v3 (current)** — conversation-centric, rule-driven. Twilio's Rule Execution webhook
  delivers full operator results inline, optionally per-message or on conversation lifecycle
  events.

A thin adapter layer in the ingest service normalizes both shapes into the same internal
event so the processor + storage + API layers stay version-agnostic.

## When to read this

- Onboarding a new tenant that uses v3.
- Debugging "no data flowing" when a v3 rule fires.
- Migrating an existing tenant from v2 to v3.

If your tenant uses v2 and ingestion is working, you don't need to read this.

## What's actually different about v3

| Concern | v2 (classic) | v3 |
|---|---|---|
| **Trigger model** | Once per transcript, post-call only | Per-rule. Each rule chooses one of: `COMMUNICATION` (every Nth message), `CONVERSATION_INACTIVE` (idle), `CONVERSATION_END` (close). |
| **Payload model** | Notification only — `{transcript_sid, event_type}`. App fetches results from REST. | Self-contained — full operator results inline. No follow-up fetch. |
| **Identifiers** | SIDs: `GT*` (transcript), `LY*` (operator) | ULIDs: `conv_conversation_*`, `intelligence_operator_*`, `intelligence_operatorresult_*` |
| **Operator identity** | `operator_type` + `operator_sid` | `operator.id` + `operator.displayName` + integer `version` |
| **Result shape** | Flat `extract_results` map | `result` object whose shape depends on `outputFormat` (`TEXT` / `JSON` / `CLASSIFICATION`) |
| **Per-execution metadata** | Not exposed | `latencyMs`, `resolvedModel`, `inputCharacters`, `outputCharacters`, `inputTruncated` |
| **Conversation context** | Embedded in `channel.media_properties` | `executionDetails.{channels[], participants[], resolvedContext{memory, knowledge}}` |
| **Fanout** | One transcript → N operator results in one webhook | One rule execution → N operator results in one webhook |
| **Auth** | `X-Twilio-Signature` (HMAC-SHA1 over URL + bodySHA256 for JSON) | **Same scheme.** Confirmed against real BTG traffic — `X-Twilio-Signature` header + `bodySHA256` query string, identical signing. |

## Architecture

```
                        ┌────────────────────────────────┐
                        │  POST /webhook/ci              │
                        │  (single endpoint for all)     │
                        └──────────────┬─────────────────┘
                                       │
                  ┌─────────────── ingest Lambda ────────────────┐
                  │  1. Verify X-Twilio-Signature                │
                  │  2. Resolve tenant (X-Tenant-Id || env)      │
                  │  3. Load tenants.json from S3 (cached)       │
                  │  4. Pick adapter from tenant's ciVersion     │
                  │  5. adapter.normalize() → N NormalizedResult │
                  │  6. For each: write S3 + emit EventBridge    │
                  └──────────────────┬───────────────────────────┘
                                     │
        ┌────────────────────────────┴────────────────────────────┐
        ▼                                                         ▼
   V2Adapter                                                 V3Adapter
   - fetch transcript+results+sentences from REST            - parse Rule Execution payload inline
   - one NormalizedResult per operator                       - one NormalizedResult per operatorResults[] entry
   - schemaVersion = 'v1'                                    - schemaVersion = 'v' + operator.version
   - trigger = null                                          - trigger from executionDetails.trigger.on
                                                             │
                                       ┌─────────────────────┘
                                       ▼
                          ┌───────────────────────────────┐
                          │  EventBridge PayloadReceived  │
                          │  (carries ciVersion + trigger) │
                          └──────────────┬─────────────────┘
                                         │
                                         ▼
                                  processor Lambda
                                  - validate schema (if registered)
                                  - run enrichment hook
                                  - write conversation header
                                  - write operator result
                                  - aggregateFromConfig (gated by trigger filter + dedup)
                                  - updateAggregates (generic counts)
```

Key invariant: **everything downstream of EventBridge is version-agnostic.** The processor
doesn't know whether an event came from v2 or v3 — it only consumes the canonical fields on
`PayloadReceivedEvent`.

## Per-tenant configuration: `config/tenants.json`

Lives alongside `operator-metrics.json` and ships to S3 via the same `BucketDeployment` on
every `cdk deploy`. Loaded by the ingest Lambda at cold start via `ensureConfigLoaded()`.

```json
{
  "version": "1.0",
  "tenants": {
    "inter-mvp":  { "ciVersion": "v2" },
    "btg-mvp":    { "ciVersion": "v3" },
    "cintelv3":   { "ciVersion": "v3" }
  },
  "defaults":     { "ciVersion": "v2" }
}
```

Lookup precedence in `getTenantConfig(tenantId)`:
1. Exact tenant entry → its `ciVersion`
2. `defaults.ciVersion`
3. If no config loaded (S3 read failed) → adapter defaults to `v2` (legacy behavior)

The handler also runs a payload-shape tiebreaker: if the tenant declares one version but the
incoming payload structurally matches the other, the adapter for the matching payload is used
and a warning is logged. This avoids silently dropping requests when the tenant config is
stale.

## V3Adapter field mapping

For a v3 Rule Execution webhook, the adapter normalizes one inbound payload into N
`NormalizedResult`s (one per `operatorResults[]` entry), emitted to EventBridge as separate
`PayloadReceived` events.

| v3 source | CIRL internal |
|---|---|
| `conversationId` (`conv_conversation_*`) | `conversationId` — used as the primary key in S3 and Dynamo |
| `referenceIds[]` first `CH*` | `metadata.referenceSids.conversationSid` — cross-reference to the underlying Twilio Conversations service |
| `operator.displayName` | `operatorName` — matches against `operator-metrics.json` entries |
| `operator.version` (integer) | `schemaVersion = "v" + version` (e.g. `"v2"`) |
| `result` (depends on outputFormat) | `data` — JSON/CLASSIFICATION passed through as-is; TEXT wrapped as `{text: "..."}` |
| `executionDetails.trigger.on` | `trigger` — drives `aggregateOnTriggers` filtering |
| `executionDetails.channels[0]` | `metadata.channel` (lowercased; e.g. `"whatsapp"`) |
| `executionDetails.participants[].profileId` where `type == "CUSTOMER"` | `metadata.customerKey` — Memora profile ID. Anonymous customers still get a profile, so this is always a workable identity key. |
| `executionDetails.participants[]` (raw) | `metadata.executionDetails.participants` — full list for downstream inspection |
| `executionDetails.resolvedContext.{memory, knowledge}` | preserved in `metadata.executionDetails.resolvedContext` |
| `intelligenceConfiguration.ruleId` | `metadata.ruleId` |
| `intelligenceConfiguration.id` | `metadata.intelligenceConfigurationId` |
| `metadata.system` (latencyMs, model, …) | `metadata.executionMetadata` |
| `outputFormat` | `metadata.outputFormat` |

### Fields we deliberately don't extract for v3

- **Phone numbers.** v3 participants expose `id` and `profileId` only — no phone field. We
  use `customerKey = profileId` instead. If a panel needs a phone number, fetch it from
  `/v1/Conversations/{CH*}/Participants` using the saved `referenceSids.conversationSid`.
- **CallSid.** v3 conversations aren't tied to a Twilio Call SID; the `callSid` column on
  the conversations API is `null` for v3.
- **Transcript SID.** No transcript concept in v3.

### Unknowns the adapter tolerates

- `participants[].type === "UNKNOWN"` (documented enum is `HUMAN_AGENT` / `CUSTOMER` /
  `AI_AGENT`; real payloads include `UNKNOWN`).
- `operator.parameters` being `{}` or `null`.
- `resolvedContext.memory` and `resolvedContext.knowledge` being `null`.
- `executionDetails.trigger.on` being absent or set to a value outside the documented set —
  treated as `null` trigger.
- `operatorResults: []` (empty fire) — returns 0 normalized results, logs a warning.

## Operator-level aggregation knobs

Two new optional fields on `OperatorConfig` in `operator-metrics.json` let you control how
v3-triggered fires aggregate. v2 events have no trigger, so these knobs are no-ops for v2.

### `aggregateOnTriggers?: IntelligenceTrigger[]`

Restrict metric aggregation to results produced by a rule with one of these trigger types.
Storage of the operator result still happens regardless.

```json
{
  "operatorName": "AI Analytics",
  "aggregateOnTriggers": ["CONVERSATION_END"],
  "metrics": [ … ]
}
```

Use when the operator fires on `COMMUNICATION` (per message) but the metric only makes sense
at the end of the conversation — e.g. CSAT, handoff reason, total topics. Without the filter,
each message fire would inflate counters.

**Default behavior** (field absent): aggregate on every fire — matches v2 behavior, which
only ever fires once.

### `dedupBy?: "conversation"`

Per-(operator, conversation, day) dedup. The first fire claims a marker record in Dynamo;
subsequent fires for the same conversation are silently skipped from aggregation.

```json
{
  "operatorName": "Sentiment",
  "dedupBy": "conversation",
  "metrics": [ … ]
}
```

Use when the operator must fire per-message (because some other consumer needs the
running signal) but the metric should count conversations, not events. Independent of
`aggregateOnTriggers` — they compose: trigger filter is checked first, then dedup.

Dedup marker layout in DDB:

```
PK = TENANT#<tenantId>#OP_SEEN#<date>#<operatorName>
SK = CONV#<conversationId>
ttl = now + 7 days
```

## Authentication

v3 uses the same signature scheme as v2 — verified empirically against a real BTG-account
webhook on 2026-06-09. No code changes needed: the existing `validate-signature.ts` handles
both. Twilio sends:

- Header: `X-Twilio-Signature` (HMAC-SHA1)
- Query string: `?bodySHA256=<sha256 of raw JSON body>`

The validator hashes the full URL (including the `bodySHA256` query string) with the
account's auth token and compares to the `X-Twilio-Signature` header.

Failure mode worth knowing: when the auth token on the Lambda doesn't match the Twilio
account that signed the request, signature validation returns 401 silently from the webhook
side. To verify creds locally, hash a sample URL+token and compare against `X-Twilio-Signature`:

```bash
node -e "
const crypto = require('crypto');
const url = 'https://<api>.execute-api.<region>.amazonaws.com/v1/webhook/ci?bodySHA256=<hash>';
console.log(crypto.createHmac('sha1', process.env.TWILIO_AUTH_TOKEN).update(url).digest('base64'));
"
```

## Migrating a tenant from v2 to v3

1. Add the tenant to `tenants.json` with `ciVersion: "v3"`.
2. Add the tenant's v3 operators to `operator-metrics.json` (match `operator.displayName`
   exactly) with the desired metrics + `aggregateOnTriggers` if appropriate.
3. `cdk deploy` to ship config to S3 + force a Lambda cold-start so the new config is
   loaded.
4. In Twilio's Console (or via the v3 ControlPlane API), point the intelligence
   configuration's rule webhook action at the CIRL ingest endpoint
   (`https://<api>.execute-api.<region>.amazonaws.com/v1/webhook/ci`).
5. Verify `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` in the relevant `.env` belong to the
   Twilio account that owns the intelligence configuration. (Different from v2 — signatures
   are per-account, so a multi-account deploy needs separate credentials.)
6. Fire one rule execution and tail `aws logs tail /aws/lambda/cirl-<env>-ingest --follow`
   to confirm the request lands, the signature validates, and the V3Adapter logs
   `Stored operator results { ciVersion: 'v3', count: N }`.

## Operational gotchas

- **`ensureConfigLoaded()` caches per cold-start.** A `cdk deploy` updates the S3 config
  but doesn't necessarily redeploy the Lambda. If a config-only change isn't picked up,
  force a cold start: `aws lambda update-function-configuration --function-name
  cirl-<env>-ingest --description "force reload $(date +%s)"`.
- **IAM: the ingest Lambda needs S3 read on the config bucket.** Granted explicitly in
  `infra/cdk/lib/api-stack.ts`. Without it, `tenants.json` loads silently fail and
  `getTenantConfig` returns null → adapter defaults to v2 → v3 webhooks get
  mis-decoded.
- **Rule-side silent failures.** A v3 rule can produce `OperatorResult` records without
  delivering the webhook action if an operator in the rule errors out. The error is not
  surfaced in Twilio's standard Monitor alerts — only in the per-rule execution log inside
  the Twilio Console. If you see operator results in `/v3/OperatorResults` but no Lambda
  invocation, check the rule's execution history.
- **`X-Tenant-Id` header is for multi-tenant deploys only.** Each `cirl-<env>` deploy uses
  a single tenant via `CIRL_TENANT_ID` env var. Twilio doesn't support custom headers on
  the Rule Execution webhook either way, so don't rely on header-based routing.

## Code references

- `services/ingest/src/adapters/adapter.ts` — `IntelligenceAdapter` interface +
  `NormalizedResult` + `AdapterServerError`
- `services/ingest/src/adapters/v2-adapter.ts` — refactor of the legacy v2 flow
- `services/ingest/src/adapters/v3-adapter.ts` — v3 Rule Execution parser
- `services/ingest/src/handler.ts` — tenant resolution + adapter selection + S3 + EB emit
- `packages/shared/src/tenant-config.ts` — `tenants.json` types + cached loader
- `packages/shared/src/operator-config.ts` — `aggregateOnTriggers` / `dedupBy` types
- `services/processor/src/storage/aggregation-engine.ts` — filter + dedup gate
- `services/processor/src/storage/dynamo.ts:claimOperatorConversationSlot()` — dedup marker
- `services/ingest/src/__tests__/v2-adapter.test.ts` / `v3-adapter.test.ts` — adapter tests
- `services/processor/src/__tests__/aggregation-engine.test.ts` — trigger filter + dedup tests
