# POC Environment Setup & Testing Guide

## Part 1: Environment Setup

### Prerequisites

- Node.js 22+
- AWS CLI configured (`aws sts get-caller-identity` should work)
- AWS CDK bootstrapped in target region (`npx cdk bootstrap` if not)
- Customer's Twilio Account SID and Auth Token
- Customer's Voice Intelligence Service SID

### Step 1: Configure `.env.poc`

The file already exists at the project root. Fill in the customer's Twilio credentials:

```bash
# .env.poc
AWS_REGION=us-east-1
CIRL_ENV=poc
CIRL_ANALYTICS=simple
CIRL_TENANT_ID=poc-customer
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token
SKIP_SIGNATURE_VALIDATION=true   # Keep true until webhook URL is stable
```

### Step 2: Deploy to AWS

```bash
npm run deploy:poc
```

This creates three CloudFormation stacks:
- `CirlPocStorageStack` — DynamoDB table (`cirl-poc`), S3 bucket, EventBridge bus
- `CirlPocApiStack` — 3 Lambdas (ingest, processor, dashboard), API Gateway
- `CirlPocSimpleAnalyticsStack` — Athena DynamoDB Connector, workgroup

**Save the outputs.** You need two URLs:

```
CirlPocApiStack.ApiUrl = https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/v1/
CirlPocApiStack.WebhookUrl = https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/v1/webhook/ci
```

### Step 3: Configure Twilio Voice Intelligence Webhook

1. Go to the **Twilio Console** (using the customer's account)
2. Navigate to **Voice Intelligence** → **Services**
3. Select the Voice Intelligence Service
4. Under **Webhooks**, set:
   - **Transcript Available URL**: paste the `WebhookUrl` from step 2
   - **Method**: POST
5. Save

That's it for setup. When the service processes a call transcript, Twilio will POST to your webhook.

### Step 4: Verify Deployment

Quick smoke test — the API should return an empty result, not an error:

```bash
# Replace with your actual ApiUrl
export API_URL="https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/v1"
export TENANT="poc-customer"

curl -s "$API_URL/tenants/$TENANT/conversations" | jq .
# Expected: { "items": [], "nextToken": null }

curl -s "$API_URL/tenants/$TENANT/metrics" | jq .
# Expected: { "metrics": [], "period": { "from": "...", "to": "..." } }
```

If you get `{"message":"Internal server error"}`, check CloudWatch logs for `cirl-poc-dashboard`.

---

## Part 2: Testing Flow (End-to-End Verification)

Test in the order data flows: **ingest → S3 → EventBridge → processor → DynamoDB → API**.

### Test A: Trigger a Real Webhook

Make a call through the customer's Twilio number that goes through Voice Intelligence. Wait for the transcript to complete (1-2 minutes after call ends).

Alternatively, simulate the webhook manually:

```bash
# Simulates what Twilio sends when a transcript is ready
curl -X POST "$API_URL/webhook/ci" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: poc-customer" \
  -d '{
    "account_sid": "<your-account-sid>",
    "service_sid": "<your-service-sid>",
    "transcript_sid": "<your-transcript-sid>",
    "event_type": "voice_intelligence_transcript_available"
  }'
```

**Expected**: `202 Accepted` with `operatorResults` array listing each operator.

### Test B: Verify S3 (Raw Payloads)

```bash
aws s3 ls s3://cirl-raw-poc-$(aws sts get-caller-identity --query Account --output text)-us-east-1/poc-customer/ --recursive
```

You should see JSON files organized as `{tenant}/{operator}/{version}/{date}/{conversationId}-{timestamp}.json`.

### Test C: Verify EventBridge (Events Emitted)

Check the processor Lambda was triggered:

```bash
aws logs tail /aws/lambda/cirl-poc-processor --since 5m --format short
```

Look for `Processing: tenant=poc-customer, conversation=...` log lines.

### Test D: Verify DynamoDB (Conversations + Metrics)

```bash
# Check conversation was written
aws dynamodb query \
  --table-name cirl-poc \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk": {"S": "TENANT#poc-customer#CONV"}}' \
  --max-items 5 \
  --query "Items[].{PK: PK.S, SK: SK.S, entityType: entityType.S}" \
  --output table

# Check metrics were written
aws dynamodb query \
  --table-name cirl-poc \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk": {"S": "TENANT#poc-customer#AGG#DAY"}}' \
  --max-items 20 \
  --query "Items[].{SK: SK.S, metricName: metricName.S}" \
  --output table
```

### Test E: Verify API (End-to-End)

```bash
# List conversations
curl -s "$API_URL/tenants/poc-customer/conversations" | jq .

# Get metrics (including timing)
curl -s "$API_URL/tenants/poc-customer/metrics" | jq '.metrics[] | select(.metricName | test("handling_time|response_time|conversation_count"))'

# Get a specific conversation's operator results
CONV_ID="<conversationId from above>"
curl -s "$API_URL/tenants/poc-customer/conversations/$CONV_ID" | jq .
```

### Test F: Verify Timing Metrics Specifically

After at least one real transcript processes:

```bash
curl -s "$API_URL/tenants/poc-customer/metrics" | jq '.metrics[] | select(.metricName | test("handling|response|wait|sentence"))'
```

Expected metrics:
- `handling_time_sum`, `handling_time_count` → `avg_handling_time_sec`
- `response_time_sum`, `response_time_count` → `avg_response_time_sec`
- `customer_wait_time_sum`, `customer_wait_time_count` → `avg_customer_wait_time_sec`
- `sentence_count_total`, `agent_sentence_count`, `customer_sentence_count`

### Debugging: If Data Isn't Flowing

| Symptom | Check |
|---|---|
| Webhook returns 401 | `SKIP_SIGNATURE_VALIDATION=true` in `.env.poc`? Redeploy if changed. |
| Webhook returns 500 | CloudWatch: `/aws/lambda/cirl-poc-ingest` — likely Twilio creds issue |
| S3 has files but DynamoDB is empty | CloudWatch: `/aws/lambda/cirl-poc-processor` — EventBridge rule or DynamoDB error |
| DynamoDB has data but API returns empty | Check `CIRL_TENANT_ID` matches what you're querying. Check `X-Tenant-Id` header. |
| Timing metrics are all zero | Sentence API returned empty — check transcript has completed processing in Twilio |
| Operator results empty | Transcript has no operators assigned. Check Voice Intelligence service config. |

---

## Part 3: Unit Test Plan

No tests exist yet. Jest is configured in all three services. Here's what to write:

### Ingest Service (`services/ingest/src/__tests__/`)

**`validate-signature.test.ts`** — Pure function, no mocks needed.
- Valid signature with correct auth token → returns `true`
- Wrong signature → returns `false`
- Body hash mismatch → returns `false`
- Missing bodySHA256 param → still validates signature only

**`handler.test.ts`** — Mock AWS SDK and Twilio client.
- Twilio CI webhook with valid transcript_sid → 202, calls fetchOperatorResults + fetchSentences + writeToS3 + emitEvent
- Twilio CI webhook with missing Twilio creds → 500 with config error
- Legacy webhook with valid payload → 202, writes to S3, emits event
- Legacy webhook missing conversationId → 400
- Missing body → 400
- Invalid JSON body → 400
- Signature validation enabled + invalid signature → 401

**`twilio-client.test.ts`** — Mock the Twilio SDK.
- `fetchOperatorResults` → returns normalized results for each operator type (json, text-generation, extract, classify)
- `fetchTranscript` → returns expected shape (sid, channel, dateCreated)
- `fetchSentences` → returns sorted sentences with correct field mapping (sentenceIndex → index, transcript → text, string startTime → number)
- `computeTimingMetrics` — **Pure function, test thoroughly:**
  - Empty sentences → returns null
  - Single sentence → handlingTimeSec correct, response times = 0
  - Two sentences (customer then agent) → correct response time
  - Two sentences (agent then customer) → correct customer wait time
  - Mixed conversation (customer, agent, customer, agent) → correct averages
  - Overlapping sentences (negative gap) → gaps not counted
  - All same mediaChannel (monologue) → response/wait times = 0

### Processor Service (`services/processor/src/__tests__/`)

**`handler.test.ts`** — Mock DynamoDB and S3.
- Processes EventBridge event → calls writeConversation + writeOperatorResult + updateAggregates
- Event with timingMetrics in metadata → calls updateTimingAggregates
- Event without timingMetrics → does not call updateTimingAggregates
- Schema validation failure → logs warning, continues processing
- Enrichment failure → writes result with enrichmentError flag

**`dynamo.test.ts`** — Mock DynamoDB DocumentClient.
- `writeConversation` → creates/updates item with correct PK/SK, preserves existing payload
- `writeConversation` with agentId/queueId/customerKey → sets GSI keys
- `writeOperatorResult` → PutCommand with correct key pattern
- `updateAggregates` with conversation-intelligence operator → increments all expected metrics
- `updateAggregates` with sentiment operator → increments sentiment metrics
- `updateAggregates` with unknown operator → only increments conversation_count and operator count
- `updateTimingAggregates` → increments handling_time_sum/count, response_time_sum/count, sentence counts
- `updateTimingAggregates` with zero/missing fields → skips those metrics
- `incrementMetric` → read-then-write pattern, adds to existing value

**`validate.test.ts`** — Mock DynamoDB for schema loading.
- Valid payload against schema → `{ valid: true }`
- Invalid payload → `{ valid: false, errors: [...] }`
- Schema not found → `{ valid: true }` (pass-through)

**`enrich.test.ts`** — No mocks needed (current implementation).
- Default enrichment → returns rawPayload unchanged

### API Service (`services/api/src/__tests__/`)

**`handler.test.ts`** — Mock DynamoDB.
- Routes GET /tenants/{id}/conversations → listConversations
- Routes GET /tenants/{id}/conversations/{convId} → getConversation
- Routes GET /tenants/{id}/metrics → getMetrics
- Missing tenantId → 400
- Unknown path → 404
- OPTIONS → CORS preflight headers

**`metrics.test.ts`** — Mock DynamoDB query results.
- Returns raw metrics from DynamoDB
- Computes sentiment_avg from sum/count
- Computes avg_handling_time_sec from sum/count
- Computes avg_response_time_sec from sum/count
- Computes avg_customer_wait_time_sec from sum/count
- Computes transfer_rate_percent from transfers/conversation_count
- Filters by specific metric name
- Default date range = last 30 days
- Custom from/to date range

**`conversations.test.ts`** — Mock DynamoDB query results.
- Default query → uses main table PK
- With agentId filter → uses GSI1
- With queueId filter → uses GSI2
- With customerKey filter → uses GSI3
- Pagination → passes/returns nextToken
- Limit capping → max 100

### Backfilling Aggregates

If you add a new operator aggregation block (in `dynamo.ts`) after data has already been ingested, existing operator results won't have metrics computed. Use the backfill script to re-compute aggregates from stored data without retriggering webhooks.

```bash
# Dry run — preview what would be written, no changes made
DOTENV_CONFIG_PATH=$(pwd)/.env.poc BACKFILL_DRY_RUN=true npm run backfill

# Backfill a specific operator only
DOTENV_CONFIG_PATH=$(pwd)/.env.poc BACKFILL_OPERATOR="MVP - Inter - General KPIs" npm run backfill

# Backfill all operators
DOTENV_CONFIG_PATH=$(pwd)/.env.poc npm run backfill
```

**Environment variables:**

| Variable | Description | Default |
|---|---|---|
| `DOTENV_CONFIG_PATH` | Path to env file | `.env` |
| `BACKFILL_TENANT` | Tenant to backfill | `CIRL_TENANT_ID` from env |
| `BACKFILL_OPERATOR` | Only backfill this operator (by friendly name) | All operators |
| `BACKFILL_DRY_RUN` | Set to `true` to preview without writing | `false` |

**Important:**
- Always do a dry run first to verify the output
- The script **adds** to existing metric values — running it twice will double-count
- If you need to re-run, delete the relevant metrics from DynamoDB first
- The script reads `enrichedPayload` from stored operator results, so data must already be ingested

### Running Tests

All tests are implemented. From the project root:

```bash
# Run all 103 tests
npm test

# Run a specific test file
npx jest services/ingest/src/__tests__/timing-metrics.test.ts

# Run tests for a specific service/package
npx jest services/ingest
npx jest services/processor
npx jest services/api
npx jest packages/shared

# Run with verbose output
npx jest --verbose

# Run in watch mode during development
npx jest --watch
```

### Test Suites

| Suite | File | Tests | Coverage |
|---|---|---|---|
| Timing metrics | `services/ingest/src/__tests__/timing-metrics.test.ts` | 11 | `computeTimingMetrics` — empty, single sentence, overlapping, monologue, rounding, averages, zero gaps, auto-detect channels |
| Signature validation | `services/ingest/src/__tests__/validate-signature.test.ts` | 6 | Valid/invalid signatures, body hash mismatch, tampered body, missing params |
| Ingest handler | `services/ingest/src/__tests__/handler.test.ts` | 10 | Twilio webhook flow, legacy webhook, request validation, signature check, timing in S3/EventBridge payloads |
| Processor handler | `services/processor/src/__tests__/handler.test.ts` | 7 | End-to-end processing, timing aggregates trigger, schema failure passthrough, enrichment failure, DynamoDB error retry, config + generic aggregation |
| Aggregation engine | `services/processor/src/__tests__/aggregation-engine.test.ts` | 24 | All 5 primitive types, edge cases, min/max guards, ignored values, multi-metric payloads, index record writes for surfaceInList fields |
| Timing aggregates | `services/processor/src/__tests__/timing-aggregates.test.ts` | 4 | DynamoDB sum/count increments, zero value skipping, additive to existing values, date formatting |
| API metrics | `services/api/src/__tests__/metrics.test.ts` | 13 | Derived metrics (sentiment, AHT, response time, transfer rate), period-level aggregates, display names (Portuguese), topic/CSAT friendly names, date grouping, filtering |
| API handler | `services/api/src/__tests__/handler.test.ts` | 6 | Route dispatching, CORS headers, OPTIONS preflight, missing tenant 400, conversation enrichment |
| Config loader | `packages/shared/src/__tests__/config-loader.test.ts` | 17 | initializeConfig (valid/invalid JSON), env var fallback, caching, operator lookup by name/SID, surface fields, real config file validation |

### What's Tested vs. What's Not

**Tested (unit):**
- Timing metrics (sentence fetching → computation → aggregation → API derivation)
- Webhook signature validation
- Ingest handler (both Twilio CI and legacy webhook paths)
- Processor pipeline (schema validation, enrichment, DynamoDB writes, error handling)
- Config-driven aggregation engine (all 5 primitive types with edge cases)
- Processor handler config-driven vs hardcoded fallback paths
- API metrics (derived metrics, period aggregates, display names, filtering)
- API routing, CORS, and conversation list enrichment
- Config loader (parsing, caching, operator lookup, list surface fields)
- Real config file validation (operator-metrics.json schema correctness)

**Not tested (requires deployed environment):**
- S3 config loading (mocked — verify by checking S3 after deploy)
- Actual Twilio API calls (mocked — verify with real transcripts in Part 2)
- DynamoDB read/write against live table (mocked — verify with aws cli in Part 2)
- EventBridge event delivery (mocked — verify via CloudWatch logs in Part 2)
- API Gateway request routing (verified by CDK config, test with curl in Part 2)
- CDK infrastructure synthesis (run `cd infra/cdk && npx cdk synth` to verify)
