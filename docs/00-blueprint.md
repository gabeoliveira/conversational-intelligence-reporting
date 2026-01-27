# Conversational Intelligence Reporting Layer (CIRL) - Blueprint

## Overview

CIRL transforms Conversational Intelligence (CI) operator results (JSON) into a usable dashboard with conversation lists, drilldowns, and charts. It's designed as a production-ready template that customers can deploy as-is or customize for their needs.

---

## Goals

- Turn CI operator results (JSON) into a usable dashboard (conversation list, drilldowns, charts)
- No exposed credentials in the UI
- Multi-tenant capable data model (single-tenant deployment by default)
- Deployable as a template and runnable as a demo environment built from the same template

## Non-Goals

- Real-time streaming (CI exports once anyway)
- A full BI platform (we provide "enough dashboard" + export hooks)
- Tenant management UI (data model supports it, but not built until needed)

---

## 1. High-Level Architecture

### Surfaces

| Surface | Description | Use Case |
|---------|-------------|----------|
| **Flex Plugin UI** (primary) | Embedded inside Flex | Agent/supervisor experience |
| **Standalone Web UI** (secondary) | Same frontend, deployable to S3/CloudFront | Non-Flex customers |

### Control Planes

- **Schema Registry** (per tenant): JSON Schema for each operator version, customer-defined
- **View Config** (per tenant): UI view config describing filters/tables/charts

### Data Planes

- **Ingestion API**: Webhook receiver with async processing
- **Storage**:
  - **S3**: Immutable raw payloads (audit + cheap retention)
  - **DynamoDB**: Query/index + precomputed aggregates

---

## 2. End-to-End Data Flow

### A. Operator Results Ingest (Async Architecture)

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  CI Webhook     │────▶│  API Gateway    │────▶│  Ingest Lambda  │
│  (POST payload) │     │                 │     │  (validate+S3)  │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │   EventBridge   │
                                                └────────┬────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │ Processor Lambda│
                                                │ (enrich+DynamoDB│
                                                │  +aggregates)   │
                                                └─────────────────┘
```

**Ingest Lambda responsibilities:**
1. Validates request authenticity (signature check)
2. Maps request → tenant_id (via customer_key mapping or header)
3. Writes raw payload to S3 immediately (fast acknowledgment)
4. Emits event to EventBridge

**Processor Lambda responsibilities:**
1. Loads schema version for that operator
2. Validates payload against schema
3. Runs enrichment hook (async-capable, can call external APIs)
4. Writes index records to DynamoDB
5. Updates aggregate metrics

**Why async?**
- Decouples "acknowledge receipt" from "process and index"
- Enrichment can call slow external APIs (CRM) without blocking webhook response
- More resilient - if DynamoDB throttles, EventBridge retries
- CI doesn't expect sub-second responses

### B. Dashboard Read

1. User opens Flex plugin (or standalone UI)
2. UI authenticates:
   - **Flex**: Uses existing Flex session/context
   - **Standalone**: Authenticates via Stytch, gets access token
3. UI calls Dashboard API:
   - `/conversations` - list with filters
   - `/conversations/{id}` - drilldown
   - `/metrics` - precomputed series/top-K
   - `/schemas` + `/views` - for dynamic UI generation

---

## 3. AWS Components

### Compute

| Component | Purpose |
|-----------|---------|
| API Gateway (REST) | HTTP entry point |
| Lambda: `ingest-webhook` | Validate + S3 write + emit event |
| Lambda: `processor` | Enrich + DynamoDB write + aggregates |
| Lambda: `dashboard-api` | Read APIs for UI |
| EventBridge | Async event routing |

### Storage

| Component | Purpose |
|-----------|---------|
| S3: `cirl-raw-{env}` | Raw CI payloads (`tenant_id/operator/version/date/...json`) |
| S3: `cirl-ui-{env}` | Built frontend (for standalone mode) |
| DynamoDB: `cirl-{env}` | Single-table for all entities |

### Security & Ops

| Component | Purpose |
|-----------|---------|
| KMS | Encrypt S3 + DynamoDB |
| CloudWatch | Logs + metrics |
| AWS WAF (optional) | In front of API Gateway |
| Secrets Manager / SSM | Config (IdP issuer/audience, Twilio signature secret) |

### Performance Characteristics

- **API Gateway**: 10,000 req/s default (far exceeds typical contact center load)
- **Lambda concurrency**: 1,000 default (sufficient for ~10,000 conversations/day)
- **Cold starts**: 100-500ms for Node.js (acceptable for non-real-time ingest)
- **Cost optimization**: SQS batching between webhook and writer is available if throttling occurs, but not needed initially

---

## 4. DynamoDB Data Model

### Table Design

- **Table name**: `cirl-{env}`
- **Keys**: `PK`, `SK`
- **Design**: Single-table, multi-tenant capable

> **Note**: The PK prefix pattern (`TENANT#{tenantId}`) costs nothing and enables future multi-tenancy without migration. Default deployments use a single tenant.

### Entities

#### Conversation Header (listable)

| Attribute | Value |
|-----------|-------|
| PK | `TENANT#{tenantId}#CONV` |
| SK | `TS#{yyyyMMddHHmmss}#CONV#{conversationId}` |
| Attributes | `conversationId`, `customerKey`, `channel`, `agentId`, `teamId`, `queueId`, `startedAt`, `endedAt`, `summary` |

#### Operator Results (drilldown)

| Attribute | Value |
|-----------|-------|
| PK | `TENANT#{tenantId}#CONV#{conversationId}` |
| SK | `OP#{operatorName}#V#{schemaVersion}#TS#{yyyyMMddHHmmss}` |
| Attributes | `operatorName`, `schemaVersion`, `s3Uri`, `displayFields`, `normalized`, `enrichedAt` |

#### Aggregates (precomputed)

| Attribute | Value |
|-----------|-------|
| PK | `TENANT#{tenantId}#AGG#DAY` |
| SK | `DAY#{yyyyMMdd}#METRIC#{metricName}` |
| Attributes | `value`, `dimensions` |

**Aggregate computation**: Performed by Processor Lambda on each ingest (incremental updates). For complex aggregates, a scheduled batch job (hourly/daily) can recompute from source records.

#### Schema Registry

| Attribute | Value |
|-----------|-------|
| PK | `TENANT#{tenantId}#SCHEMA` |
| SK | `OP#{operatorName}#V#{schemaVersion}` |
| Attributes | `jsonSchema` (or S3 pointer), `uiConfig`, `status`, `createdAt`, `createdBy` |

> **Note**: Customers own schema definitions. CI operators have free-form schemas defined by the customer. The template includes example schemas as starting points.

#### View Config

| Attribute | Value |
|-----------|-------|
| PK | `TENANT#{tenantId}#VIEW` |
| SK | `OP#{operatorName}#V#{schemaVersion}` |
| Attributes | `columns`, `filters`, `charts`, `hiddenFields`, `computedFields` |

### GSIs

| GSI | PK | SK | Use Case |
|-----|----|----|----------|
| GSI1 (by agent) | `TENANT#{tenantId}#AGENT#{agentId}` | `TS#...#CONV#...` | Filter by agent |
| GSI2 (by queue) | `TENANT#{tenantId}#QUEUE#{queueId}` | `TS#...` | Filter by queue/team |
| GSI3 (by customerKey) | `TENANT#{tenantId}#CK#{customerKey}` | `TS#...` | Lookup by customer |

---

## 5. API Blueprint

### Ingestion

```
POST /webhook/ci
```

- Validates origin (Twilio signature check)
- Writes raw to S3
- Emits to EventBridge
- Returns `202 Accepted` immediately

### Read APIs (Dashboard)

```
GET  /tenants/{tenantId}/conversations?from=&to=&agentId=&queueId=&q=
GET  /tenants/{tenantId}/conversations/{conversationId}
GET  /tenants/{tenantId}/metrics?from=&to=&metric=sentiment_avg|top_intents|...
GET  /tenants/{tenantId}/schemas
GET  /tenants/{tenantId}/schemas/{operatorName}/versions/{version}
GET  /tenants/{tenantId}/views
POST /tenants/{tenantId}/views  (admin only)
```

### Export (optional)

```
POST /tenants/{tenantId}/exports          → returns job id
GET  /tenants/{tenantId}/exports/{jobId}  → signed URL to CSV/JSON in S3
```

---

## 6. Authentication & Authorization

### Auth Strategy by Surface

| Surface | Auth Method |
|---------|-------------|
| **Flex Plugin** | Existing Flex session/context |
| **Standalone Web** | Stytch (Twilio-owned solution) |

### Token Claims (standardized)

```json
{
  "tenant_id": "acme-corp",
  "roles": ["ci_viewer", "ci_analyst", "ci_admin"],
  "teams": ["support", "sales"],  // optional: scoped access
  "queues": ["queue-123"]         // optional: scoped access
}
```

### RBAC Rules

| Role | Permissions |
|------|-------------|
| `ci_viewer` | Read-only, no exports |
| `ci_analyst` | Read + exports + saved views |
| `ci_admin` | Manage schemas/views, retention, feature toggles |

### API Authorization Flow

1. Extract token from `Authorization` header
2. Validate signature (JWKS for Stytch, Flex validation for Flex)
3. Map claims to tenant + roles
4. Enforce RBAC on each endpoint

---

## 7. UI Blueprint

### Primary User: Supervisors

The UI is optimized for supervisors reviewing aggregate data and drilling into specific conversations.

### Pages

#### Overview (Landing)

- KPI cards (conversation count, avg sentiment, compliance rate)
- Time series chart(s) for trends
- Quick filters (today, this week, this month)

#### Conversations (List)

- Filterable table: date range, agent, queue, tags, search
- Sortable columns
- Click to drill down

#### Conversation Detail

- Conversation timeline
- Operator result sections (rendered from schema + view config)
- Raw payload viewer (collapsible)

#### Admin (role-gated)

- Schema registry viewer
- View config editor (JSON) with validation + preview
- Feature toggles

### Rendering Strategy

1. **Schema-driven**: Infer columns and filter widgets from JSON Schema
2. **View config overrides**: Rename fields, hide fields, computed fields, chart definitions
3. **Graceful degradation**: Unknown fields render as raw JSON

---

## 8. Customization Surfaces

Customers have three explicit, bounded places to customize:

### Surface 1: Schema + View Config (no-code / low-code)

```
/config/schemas/{operatorName}/v{n}.schema.json
/config/views/{operatorName}/v{n}.view.json
```

- Define what data looks like (schema)
- Define how data displays (view)
- No code changes required

### Surface 2: Enrichment Hook (one file)

```
/services/processor/src/enrich/enrich.ts
```

```typescript
export interface EnrichmentContext {
  tenantId: string;
  conversationId: string;
  operatorName: string;
  rawPayload: Record<string, unknown>;
}

export interface EnrichmentResult {
  enrichedPayload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// Async-capable: can call external APIs (CRM, etc.)
export async function enrich(ctx: EnrichmentContext): Promise<EnrichmentResult> {
  // Default: pass through unchanged
  return { enrichedPayload: ctx.rawPayload };
}
```

**Use cases:**
- Map customerKey → internal CRM IDs
- Add business context from external systems
- Redact sensitive fields
- Compute derived fields

**Error handling:**
- If enrichment fails, the record is still written (with `enrichmentError` flag)
- Enrichment errors are logged but don't block ingest

### Surface 3: Deployment Choice

| Option | Description |
|--------|-------------|
| **Door A: Flex Plugin** | Embed UI in Flex for agents/supervisors |
| **Door B: Standalone** | Deploy to S3/CloudFront for non-Flex users |

Same backend; only the UI mount and auth method change.

---

## 9. Repository Structure

```
cirl-template/
├── README.md
├── package.json
│
├── /docs
│   ├── 00-blueprint.md              # This document
│   ├── 01-what-you-get.md
│   ├── 02-deploy-to-aws.md
│   ├── 03-connect-ci-webhook.md
│   ├── 04-add-your-first-operator.md
│   ├── 05-embed-in-flex.md
│   └── 06-standalone-hosting.md
│
├── /infra
│   └── /cdk
│       ├── bin/
│       ├── lib/
│       │   ├── api-stack.ts
│       │   ├── storage-stack.ts
│       │   ├── auth-stack.ts
│       │   └── waf-stack.ts
│       └── cdk.json
│
├── /services
│   ├── /ingest
│   │   ├── src/
│   │   │   ├── handler.ts           # Lambda entry point
│   │   │   ├── validate-signature.ts
│   │   │   └── s3-writer.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── /processor
│   │   ├── src/
│   │   │   ├── handler.ts           # EventBridge trigger
│   │   │   ├── schema/
│   │   │   │   └── validate.ts
│   │   │   ├── enrich/
│   │   │   │   └── enrich.ts        # CUSTOMIZATION SURFACE
│   │   │   └── storage/
│   │   │       └── dynamo.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── /api
│       ├── src/
│       │   ├── handlers/
│       │   │   ├── conversations.ts
│       │   │   ├── metrics.ts
│       │   │   ├── schemas.ts
│       │   │   └── views.ts
│       │   ├── auth/
│       │   │   ├── verify-flex.ts
│       │   │   └── verify-stytch.ts
│       │   └── rbac/
│       │       └── authorize.ts
│       ├── package.json
│       └── tsconfig.json
│
├── /ui
│   ├── src/
│   ├── public/
│   ├── package.json
│   └── vite.config.ts
│
├── /flex-plugin
│   ├── src/
│   └── package.json
│
└── /config
    ├── /schemas
    │   └── /example-sentiment
    │       └── v1.schema.json
    ├── /views
    │   └── /example-sentiment
    │       └── v1.view.json
    └── /demo-data
        ├── seed-conversations.json
        └── seed-operator-results.json
```

---

## 10. Demo Mode

Demo mode uses the **exact same stack** with additional seed data:

1. **Pre-loaded tenant**: `demo` tenant with example schemas/views
2. **Seed data**: DynamoDB + S3 populated with sample conversations
3. **Replay script**: `npm run demo:replay` posts demo payloads to `/webhook/ci`

```bash
# Deploy demo environment
npm run deploy -- --context env=demo

# Seed demo data
npm run demo:seed

# (Optional) Replay webhook calls
npm run demo:replay
```

---

## 11. Customer Onboarding Sequence

The template guides customers through this exact sequence:

| Step | Action | Outcome |
|------|--------|---------|
| 1. **See it** | View screenshots, 2-min video, "what you get" | Understand the value |
| 2. **Deploy it** | `npm run deploy` | Stack running in AWS |
| 3. **Connect CI** | Paste webhook URL into CI service config | Data flowing |
| 4. **Add operator** | Drop schema + view JSON files | Custom operator visible |
| 5. **Embed in Flex** | Build + deploy Flex plugin | Supervisors can access |
| 6. **(Optional)** | Switch to standalone hosting | Non-Flex access |

---

## 12. Future Considerations (Not in Scope)

These are explicitly deferred until customer demand:

- **Tenant management UI**: Data model supports multi-tenancy, but no admin UI
- **Real-time updates**: WebSocket subscriptions for live dashboard
- **Advanced analytics**: ML-powered insights, anomaly detection
- **Custom storage adapters**: PostgreSQL, Snowflake, etc.
- **Workflow triggers**: Alert on sentiment drop, escalation rules

---

## Appendix A: Example Schema (Sentiment Operator)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "sentiment-v1",
  "type": "object",
  "properties": {
    "overall_sentiment": {
      "type": "string",
      "enum": ["positive", "neutral", "negative"]
    },
    "sentiment_score": {
      "type": "number",
      "minimum": -1,
      "maximum": 1
    },
    "key_phrases": {
      "type": "array",
      "items": { "type": "string" }
    },
    "sentiment_by_speaker": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "sentiment": { "type": "string" },
          "score": { "type": "number" }
        }
      }
    }
  },
  "required": ["overall_sentiment", "sentiment_score"]
}
```

## Appendix B: Example View Config

```json
{
  "operatorName": "sentiment",
  "version": "v1",
  "display": {
    "title": "Sentiment Analysis",
    "icon": "sentiment"
  },
  "table": {
    "columns": [
      { "field": "overall_sentiment", "label": "Sentiment", "type": "badge" },
      { "field": "sentiment_score", "label": "Score", "type": "number", "format": "+0.00" }
    ]
  },
  "detail": {
    "sections": [
      {
        "title": "Overview",
        "fields": ["overall_sentiment", "sentiment_score"]
      },
      {
        "title": "Key Phrases",
        "field": "key_phrases",
        "type": "tag-list"
      },
      {
        "title": "By Speaker",
        "field": "sentiment_by_speaker",
        "type": "key-value-table"
      }
    ]
  },
  "charts": [
    {
      "type": "pie",
      "field": "overall_sentiment",
      "title": "Sentiment Distribution"
    }
  ]
}
```
