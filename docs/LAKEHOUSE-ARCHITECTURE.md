# CIRL Lakehouse Architecture

## Overview

CIRL uses a **modern data lakehouse architecture** that separates operational workloads (DynamoDB + API) from analytical workloads (S3 Parquet + Athena), providing the best of both worlds:

- ✅ **Fast operational APIs** (DynamoDB) for Grafana and real-time dashboards
- ✅ **Cost-effective analytical queries** (S3 + Athena) for QuickSight, Tableau, PowerBI
- ✅ **Scalable** - Handles petabytes of data
- ✅ **Reprocessable** - Can backfill historical data easily
- ✅ **Industry standard** - AWS recommended lakehouse pattern

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         INGESTION LAYER                                  │
│                                                                           │
│  Twilio CI Webhook                                                       │
│         ↓                                                                 │
│  [Ingest Lambda]                                                         │
│         ├─→ S3 Raw (Bronze - JSON, append-only)                         │
│         └─→ EventBridge event                                            │
│                   ↓                                                       │
│  [Processor Lambda]                                                      │
│         └─→ DynamoDB (operational - conversations, operators)            │
└───────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                          ETL LAYER (Glue)                                │
│                                                                           │
│  EventBridge Schedule (daily/hourly)                                     │
│         ↓                                                                 │
│  [Glue Job: Curated Layer]                                              │
│         ├─ Read: S3 Raw (JSON)                                          │
│         ├─ Transform: Flatten nested structures                         │
│         └─ Write: S3 Curated (Silver - Parquet, partitioned)           │
│                   ↓                                                       │
│  [Glue Job: Aggregated Metrics]                                         │
│         ├─ Read: S3 Curated (Parquet)                                   │
│         ├─ Compute: Daily rollups, aggregations                         │
│         └─ Write:                                                        │
│              ├─→ S3 Aggregated (Gold - Parquet) → Athena → BI Tools    │
│              └─→ DynamoDB (metrics for API) → Grafana                   │
└───────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                         CONSUMPTION LAYER                                │
│                                                                           │
│  ┌──────────────────────┐           ┌───────────────────────┐          │
│  │   Operational Path    │           │   Analytical Path      │          │
│  │                       │           │                        │          │
│  │  DynamoDB             │           │  S3 Parquet           │          │
│  │    ↓                  │           │    ↓                   │          │
│  │  API (Lambda)         │           │  Athena               │          │
│  │    ↓                  │           │    ↓                   │          │
│  │  Grafana              │           │  QuickSight           │          │
│  │  Metabase             │           │  Tableau              │          │
│  │  Custom Dashboards    │           │  PowerBI              │          │
│  └──────────────────────┘           │  Looker               │          │
│                                      └───────────────────────┘          │
└───────────────────────────────────────────────────────────────────────────┘
```

## Data Layers

### Bronze Layer: Raw Data (S3)

**Storage**: `s3://cirl-raw-{env}-{account}-{region}/`

**Format**: JSON (append-only)

**Structure**:
```
s3://cirl-raw-{env}-{account}-{region}/
  ├─ {tenant_id}/
  │  └─ {conversation_id}/
  │     └─ {timestamp}.json
```

**Characteristics**:
- Immutable (never modified)
- Complete CI payloads as received from Twilio
- Lifecycle: Transition to IA after 90 days, Glacier after 365 days
- Retention: Permanent (for regulatory compliance, reprocessing)

**Purpose**:
- Audit trail
- Data lineage
- Reprocessing capability

### Silver Layer: Curated Data (S3 Parquet)

**Storage**: `s3://cirl-curated-{env}-{account}-{region}/`

**Format**: Parquet (columnar, compressed with Snappy)

**Structure**:
```
s3://cirl-curated-{env}-{account}-{region}/
  ├─ conversations/
  │  └─ tenant_id={tenant}/year={yyyy}/month={mm}/day={dd}/
  │     └─ part-*.parquet
  ├─ operator_results/
  │  └─ tenant_id={tenant}/year={yyyy}/month={mm}/day={dd}/
  │     └─ part-*.parquet
```

**Tables**:

1. **`conversations`** - Flattened conversation metadata
   - `conversation_id`, `tenant_id`, `customer_key`, `channel`
   - `agent_id`, `team_id`, `queue_id`
   - `started_at`, `created_at`, `updated_at`, `operator_count`
   - Partitioned by: `tenant_id`, `year`, `month`, `day`

2. **`operator_results`** - Flattened operator results
   - `conversation_id`, `tenant_id`, `operator_name`, `schema_version`
   - `received_at`, `s3_uri`, `enriched_at`, `enrichment_error`
   - `enriched_payload` (JSON string for complex nested data)
   - `display_fields` (JSON string)
   - Partitioned by: `tenant_id`, `year`, `month`, `day`

**Characteristics**:
- Flattened schema (no nested JSON in columns)
- Optimized for analytical queries
- Partitioned for query performance
- Lifecycle: Transition to IA after 90 days

**Purpose**:
- Detailed analytical queries
- Ad-hoc exploration in Athena
- Base for aggregations

### Gold Layer: Aggregated Metrics (S3 Parquet + DynamoDB)

**Storage**: `s3://cirl-aggregated-{env}-{account}-{region}/`

**Format**: Parquet (columnar, compressed)

**Structure**:
```
s3://cirl-aggregated-{env}-{account}-{region}/
  ├─ metrics/
  │  └─ tenant_id={tenant}/year={yyyy}/month={mm}/
  │     └─ part-*.parquet
```

**Table**:

**`metrics`** - Pre-computed daily rollups
- `tenant_id`, `date` (YYYYMMDD), `metric_name`, `value`
- Partitioned by: `tenant_id`, `year`, `month`

**Metrics computed**:
- `conversation_count` - Total conversations per day
- `operator_{name}_count` - Operator execution counts
- `sentiment_*` - Sentiment aggregates (sum, count, avg)
- `intent_*` - Intent classification metrics
- `quality_*` - Quality scores (virtual/human agent)
- `transfer_rate_percent` - Transfer rates
- See [Metrics Catalog](./05-metrics-catalog.md) for complete list

**Characteristics**:
- Pre-aggregated for fast queries
- Small data volume (< 1% of raw)
- **Dual-write**: Both S3 Parquet (for BI) and DynamoDB (for API)

**Purpose**:
- Fast dashboard queries
- Historical trend analysis
- KPI tracking

## Why This Architecture?

### Problems with DynamoDB Federation + Athena

❌ **Expensive**: Every BI query invokes Lambda + scans DynamoDB (RCUs)
❌ **Slow**: Lambda connector overhead + DynamoDB not optimized for scans
❌ **Not scalable**: Complex analytical queries (joins, window functions) are painful
❌ **Impacts operational workload**: BI queries consume DynamoDB capacity
❌ **Limited capabilities**: Can't do time travel, schema evolution is hard

### Benefits of Lakehouse Architecture

✅ **Cost-effective**: Athena on S3 is ~$5/TB vs federation overhead
✅ **Fast**: Parquet is columnar, compressed, partitioned
✅ **Scalable**: S3 + Athena handles petabytes easily
✅ **Separation**: Analytical queries don't affect operational APIs
✅ **Reprocessing**: Can backfill historical data easily
✅ **Standard pattern**: AWS recommended lakehouse architecture

## ETL Jobs

### 1. Curated Layer Job (Bronze → Silver)

**Script**: [`infra/glue-jobs/curated_layer_job.py`](../infra/glue-jobs/curated_layer_job.py)

**Frequency**: Hourly or daily

**What it does**:
1. Reads raw JSON files from S3 Bronze layer
2. Flattens nested structures (metadata, enrichedPayload, etc.)
3. Converts to Parquet format with proper schema
4. Partitions by `tenant_id/year/month/day`
5. Writes to S3 Silver layer

**Input**: `s3://cirl-raw-{env}-*/` (JSON)
**Output**: `s3://cirl-curated-{env}-*/conversations/` and `operator_results/` (Parquet)

**Performance**: Processes ~10K files in < 5 minutes with 2 workers

### 2. Aggregated Metrics Job (Silver → Gold + DynamoDB)

**Script**: [`infra/glue-jobs/aggregated_metrics_job.py`](../infra/glue-jobs/aggregated_metrics_job.py)

**Frequency**: Daily (after curated layer job completes)

**What it does**:
1. Reads curated Parquet files from S3 Silver layer
2. Computes daily rollup metrics (counts, sums, averages)
3. Writes to S3 Gold layer (Parquet)
4. **Also writes to DynamoDB** for fast API reads

**Input**: `s3://cirl-curated-{env}-*/operator_results/` (Parquet)
**Output**:
- `s3://cirl-aggregated-{env}-*/metrics/` (Parquet)
- DynamoDB table `cirl-{env}` (metrics with `entityType=AGGREGATE`)

**Performance**: Processes 1 day of data (100K records) in < 2 minutes

## Data Flow

### Operational Path (Real-time)

```
Twilio Webhook
  → Ingest Lambda
    → DynamoDB (conversations, operators)
      → API
        → Grafana (real-time dashboards)
```

**Latency**: < 1 second
**Use case**: Real-time monitoring, alerts, operational dashboards

### Analytical Path (Batch)

```
Twilio Webhook
  → Ingest Lambda
    → S3 Raw (Bronze)
      → Glue Curated Job (hourly/daily)
        → S3 Curated (Silver)
          → Athena
            → QuickSight/Tableau (historical analysis)

S3 Curated (Silver)
  → Glue Aggregated Job (daily)
    → S3 Aggregated (Gold)
      → Athena
        → QuickSight/Tableau (metrics dashboards)
```

**Latency**: Hours (depends on ETL schedule)
**Use case**: Historical analysis, trend reports, executive dashboards

### Hybrid Path (Metrics)

```
S3 Curated (Silver)
  → Glue Aggregated Job (daily)
    ├→ S3 Aggregated (Gold) → Athena → BI Tools
    └→ DynamoDB → API → Grafana (pre-computed metrics)
```

**Latency**: Daily refresh
**Use case**: Fast metrics queries with historical context

## Athena Queries

### Query Curated Conversations

```sql
SELECT
  conversation_id,
  customer_key,
  channel,
  agent_id,
  started_at
FROM cirl_demo.lakehouse_conversations
WHERE tenant_id = 'demo'
  AND year = '2026'
  AND month = '01'
  AND day >= '20'
ORDER BY started_at DESC
LIMIT 100;
```

### Query Aggregated Metrics

```sql
SELECT
  date,
  metric_name,
  value
FROM cirl_demo.lakehouse_metrics
WHERE tenant_id = 'demo'
  AND year = '2026'
  AND month = '01'
  AND metric_name LIKE 'sentiment_%'
ORDER BY date, metric_name;
```

### Time-Series Analysis

```sql
SELECT
  date,
  SUM(CASE WHEN metric_name = 'conversation_count' THEN value ELSE 0 END) AS conversations,
  AVG(CASE WHEN metric_name = 'sentiment_avg' THEN value ELSE NULL END) AS avg_sentiment,
  AVG(CASE WHEN metric_name = 'transfer_rate_percent' THEN value ELSE NULL END) AS transfer_rate
FROM cirl_demo.lakehouse_metrics
WHERE tenant_id = 'demo'
  AND year = '2026'
  AND month = '01'
GROUP BY date
ORDER BY date;
```

## Cost Optimization

### S3 Storage Costs

| Layer | Size (1M conversations) | Monthly Cost |
|-------|-------------------------|--------------|
| Bronze (JSON) | ~500 GB | $11.50 |
| Silver (Parquet) | ~50 GB | $1.15 |
| Gold (Parquet) | ~1 GB | $0.02 |
| **Total** | ~551 GB | **$12.67** |

*Note: With lifecycle policies transitioning to IA/Glacier, costs drop significantly after 90 days*

### Athena Query Costs

**Pricing**: $5 per TB of data scanned

**Example queries**:
- "Last 30 days metrics" (partitioned): Scans ~100 MB = $0.0005
- "Year-over-year analysis": Scans ~4 GB = $0.02
- "Full conversation export": Scans ~50 GB = $0.25

**Cost reduction**:
- Use partition pruning (`WHERE year = '2026' AND month = '01'`)
- Query Gold layer (pre-aggregated) instead of Silver
- Use column projection (`SELECT specific_columns` instead of `SELECT *`)

### DynamoDB Costs

**Pricing**: $1.25 per million write requests, $0.25 per million read requests

**Metrics writes** (from Glue job):
- 100 metrics/day/tenant = ~$0.004/month/tenant
- 1,000 tenants = ~$4/month

**API reads**:
- 1M reads/month = $0.25

**Total DynamoDB cost**: ~$5/month for 1,000 tenants

### Total Monthly Cost Estimate

| Component | Cost |
|-----------|------|
| S3 storage (1M conversations) | $13 |
| Athena queries (100 queries/day) | $1 |
| Glue ETL (2 jobs/day) | $5 |
| DynamoDB (1,000 tenants) | $5 |
| **Total** | **$24/month** |

*Compare to DynamoDB Federation approach: ~$100+/month for the same workload*

## Monitoring

### CloudWatch Dashboards

Create dashboards to monitor:
- Glue job run duration and success rate
- S3 bucket sizes and growth rate
- Athena query performance and costs
- DynamoDB read/write capacity

### Alarms

Recommended alarms:
- Glue job failure rate > 10%
- Glue job duration > 30 minutes
- Athena query failure rate > 5%
- DynamoDB write throttling
- S3 bucket size > 1 TB (review lifecycle policies)

## See Also

- [Glue Jobs README](../infra/glue-jobs/README.md) - ETL job details
- [BI Integration Guide](./bi-integration.md) - Connecting BI tools to Athena
- [Metrics Catalog](./05-metrics-catalog.md) - Available metrics
- [Blueprint](./blueprint.md) - Overall architecture
