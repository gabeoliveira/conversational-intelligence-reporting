# Conversational Intelligence Reporting Layer (CIRL) - Blueprint

## Overview

CIRL transforms Conversational Intelligence (CI) operator results (JSON) into queryable data for analytics and reporting. It provides a REST API for operational queries and an Athena + Glue SQL layer for BI tool integration. It's designed as a production-ready template that customers can deploy as-is or customize for their needs.

---

## Goals

- Turn CI operator results (JSON) into queryable data for analytics and reporting
- BI-agnostic design: Support QuickSight, Tableau, PowerBI, Looker, Grafana, etc.
- REST API for operational queries and custom dashboards
- SQL query layer (Athena + Glue) for standard BI tools
- Multi-tenant capable data model (single-tenant deployment by default)
- Deployable as a template and runnable as a demo environment built from the same template

## Non-Goals

- Real-time streaming (CI exports once anyway)
- Custom dashboard UI (customers use their preferred BI tool)
- Tenant management UI (data model supports it, but not built until needed)

---

## 1. High-Level Architecture

### Integration Surfaces

| Surface | Description | Use Case |
|---------|-------------|----------|
| **BI Tools** (primary) | QuickSight, Tableau, PowerBI, Looker via Athena | Historical analysis, reporting, dashboards |
| **REST API** (secondary) | Direct API access for custom dashboards | Real-time operational queries, Flex plugins, Grafana |

### Control Planes

- **Schema Registry** (per tenant): JSON Schema for each operator version, customer-defined
- **View Config** (per tenant): UI view config describing filters/tables/charts

### Data Planes

- **Ingestion API**: Webhook receiver with async processing
- **Storage**:
  - **S3 Raw (Bronze)**: Immutable raw payloads (audit + cheap retention)
  - **DynamoDB**: Fast operational queries + real-time precomputed aggregates
  - **S3 Curated (Silver)**: Flattened Parquet via Glue ETL for analytical queries
  - **S3 Aggregated (Gold)**: Pre-computed metric rollups via Glue ETL
  - **Athena + Glue**: SQL query layer for BI tools (queries S3 Parquet tables)

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

### B. Analytics & Reporting

**Option 1: BI Tools (Primary)**
1. User connects QuickSight/Tableau/PowerBI to Athena
2. BI tool authenticates with AWS credentials (IAM role)
3. BI tool queries via SQL:
   - `SELECT * FROM conversations WHERE ...`
   - `SELECT * FROM metrics WHERE ...`
   - `SELECT * FROM operators WHERE ...`

**Option 2: REST API (Secondary)**
1. Custom dashboard or Flex plugin calls REST API
2. API authenticates request (API key, IAM, or JWT)
3. API returns JSON:
   - `/conversations` - list with filters
   - `/conversations/{id}` - drilldown
   - `/metrics` - precomputed aggregates

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
| S3: `cirl-raw-{env}` | Bronze layer - Raw CI payloads (`tenant_id/operator/version/date/...json`) |
| S3: `cirl-curated-{env}` | Silver layer - Flattened Parquet (conversations, operator results) |
| S3: `cirl-aggregated-{env}` | Gold layer - Pre-computed metric rollups (Parquet) |
| S3: `cirl-athena-{env}` | Athena query results |
| DynamoDB: `cirl-{env}` | Single table - conversations, operator results, and real-time aggregates |
| Glue Database: `cirl_{env}` | Catalog for lakehouse tables (`lakehouse_conversations`, `lakehouse_operator_results`, `lakehouse_metrics`) |
| Athena Workgroup: `cirl-{env}` | Dedicated workgroup for BI queries against S3 Parquet |

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

## 4. Storage Architecture Decision

CIRL supports two analytics modes, controlled by the `CIRL_ANALYTICS` environment variable:

- **`none`** (default): No analytics stack. REST API only (Grafana, Metabase, custom dashboards). Zero operational overhead.
- **`simple`**: Athena queries DynamoDB directly via federated query. No ETL, no Parquet. Best for SQL-based BI tools and <100K conversations/month.
- **`lakehouse`**: Glue ETL transforms raw JSON into S3 Parquet (Bronze → Silver → Gold). Best for >100K conversations/month and heavy analytics.

Both modes share the same DynamoDB table, REST API, and ingestion pipeline. They only differ in how BI tools query data via Athena.

### Lakehouse Architecture (Bronze → Silver → Gold)

When `CIRL_ANALYTICS=lakehouse`, CIRL deploys a **modern data lakehouse** that separates operational workloads (DynamoDB + API) from analytical workloads (S3 Parquet + Athena):

**S3 Raw — Bronze Layer**
- Archive of raw CI payloads for compliance and replay
- Low-cost long-term storage (~$0.023/GB/month)
- Source of truth for data recovery and reprocessing

**DynamoDB — Operational Layer**
- Single table (`cirl-{env}`) for conversations, operator results, and real-time aggregates
- Fast operational queries for REST API (<100ms response times)
- Real-time metric increments computed at ingestion time by the Processor Lambda
- Powers Grafana, Metabase, Flex plugins, and custom dashboards

**S3 Curated — Silver Layer**
- Flattened Parquet files produced by Glue ETL from raw JSON
- Partitioned by `tenant_id/year/month/day` for efficient queries
- Tables: `lakehouse_conversations`, `lakehouse_operator_results`

**S3 Aggregated — Gold Layer**
- Pre-computed daily metric rollups in Parquet format
- Produced by Glue ETL from the Silver layer
- Table: `lakehouse_metrics`
- Also writes back to DynamoDB for fast API reads

**Athena + Glue**
- SQL layer for BI tools (QuickSight, Tableau, PowerBI)
- Queries S3 Parquet tables (not DynamoDB) for cost-effective, fast analytics
- Glue database `cirl_{env}` catalogs all lakehouse tables

### Dual Metrics Path

Metrics are computed in two independent ways:

1. **Real-time (Processor Lambda → DynamoDB)**: Incremental updates at ingestion time. Fast but approximate (no deduplication).
2. **Batch (Glue ETL → S3 Gold + DynamoDB)**: Daily rollups from curated data. Accurate but delayed.

The REST API serves DynamoDB metrics for real-time dashboards. BI tools query S3 Gold layer via Athena for historical analysis. The Glue job also writes back to DynamoDB, which reconciles the two paths on each run.

### Why Not DynamoDB Federated Query?

We initially considered using Athena's DynamoDB Connector to query DynamoDB directly. We moved to the lakehouse approach because:

- **Cost**: Federated queries invoke Lambda + scan DynamoDB RCUs on every BI query
- **Performance**: Lambda connector overhead + DynamoDB not optimized for analytical scans
- **Isolation**: BI queries would consume DynamoDB capacity, affecting operational APIs
- **Capabilities**: Parquet supports columnar reads, partitioning, and complex analytics that DynamoDB federation cannot

See [LAKEHOUSE-ARCHITECTURE.md](./LAKEHOUSE-ARCHITECTURE.md) for full details including cost comparisons.

### Simplification Options

Customers can remove DynamoDB if:
- BI reporting is the primary use case
- They can tolerate hours of data latency (Glue ETL schedule)
- Cost optimization is critical (S3 is ~90% cheaper)

See the README's "Architecture Decisions & Simplification" section for details.

---

## 5. DynamoDB Data Model

### Table Design

CIRL uses a **single DynamoDB table** (`cirl-{env}`) with a single-table design pattern. All entity types (conversations, operator results, aggregates, schemas, views) share the same table, distinguished by PK/SK patterns.

> **Note**: The PK prefix pattern (`TENANT#{tenantId}`) costs nothing and enables future multi-tenancy without migration. Default deployments use a single tenant.

> **Note**: BI tools do not query DynamoDB directly. Analytical queries go through Athena against S3 Parquet tables (see Section 4). DynamoDB is only used by the REST API for operational queries.

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

#### Aggregates (precomputed - same table)

Stored in the same `cirl-{env}` table, distinguished by PK/SK pattern:

| Attribute | Value |
|-----------|-------|
| PK | `TENANT#{tenantId}#AGG#DAY` |
| SK | `DAY#{yyyyMMdd}#METRIC#{metricName}` |
| Attributes | `value`, `metricName`, `date`, `tenantId`, `entityType` |

**Aggregate computation**: Two paths:
1. **Real-time**: Processor Lambda increments metrics on each ingest (fast, approximate)
2. **Batch**: Glue ETL job recomputes from curated S3 data and writes back to DynamoDB (accurate, daily)

> **Note**: BI tools query the Gold layer S3 Parquet tables via Athena, not DynamoDB aggregates. The DynamoDB aggregates power the REST API for real-time dashboards.

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

## 6. API Blueprint

### Ingestion

```
POST /webhook/ci
```

- Validates origin (Twilio signature check)
- Writes raw to S3
- Emits to EventBridge
- Returns `202 Accepted` immediately

### Read APIs (REST)

```
GET  /tenants/{tenantId}/conversations?from=&to=&agentId=&queueId=&customerKey=
GET  /tenants/{tenantId}/conversations/{conversationId}
GET  /tenants/{tenantId}/metrics?from=&to=&metric=sentiment_avg|...
GET  /tenants/{tenantId}/schemas
GET  /tenants/{tenantId}/schemas/{operatorName}/versions/{version}
```

These APIs power:
- Custom dashboards
- Grafana/Metabase integrations
- Flex plugins
- Operational monitoring tools

---

## 7. Authentication & Authorization

### Auth Strategy by Integration

| Integration | Auth Method |
|-------------|-------------|
| **BI Tools (Athena)** | IAM roles with Athena + Glue + DynamoDB read permissions |
| **REST API** | API keys, IAM roles, or JWT tokens |
| **Flex Plugin** | Existing Flex session/context (forwards to REST API) |

### IAM Permissions (for BI Tools)

BI tools accessing Athena need:
- `athena:*` - Run queries in the workgroup
- `glue:GetDatabase`, `glue:GetTable` - Access Glue catalog (`cirl_{env}`)
- `s3:GetObject` - Read S3 Parquet data (curated + aggregated buckets)
- `s3:GetObject`, `s3:PutObject` - Access Athena results bucket

### Multi-Tenancy

Data isolation by `tenant_id`:
- All queries must filter by `tenant_id`
- Row-level security via AWS Lake Formation (optional)
- API validates tenant access on every request

### API Authorization Flow (REST API)

1. Extract credentials from `Authorization` header (API key or IAM signature)
2. Validate and map to `tenant_id`
3. Enforce tenant isolation on all queries
4. Return only data for authorized tenant

---

## 8. BI Integration

### Primary User: Analysts & Supervisors

The architecture supports standard BI tools for reporting and analysis.

### Supported BI Tools

#### Via Athena (SQL-based)

- **AWS QuickSight** - Native Athena integration
- **Tableau** - Athena connector
- **PowerBI** - Athena ODBC driver
- **Looker** - Athena database connection
- **Any SQL tool** - via JDBC/ODBC

#### Via REST API

- **Grafana** - Infinity data source plugin
- **Metabase** - REST API connector
- **Custom dashboards** - Direct API integration
- **Flex plugins** - Embedded operational views

### Available Data Tables (Athena — Glue Database `cirl_{env}`)

#### `lakehouse_conversations` Table (Silver Layer)

Columns: `conversation_id`, `tenant_id`, `customer_key`, `agent_id`, `team_id`, `queue_id`, `started_at`, `channel`, `operator_count`

Partitioned by: `tenant_id`, `year`, `month`, `day`

Use case: Conversation-level analysis, filtering by agent/queue/customer

#### `lakehouse_metrics` Table (Gold Layer)

Columns: `tenant_id`, `date`, `metric_name`, `value`

Partitioned by: `tenant_id`, `year`, `month`

Use case: Pre-aggregated time-series metrics (sentiment, quality scores, counts)

#### `lakehouse_operator_results` Table (Silver Layer)

Columns: `conversation_id`, `tenant_id`, `operator_name`, `schema_version`, `received_at`, `enriched_at`, `enriched_payload`, `display_fields`

Partitioned by: `tenant_id`, `year`, `month`, `day`

Use case: Operator-specific analysis, drill-down into results

### Sample Queries

**Daily sentiment trend:**
```sql
SELECT date, AVG(value) as avg_sentiment
FROM cirl_demo.lakehouse_metrics
WHERE tenant_id = 'your-tenant'
  AND metric_name = 'sentiment_avg'
  AND year = '2026' AND month = '01'
GROUP BY date
ORDER BY date
```

**Top agents by conversation volume:**
```sql
SELECT agent_id, COUNT(*) as conversation_count
FROM cirl_demo.lakehouse_conversations
WHERE tenant_id = 'your-tenant'
  AND year = '2026'
GROUP BY agent_id
ORDER BY conversation_count DESC
LIMIT 10
```

---

## 9. Customization Surfaces

Customers have three explicit, bounded places to customize:

### Surface 1: Operator Schemas (no-code)

```
/config/schemas/{operatorName}/v{n}.schema.json
```

- Define what data looks like (JSON Schema)
- Validation applied at ingestion time
- Use consolidated schema (`conversation-intelligence`) to reduce Twilio costs

See `docs/schema-design.md` for schema design patterns.

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

### Surface 3: Operator Metrics Config (no-code)

```
/config/operator-metrics.json
```

Define how operator result fields are aggregated into metrics using primitive types (boolean, integer, category, enum, category_array). No TypeScript code needed — the aggregation engine reads this config and handles all metric computation automatically.

- Define metric primitives per operator field
- Auto-generates derived metrics (averages, rates, percentages)
- Auto-generates display names (supports localization)
- Controls which fields appear in the conversations list view (`surfaceInList`)

See [config-driven-metrics-plan.md](./config-driven-metrics-plan.md) for the full design and [README.md](../README.md#configure-operator-metrics) for usage.

---

## 10. Repository Structure

```
cirl-template/
├── README.md
├── package.json
│
├── /docs
│   ├── blueprint.md              # This document
│   ├── bi-integration.md            # BI tool setup guides (REST API + Athena)
│   └── schema-design.md          # Operator schema patterns
│
├── /infra
│   └── /cdk
│       ├── bin/
│       ├── lib/
│       │   ├── api-stack.ts
│       │   ├── storage-stack.ts
│       │   └── analytics-stack.ts     # Lakehouse: Glue ETL + Athena + S3 Parquet
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
│       │   │   └── schemas.ts
│       │   └── middleware/
│       │       └── auth.ts
│       ├── package.json
│       └── tsconfig.json
│
└── /config
    ├── /schemas
    │   ├── /conversation-intelligence    # Consolidated operator (recommended)
    │   │   └── v1.schema.json
    │   └── /sentiment                    # Example individual operator
    │       └── v1.schema.json
    └── /demo-data
        ├── seed-conversations.json
        └── seed-operator-results.json
```

---

## 11. Demo Mode

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

## 12. Customer Onboarding Sequence

The template guides customers through this exact sequence:

| Step | Action | Outcome |
|------|--------|---------|
| 1. **Deploy it** | `npm run deploy:demo` | Stack running in AWS (including Athena + Glue) |
| 2. **Seed data** | `npm run demo:seed` | Sample conversations in DynamoDB |
| 3. **Connect BI tool** | Point QuickSight/Tableau to Athena database | Query conversations and metrics |
| 4. **Connect CI webhook** | Paste webhook URL into Twilio CI config | Live data flowing |
| 5. **Add custom operator** | Drop schema JSON file in `/config/schemas` | Custom operator validated |
| 6. **(Optional)** | Customize metrics in `dynamo.ts` | Track business-specific KPIs |

---

## 13. Future Considerations (Not in Scope)

These are explicitly deferred until customer demand:

- **Tenant management API**: Data model supports multi-tenancy, but no admin API yet
- **Real-time updates**: Change Data Capture (CDC) from DynamoDB to S3 for live Athena queries
- **Advanced analytics**: ML-powered insights, anomaly detection via SageMaker
- **Alternative storage**: Write to S3 Parquet instead of DynamoDB (simpler, cheaper)
- **Workflow triggers**: Alert on sentiment drop, escalation rules via EventBridge
- **Data exports**: Pre-signed S3 URLs for bulk CSV/JSON exports

---

## Appendix A: Example Schema (Consolidated Operator)

See `config/schemas/conversation-intelligence/v1.schema.json` for the complete consolidated operator schema.

This schema combines sentiment, classification (intent), summary, and quality assessment in a single operator to reduce Twilio costs.

**Key sections:**
- `summary`: Paragraph, bullets, action items, topics, outcome, next_best_action
- `sentiment`: Overall sentiment (positive/neutral/negative), score (0-100), confidence, key phrases
- `classification`: Primary intent, confidence, secondary intents, resolution status
- `quality`: Virtual agent and human agent quality scores (0-10 CSAT-style)

**Important**: Twilio doesn't support all JSON Schema features. See `docs/schema-design.md` for Twilio-compatible schema patterns.
