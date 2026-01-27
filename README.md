# Conversational Intelligence Reporting Layer (CIRL)

Transform Twilio Conversational Intelligence operator results into a queryable data layer for analytics and dashboards.

## What You Get

- **Webhook ingestion** with Twilio signature validation and async processing
- **REST API** for conversations, metrics, and operator results
- **Automatic metrics aggregation** at ingestion-time
- **BI tool integration** - Connect QuickSight, Tableau, Looker, or Power BI
- **Multi-tenant support** with flexible schema validation
- **Demo mode** with sample data for quick evaluation

## Architecture

```
┌─────────────┐
│ Twilio CI   │
│  Webhooks   │
└──────┬──────┘
       │
       v
┌─────────────────────────────────────────────────┐
│  Ingest Lambda                                  │
│  • Validates Twilio signature                   │
│  • Stores raw payload to S3                     │
│  • Emits EventBridge event                      │
└──────┬──────────────────────────────────────────┘
       │
       v
┌─────────────────────────────────────────────────┐
│  Processor Lambda                               │
│  • Schema validation                            │
│  • Custom enrichment hooks                      │
│  • Writes to DynamoDB                           │
│  • Calculates aggregate metrics                 │
└──────┬──────────────────────────────────────────┘
       │
       v
┌─────────────────────────────────────────────────┐
│  DynamoDB (Single-table design)                 │
│  • Conversations + Operator Results             │
│  • Daily aggregate metrics                      │
│  • GSIs for agent/queue/customer filtering      │
└──────┬──────────────────────────────────────────┘
       │
       v
┌─────────────────────────────────────────────────┐
│  Dashboard API (REST)                           │
│  • List/filter conversations                    │
│  • Get conversation + operator results          │
│  • Query aggregate metrics                      │
└──────┬──────────────────────────────────────────┘
       │
       v
┌─────────────────────────────────────────────────┐
│  Your Choice:                                   │
│  • BI Tool (QuickSight, Tableau, etc.)         │
│  • Custom Dashboard                             │
│  • Flex Plugin                                  │
└─────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 20+
- AWS CLI configured with credentials
- AWS CDK CLI (`npm install -g aws-cdk`)
- Twilio Account SID and Auth Token

### 1. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```bash
AWS_REGION=us-east-1
CIRL_ENV=demo
CIRL_TENANT_ID=your-tenant-id

TWILIO_ACCOUNT_SID=ACxxx...
TWILIO_AUTH_TOKEN=xxx...
```

### 2. Deploy Infrastructure

```bash
# Install dependencies
npm install

# Bootstrap CDK (first time only)
cd infra/cdk && npx cdk bootstrap

# Deploy
npm run deploy:demo
```

### 3. Note Your API Endpoints

After deployment:
```
✅  CirlDemoApiStack

Outputs:
CirlDemoApiStack.ApiUrl = https://xxx.execute-api.us-east-1.amazonaws.com/v1/
CirlDemoApiStack.WebhookUrl = https://xxx.execute-api.us-east-1.amazonaws.com/v1/webhook/ci
```

### 4. Configure Twilio CI Webhook

Set the webhook URL in your Twilio Voice Intelligence service configuration to point to the `WebhookUrl` from above.

### 5. Test with Sample Data

```bash
npm run demo:seed
```

---

## API Reference

### Base URL
```
https://{api-id}.execute-api.{region}.amazonaws.com/v1
```

### Endpoints

#### List Conversations
```http
GET /tenants/{tenantId}/conversations
```

Query Parameters:
- `from` - ISO date filter (e.g., `2026-01-20`)
- `to` - ISO date filter
- `agentId` - Filter by agent
- `queueId` - Filter by queue
- `customerKey` - Filter by customer
- `limit` - Max results (default: 50, max: 100)
- `nextToken` - Pagination token

Response:
```json
{
  "items": [
    {
      "conversationId": "GT...",
      "tenantId": "your-tenant",
      "channel": { "type": "voice", ... },
      "startedAt": "2026-01-27T10:00:00Z",
      "operatorCount": 5
    }
  ],
  "nextToken": "..."
}
```

#### Get Single Conversation
```http
GET /tenants/{tenantId}/conversations/{conversationId}
```

Response:
```json
{
  "conversation": {
    "conversationId": "GT...",
    "operatorCount": 5,
    ...
  },
  "operators": [
    {
      "operatorName": "conversation-summary",
      "schemaVersion": "1.0",
      "enrichedPayload": { ... },
      "displayFields": { ... }
    }
  ]
}
```

#### Get Metrics
```http
GET /tenants/{tenantId}/metrics
```

Query Parameters:
- `from` - Start date (default: 30 days ago)
- `to` - End date (default: today)
- `metric` - Filter by specific metric name

Response:
```json
{
  "metrics": [
    { "date": "20260127", "metricName": "conversation_count", "value": 42 },
    { "date": "20260127", "metricName": "operator_pii-detect_count", "value": 15 },
    { "date": "20260127", "metricName": "sentiment_avg", "value": 7.5 }
  ],
  "period": { "from": "2026-01-20", "to": "2026-01-27" }
}
```

**Available Metrics:**
- `conversation_count` - Total conversations
- `operator_{name}_count` - Per-operator execution count
- `sentiment_avg` - Average sentiment score (0-100 scale)
- `intent_avg_confidence` - Average intent confidence (0-100 scale)
- `pii_entities_detected` - Total PII entities found
- `pii_avg_entities_per_conversation` - Average PII per conversation
- `summary_avg_words` - Average summary length
- `classification_avg_confidence` - Average classification confidence
- `virtual_agent_quality_avg` - Average virtual agent quality (0-10 scale)
- `human_agent_quality_avg` - Average human agent quality (0-10 scale)
- `transfer_rate_percent` - Percentage of conversations transferred to human
- `virtual_agent_resolved_without_human_percent` - Auto-resolution rate
- `human_agent_resolved_problem_percent` - Human agent success rate

See [docs/bi-integration.md](docs/bi-integration.md) for full metrics catalog.

#### List Schemas
```http
GET /tenants/{tenantId}/schemas
```

#### Get Schema Version
```http
GET /tenants/{tenantId}/schemas/{operatorName}/versions/{version}
```

---

## BI Tool Integration

The API is designed for direct integration with BI tools. See integration guides:

- **[AWS QuickSight](docs/bi-integration.md#quicksight)** - Native AWS integration
- **[Tableau](docs/bi-integration.md#tableau)** - Web Data Connector
- **[Looker](docs/bi-integration.md#looker)** - API-backed models
- **[Power BI](docs/bi-integration.md#power-bi)** - REST connector

**Quick Example (QuickSight):**
1. Create new data source → API
2. Enter API URL: `https://your-api-url/v1/tenants/your-tenant/metrics`
3. Build visualizations with drag-and-drop

---

## Customization

### Add Custom Metrics

Edit `services/processor/src/storage/dynamo.ts` in the `updateAggregates` function:

```typescript
// Example: Track custom operator-specific metric
if (operatorName === 'my-custom-operator') {
  const customValue = payload.my_field as number;
  if (typeof customValue === 'number') {
    await incrementMetric(tenantId, date, 'custom_metric_sum', customValue);
    await incrementMetric(tenantId, date, 'custom_metric_count', 1);
  }
}
```

Then compute derived metrics in `services/api/src/handlers/metrics.ts`:

```typescript
// Compute average
const sum = metrics.get('custom_metric_sum');
const count = metrics.get('custom_metric_count');
if (sum && count) {
  derived.push({
    date,
    metricName: 'custom_metric_avg',
    value: Math.round(sum / count * 100) / 100,
  });
}
```

### Add Enrichment Logic

Edit `services/processor/src/enrich/enrich.ts`:

```typescript
export async function enrich(ctx: EnrichmentContext): Promise<EnrichmentResult> {
  // Add CRM lookups, field mappings, etc.
  const enriched = {
    ...ctx.rawPayload,
    customer_segment: await lookupSegment(ctx.conversationId),
  };

  return { enrichedPayload: enriched };
}
```

### Configure Operator Schemas

Add JSON schemas to `config/schemas/{operator-name}/v{version}.schema.json` for validation.

**Recommended:** Use the consolidated `conversation-intelligence` operator schema (`config/schemas/conversation-intelligence/v1.schema.json`) which combines sentiment, intent, and summary analysis in a single operator - reducing Twilio costs and simplifying processing.

See [docs/schema-design.md](docs/schema-design.md) for details on consolidated vs. separate operator schemas.

---

## Project Structure

```
├── config/
│   └── schemas/            # Operator JSON schemas
├── docs/                   # Documentation
│   └── bi-integration.md   # BI tool setup guides
├── infra/cdk/             # AWS CDK infrastructure
├── packages/shared/       # Shared TypeScript types
├── scripts/               # Demo data scripts
└── services/
    ├── api/               # Dashboard API Lambda
    ├── ingest/            # Webhook ingestion Lambda
    └── processor/         # Event processing Lambda
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AWS_REGION` | Yes | AWS region for deployment |
| `CIRL_ENV` | Yes | Environment name (dev, demo, prod) |
| `CIRL_TENANT_ID` | No | Default tenant ID (for single-tenant) |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio Auth Token |
| `SKIP_SIGNATURE_VALIDATION` | No | Set to `true` for testing only |

---

## Security

- **Webhook Signature Validation**: All Twilio webhooks are validated using HMAC-SHA256
- **Multi-tenant Isolation**: Tenant ID extracted from `X-Tenant-Id` header or defaults
- **CORS**: Configured for Flex Plugin integration
- **IAM Permissions**: Lambda functions have least-privilege IAM roles

---

## Monitoring

CloudWatch Logs:
- `/aws/lambda/cirl-{env}-ingest` - Webhook ingestion logs
- `/aws/lambda/cirl-{env}-processor` - Processing logs
- `/aws/lambda/cirl-{env}-dashboard` - API request logs

Metrics to monitor:
- Lambda invocation errors
- DynamoDB throttles
- S3 put failures

---

## License

Apache-2.0
