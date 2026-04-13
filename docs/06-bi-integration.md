# BI Tool Integration Guide

CIRL provides multiple ways to connect Business Intelligence tools, making it BI-agnostic while providing native support for popular platforms.

> **Which analytics mode are you using?** CIRL supports two modes:
> - **Simple** (default, `CIRL_ANALYTICS=simple`): Athena queries DynamoDB directly. Sections marked **(Simple)** apply to you.
> - **Lakehouse** (`CIRL_ANALYTICS=lakehouse`): Athena queries S3 Parquet tables. Sections marked **(Lakehouse)** apply to you.
>
> The REST API works the same in both modes.

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐
│   DynamoDB      │     │  S3 Raw (Bronze) │
│   (Operational) │     │  JSON payloads   │
└────────┬────────┘     └────────┬─────────┘
         │                       │
         ▼                       ▼
┌────────────┐          ┌──────────────────┐
│  REST API  │          │  Glue ETL Jobs   │
│  (Lambda)  │          │  (Bronze→Silver  │
└───┬────────┘          │   Silver→Gold)   │
    │                   └────────┬─────────┘
    │                            │
    │                            ▼
    │                   ┌──────────────────┐
    │                   │  S3 Parquet +    │
    │                   │  Athena          │
    │                   │  (Glue Database) │
    │                   └────────┬─────────┘
    │                            │
    ▼                            ▼
┌────────────────────────────────────────┐
│    BI Tools                            │
│ ├─ QuickSight, Tableau, PowerBI,      │
│ │  Looker (via Athena)                │
│ └─ Grafana, Metabase (via REST API)   │
└────────────────────────────────────────┘
```
```

## Quick Start: Sample Dashboards

Ready-to-use dashboard templates are available in the [`dashboards/`](../dashboards/) directory:

- **Grafana** - Real-time dashboard using REST API ([`grafana-cirl-dashboard.json`](../dashboards/grafana-cirl-dashboard.json))
- **QuickSight** - AWS-native analytics reference ([`quicksight-cirl-dashboard.json`](../dashboards/quicksight-cirl-dashboard.json))
- **Tableau** - Athena-connected workbook ([`tableau-cirl-workbook.twb`](../dashboards/tableau-cirl-workbook.twb))
- **Metabase** - Pre-built questions collection ([`metabase-cirl-collection.json`](../dashboards/metabase-cirl-collection.json))

Each template includes:
- Pre-configured visualizations (KPIs, trends, tables, charts)
- Sample queries and filters
- Import instructions

See the [Dashboard README](../dashboards/README.md) for detailed import instructions.

---

## Connection Methods

### 1a. Athena DynamoDB Connector — Simple Mode (Default)

**Best for:** Getting started, <100K conversations/month, zero operational overhead

**How it works:**
- The official AWS DynamoDB Connector for Athena is deployed via SAR (Serverless Application Repository)
- Athena queries DynamoDB directly through a Lambda-based federated query
- No ETL, no data duplication — queries always hit live data
- Trade-off: higher per-query cost, DynamoDB PK/SK patterns require parsing

**Setup:**
Deployed automatically when `CIRL_ANALYTICS=simple` (the default).

After deployment, you'll see these outputs:
- `AthenaCatalogName`: Catalog for DynamoDB queries (e.g., `cirl_dynamo_demo`)
- `AthenaWorkgroupName`: Workgroup name (e.g., `cirl-demo`)
- `AthenaTableName`: DynamoDB table name (e.g., `cirl-demo`)

**Query Syntax:**
```sql
-- List conversations:
SELECT conversationId, tenantId, startedAt, payload
FROM "cirl_dynamo_demo"."default"."cirl-demo"
WHERE PK = 'TENANT#demo#CONV'
  AND entityType = 'CONVERSATION'
LIMIT 20;

-- Query metrics:
SELECT tenantId, date, metricName, payload
FROM "cirl_dynamo_demo"."default"."cirl-demo"
WHERE PK = 'TENANT#demo#AGG#DAY'
  AND entityType = 'AGGREGATE'
LIMIT 50;
```

**Note:** In simple mode, metrics values are stored inside the `payload` JSON column. Use `json_extract_scalar(payload, '$.value')` to extract the numeric value.

---

### 1b. Athena + Glue Lakehouse — Lakehouse Mode

**Best for:** QuickSight, Tableau, PowerBI, Looker, any SQL-based BI tool

**How it works:**
- Glue ETL jobs transform raw JSON (Bronze layer) into optimized Parquet files (Silver + Gold layers)
- Athena queries the Parquet tables via the Glue catalog
- Analytical queries are fully isolated from DynamoDB operational workload
- Three lakehouse tables available:
  - **`lakehouse_conversations`** (Silver) - Flattened conversation metadata
  - **`lakehouse_operator_results`** (Silver) - Operator results with enriched payloads
  - **`lakehouse_metrics`** (Gold) - Pre-computed daily metric rollups

**Advantages:**
- Native SQL integration with BI tools
- Cost-effective (~$5/TB scanned vs DynamoDB federation overhead)
- Fast columnar queries on Parquet
- No impact on operational DynamoDB workload
- Partitioned by tenant/date for efficient queries
- Consistent schemas for all tables (no PK/SK parsing needed)

**Setup:**
The Glue database and Athena workgroup are automatically deployed with your CIRL stack.

After deployment, you'll see these outputs:
- `GlueDatabaseName`: Glue database (e.g., `cirl_demo`)
- `AthenaWorkgroupName`: Workgroup name (e.g., `cirl-demo`)
- `CuratedBucketName`: S3 bucket with Silver layer data
- `AggregatedBucketName`: S3 bucket with Gold layer data
- `RunGlueJobsCommands`: Ready-to-run commands for ETL jobs

**Important:** After first deployment, run the Glue ETL jobs to populate the Parquet tables, then discover partitions:
```sql
MSCK REPAIR TABLE cirl_demo.lakehouse_conversations;
MSCK REPAIR TABLE cirl_demo.lakehouse_operator_results;
MSCK REPAIR TABLE cirl_demo.lakehouse_metrics;
```

**Query Syntax:**
```sql
-- Conversations (Silver layer):
SELECT conversation_id, customer_key, agent_id, started_at
FROM cirl_demo.lakehouse_conversations
WHERE tenant_id = 'demo'
  AND year = '2026' AND month = '01'

-- Metrics (Gold layer):
SELECT date, metric_name, value
FROM cirl_demo.lakehouse_metrics
WHERE tenant_id = 'demo'
  AND year = '2026' AND month = '01'

-- Operator results (Silver layer):
SELECT conversation_id, operator_name, schema_version, received_at
FROM cirl_demo.lakehouse_operator_results
WHERE tenant_id = 'demo'
  AND year = '2026' AND month = '01'
```

### 2. REST API (For real-time dashboards)

**Best for:** Grafana, Metabase, custom dashboards

**Advantages:**
- Real-time data access
- Pre-computed aggregations
- Simple REST interface
- No AWS credentials needed in BI tool

**API Endpoints:**
See [API Reference](./04-api-reference.md) for complete endpoint documentation.

---

## QuickSight Setup

### Prerequisites
1. CIRL stack deployed
2. QuickSight account in the same AWS region
3. QuickSight principal with Athena permissions

### Step 1: Configure QuickSight Permissions

1. Go to QuickSight console
2. Click on your user icon (top right) → **Manage QuickSight**
3. Under **Permissions**, click **AWS resources**
4. Enable:
   - **Amazon Athena** ✓
   - **Amazon S3** ✓ (select the Athena results bucket `cirl-athena-{env}-...`)
   - **(Simple mode only)**: QuickSight also needs `lambda:InvokeFunction` permission for the DynamoDB connector Lambda. Run:
     ```bash
     aws iam put-role-policy \
       --role-name aws-quicksight-service-role-v0 \
       --policy-name CIRLLambdaInvokeAccess \
       --policy-document '{
         "Version": "2012-10-17",
         "Statement": [{
           "Effect": "Allow",
           "Action": "lambda:InvokeFunction",
           "Resource": "arn:aws:lambda:*:*:function:cirl_dynamo_*"
         }]
       }'
     ```
   - **(Lakehouse mode only)**: Also enable S3 access for the curated bucket `cirl-curated-{env}-...` and aggregated bucket `cirl-aggregated-{env}-...`

### Step 2: Create Athena Data Source

1. In QuickSight, go to **Datasets**
2. Click **New dataset**
3. Select **Athena**
4. Configure:
   - **Data source name**: `CIRL-{env}` (e.g., `CIRL-Demo`)
   - **Athena workgroup**: `cirl-{env}`
5. Click **Create data source**

### Step 3: Select Data Catalog and Table

#### Simple Mode:
1. After creating the data source, you'll be prompted to select data
2. **Catalog**: Select `cirl_dynamo_{env}` (e.g., `cirl_dynamo_demo`)
3. **Database**: Select `default`
4. **Table**: Select `cirl-{env}` (e.g., `cirl-demo`)
5. Choose **Use custom SQL** — the single-table design requires filtering by entity type
6. **Import mode**: "Directly query your data" (always shows live DynamoDB data)

#### Lakehouse Mode:
1. After creating the data source, you'll be prompted to select data
2. **Catalog**: Select `AwsDataCatalog`
3. **Database**: Select `cirl_{env}` (e.g., `cirl_demo`)
4. **Table**: Select a lakehouse table:
   - `lakehouse_metrics` — best starting point for dashboards
   - `lakehouse_conversations` — conversation-level analysis
   - `lakehouse_operator_results` — operator drill-down
5. **Import mode**: "Directly query your data" or "Import to SPICE"

### Step 4: Write Queries

#### Simple Mode Queries

Simple mode queries the DynamoDB single table. Use `entityType` to filter by record type:

```sql
-- Conversations:
SELECT conversationId, tenantId, startedAt, payload
FROM "cirl_dynamo_demo"."default"."cirl-demo"
WHERE PK = 'TENANT#demo#CONV'
  AND entityType = 'CONVERSATION'

-- Metrics:
SELECT tenantId, date, metricName,
       json_extract_scalar(payload, '$.value') as value
FROM "cirl_dynamo_demo"."default"."cirl-demo"
WHERE PK = 'TENANT#demo#AGG#DAY'
  AND entityType = 'AGGREGATE'
```

**Note:** In simple mode, the `payload` column is a JSON string (spine + payload pattern). Use `json_extract_scalar()` to extract fields.

#### Lakehouse Mode Queries

All tables have clean, flat schemas — no PK/SK parsing or `regexp_extract` needed.

#### Example: Metrics Query

```sql
SELECT
  date,
  metric_name,
  value
FROM cirl_demo.lakehouse_metrics
WHERE tenant_id = 'demo'
  AND year = '2026'
  AND month = '01'
ORDER BY date, metric_name
```

#### Example: Conversations Query

```sql
SELECT
  conversation_id,
  customer_key,
  agent_id,
  channel,
  started_at,
  operator_count
FROM cirl_demo.lakehouse_conversations
WHERE tenant_id = 'demo'
  AND year = '2026' AND month = '01'
ORDER BY started_at DESC
LIMIT 100
```

#### Example: Operator Results Query

```sql
SELECT
  conversation_id,
  operator_name,
  schema_version,
  received_at,
  enriched_payload
FROM cirl_demo.lakehouse_operator_results
WHERE tenant_id = 'demo'
  AND year = '2026' AND month = '01'
  AND operator_name = 'conversation-intelligence'
```

**Note:** Replace `cirl_demo` with your Glue database name (`cirl_{env}`).

### Step 5: Create Visualizations

Now you can create analyses and dashboards using your datasets.

**Recommended Visuals:**
- **Line chart**: Metrics over time (sentiment_avg, quality scores)
- **Bar chart**: Operator usage counts, intent distribution
- **KPI cards**: Average sentiment, transfer rate, CSAT scores
- **Heat map**: Conversation volume by hour/day
- **Table**: Recent conversations with key metrics

---

## Tableau Setup

### Athena Connector

1. Install the [Amazon Athena Connector](https://www.tableau.com/support/drivers) for Tableau
2. In Tableau, click **Connect** → **To a Server** → **Amazon Athena**
3. Configure:
   - **Server**: `athena.{region}.amazonaws.com` (e.g., `athena.us-east-1.amazonaws.com`)
   - **Port**: 443
   - **S3 Staging Directory**: `s3://cirl-athena-{env}-{account}-{region}/results/`
   - **Workgroup**: `cirl-{env}`
   - **Authentication**: IAM credentials or IAM role
4. Select database `cirl_{env}` and browse lakehouse tables, or use Custom SQL:

```sql
SELECT date, metric_name, value
FROM cirl_demo.lakehouse_metrics
WHERE tenant_id = 'demo'
  AND year = '2026'
ORDER BY date
```

---

## PowerBI Setup

### Athena via ODBC

1. Install [Amazon Athena ODBC Driver](https://docs.aws.amazon.com/athena/latest/ug/connect-with-odbc.html)
2. Configure ODBC data source:
   - **Data Source Name**: CIRL
   - **Athena Server**: `athena.{region}.amazonaws.com`
   - **S3 Output Location**: `s3://cirl-athena-{env}-{account}-{region}/results/`
   - **Workgroup**: `cirl-{env}`
3. In PowerBI Desktop, click **Get Data** → **ODBC**
4. Select your CIRL data source, database `cirl_{env}`
5. Browse lakehouse tables or use Custom SQL (same as Tableau examples above)

---

## Looker Setup

1. In Looker, add a new database connection
2. Select **Amazon Athena**
3. Configure:
   - **Database**: Leave empty (using catalog-based queries)
   - **Region**: Your AWS region
   - **S3 Staging Dir**: `s3://cirl-athena-{env}-{account}-{region}/results/`
   - **Workgroup**: `cirl-{env}`
   - **Authentication**: IAM credentials
4. Create LookML views using federated query syntax

---

## Metabase Setup

Metabase supports both Athena and REST APIs.

### Option 1: Athena

1. Add a new database in Metabase
2. Select **Amazon Athena**
3. Configure connection details
4. Use Custom SQL with federated query syntax

### Option 2: REST API (Recommended for Metabase)

1. Create questions using Metabase's native query interface
2. Use the API endpoints directly with Metabase's database as a REST source
3. This provides real-time data and pre-computed aggregations

---

## Grafana Setup

Grafana works best with the REST API approach.

### Using Infinity Data Source

1. Install the [Infinity data source plugin](https://grafana.com/grafana/plugins/yesoreyeram-infinity-datasource/)
2. Configure a new Infinity data source:
   - **URL**: Your API Gateway URL
   - **Authentication**: API Key or IAM
3. Create dashboards using the CIRL API endpoints:
   - `/tenants/{tenantId}/metrics`
   - `/tenants/{tenantId}/conversations`

**Example JSON Panel:**
```json
{
  "datasource": "Infinity",
  "targets": [
    {
      "type": "json",
      "url": "${API_URL}/tenants/${tenant_id}/metrics?startDate=${__from:date:YYYY-MM-DD}&endDate=${__to:date:YYYY-MM-DD}",
      "method": "GET"
    }
  ]
}
```

---

## Understanding the Lakehouse Schema

CIRL uses a **lakehouse architecture** with S3 Parquet tables for BI queries. All tables have clean, flat schemas — no PK/SK parsing needed.

### `lakehouse_metrics` (Gold Layer)

Pre-computed daily metric rollups. Best starting point for dashboards.

| Column | Type | Description |
|--------|------|-------------|
| `date` | string | Date in YYYYMMDD format |
| `metric_name` | string | Metric identifier (e.g., `sentiment_avg`) |
| `value` | double | Metric value |
| `tenant_id` | string | Partition key |
| `year`, `month` | string | Partition keys for query performance |

```sql
SELECT date, metric_name, value
FROM cirl_demo.lakehouse_metrics
WHERE tenant_id = 'demo'
  AND year = '2026' AND month = '01'
ORDER BY date
```

### `lakehouse_conversations` (Silver Layer)

Flattened conversation metadata.

| Column | Type | Description |
|--------|------|-------------|
| `conversation_id` | string | Unique conversation identifier |
| `customer_key` | string | Customer identifier |
| `channel` | string | Communication channel |
| `agent_id` | string | Agent identifier |
| `team_id` | string | Team identifier |
| `queue_id` | string | Queue identifier |
| `started_at` | timestamp | Conversation start time |
| `operator_count` | int | Number of operators executed |
| `tenant_id` | string | Partition key |
| `year`, `month`, `day` | string | Partition keys |

### `lakehouse_operator_results` (Silver Layer)

Flattened operator results with enriched payloads.

| Column | Type | Description |
|--------|------|-------------|
| `conversation_id` | string | Parent conversation |
| `operator_name` | string | Operator identifier |
| `schema_version` | string | Schema version used |
| `received_at` | timestamp | When result was received |
| `enriched_payload` | string | JSON string with full operator output |
| `display_fields` | string | JSON string with summary fields |
| `tenant_id` | string | Partition key |
| `year`, `month`, `day` | string | Partition keys |

---

## Sample Queries

### Top 10 Customers by Conversation Volume

```sql
SELECT
  customer_key,
  COUNT(*) as conversation_count
FROM cirl_demo.lakehouse_conversations
WHERE tenant_id = 'demo'
GROUP BY customer_key
ORDER BY conversation_count DESC
LIMIT 10
```

### Daily Sentiment Trend

```sql
SELECT
  date,
  value as avg_sentiment
FROM cirl_demo.lakehouse_metrics
WHERE tenant_id = 'demo'
  AND metric_name = 'sentiment_avg'
  AND year = '2026'
ORDER BY date
```

### Operator Performance

```sql
SELECT
  operator_name,
  COUNT(*) as execution_count
FROM cirl_demo.lakehouse_operator_results
WHERE tenant_id = 'demo'
GROUP BY operator_name
ORDER BY execution_count DESC
```

---

## Cost Considerations

### Athena Lakehouse Query Pricing
- $5 per TB of data scanned (Parquet is columnar — only requested columns are read)
- Glue ETL: ~$0.44 per DPU-hour (2 DPU minimum, jobs typically run < 5 min)
- S3 storage: ~$0.023/GB/month (with lifecycle to IA/Glacier)
- Use partition filters (`tenant_id`, `year`, `month`, `day`) to reduce scanned data

### API Pricing
- API Gateway requests: $3.50 per million requests
- Lambda invocations: $0.20 per million requests
- DynamoDB reads: Included in PAY_PER_REQUEST pricing

**Recommendation:** Use Athena for historical analysis and the API for real-time dashboards.

---

## Security Best Practices

1. **QuickSight**: Use IAM roles with least-privilege access to Athena, Glue, and S3 (curated + aggregated + results buckets)
2. **Tableau/PowerBI/Looker**: Use IAM credentials with read-only Athena, Glue, and S3 permissions
3. **API-based tools**: Use API keys with tenant-level isolation
4. **Multi-tenancy**: Always filter queries by tenant_id in PK
5. **Data masking**: Consider AWS Lake Formation for column-level security

---

## Troubleshooting

### QuickSight can't connect to Athena
- Verify QuickSight has access to the Athena workgroup `cirl-{env}`
- Ensure QuickSight has S3 read permissions for the curated, aggregated, and Athena results buckets
- Check Glue database `cirl_{env}` exists in the correct region

### No data in lakehouse tables
- Run the Glue ETL jobs first (see `RunGlueJobsCommands` CDK output)
- After running ETL, discover partitions: `MSCK REPAIR TABLE cirl_demo.lakehouse_conversations;`
- Verify raw data exists in the Bronze layer S3 bucket

### Slow query performance
- Use partition filters: `WHERE tenant_id = 'demo' AND year = '2026' AND month = '01'`
- Select only needed columns (Parquet is columnar — fewer columns = less data scanned)
- Query Gold layer (`lakehouse_metrics`) instead of Silver for pre-aggregated data
- Consider the REST API for real-time operational queries

### Empty results
- Verify Glue ETL jobs have run successfully (check Glue console or CloudWatch logs)
- Check partition discovery: `MSCK REPAIR TABLE cirl_demo.lakehouse_metrics;`
- Ensure raw data exists in S3 Bronze layer

### Authentication errors
- For Athena: Verify IAM credentials have `athena:*`, `glue:Get*`, and `s3:GetObject` permissions
- For API: Check API key is valid and has correct tenant access
- Check CloudWatch logs for Glue job errors

---

## Next Steps

- [API Reference](./04-api-reference.md) - Complete API documentation
- [Metrics Catalog](./05-metrics-catalog.md) - Available metrics
- [Dashboard Templates](../dashboards/README.md) - Pre-built BI dashboards
