# Athena Cookbook

A practical guide to querying CIRL data with Athena. Skip this if you only use the REST API — Athena is only useful for SQL-first BI tools (Tableau, PowerBI, QuickSight, Looker, Metabase) and ad-hoc analysis.

---

## Prerequisites

Athena is **only available** when the deployment was made with `CIRL_ANALYTICS=simple` or `CIRL_ANALYTICS=lakehouse`. The default `none` mode skips all Athena infrastructure entirely. To check your deployment:

```bash
aws cloudformation describe-stacks \
  --stack-name Cirl<Env>ApiStack \
  --region <region> \
  --query 'Stacks[0].Outputs[?OutputKey==`AnalyticsMode`].OutputValue' \
  --output text
```

If the value is `none` (or the stack output doesn't exist), you'll need to redeploy with `CIRL_ANALYTICS=simple` or `lakehouse` before any of the queries below will work.

| | `simple` | `lakehouse` |
|---|---|---|
| **Where data lives** | DynamoDB (federated query) | S3 Parquet (Glue tables) |
| **Freshness** | Real-time | Depends on Glue ETL schedule |
| **Per-query cost** | Higher (Lambda invocation) | Lower (S3 scan with partition pruning) |
| **Schema** | PK/SK + JSON `payload` strings | Flat columns |
| **Catalog** | `cirl_dynamo_<env>` | `AwsDataCatalog` |
| **Database** | `default` | `cirl_<env>` |
| **Best for** | <100K conversations/month | >100K conversations/month, heavy analytics |

The Athena workgroup is `cirl-<env>` in both modes. Always run queries inside that workgroup so result location and encryption are set correctly.

---

## Opening the Athena console

1. AWS Console → Athena → **Query editor**
2. Top-right **Workgroup** picker → select `cirl-<env>`
3. Left sidebar **Data source**:
   - Simple mode: pick `cirl_dynamo_<env>`, database `default`, table `cirl-<env>`
   - Lakehouse mode: pick `AwsDataCatalog`, database `cirl_<env>`, browse `lakehouse_*` tables

Replace `<env>` with your actual environment (e.g., `inter`, `dev`).

---

## Simple mode schema (DynamoDB federated)

Single table — `cirl-<env>` — holding four entity types distinguished by `entityType`:

| `entityType` | `PK` pattern | `SK` pattern | Useful columns |
|---|---|---|---|
| `CONVERSATION` | `TENANT#<tenant>#CONV` | `TS#<YYYYMMDDHHMMSS>#CONV#<convId>` | `conversationId`, `tenantId`, `startedAt`, `createdAt`, `updatedAt`, `payload` (JSON: customerKey, channel, agentId, teamId, queueId, operatorCount) |
| `OPERATOR_RESULT` | `TENANT#<tenant>#CONV#<convId>` | `OP#<operatorName>#V#<version>#TS#<YYYYMMDDHHMMSS>` | `conversationId`, `operatorName`, `schemaVersion`, `receivedAt`, `payload` (JSON: displayFields, enrichedPayload, s3Uri) |
| `AGGREGATE` | `TENANT#<tenant>#AGG#DAY` | `DAY#<YYYYMMDD>#METRIC#<metricName>` | `metricName`, `date`, `payload` (JSON `{"value":N}`) |
| `INDEX` | `TENANT#<tenant>#IDX#<fieldName>#<value>` | `TS#<date>#CONV#<convId>` | `fieldName`, `fieldValue`, `conversationId` |

`payload` is always a JSON string — extract scalars with `json_extract_scalar(payload, '$.value')`. For nested objects use `json_extract` and chain.

---

## Lakehouse mode schema (S3 Parquet via Glue)

Three flat tables in database `cirl_<env>`. All partitioned by `tenant_id`, `year`, `month` (and `day` for the row-level tables).

### `lakehouse_conversations`
| column | type |
|---|---|
| `conversation_id` | string |
| `customer_key` | string |
| `channel` | string |
| `agent_id` / `team_id` / `queue_id` | string |
| `started_at` / `created_at` / `updated_at` | timestamp |
| `operator_count` | int |
| **partitions** | `tenant_id`, `year`, `month`, `day` |

### `lakehouse_operator_results`
| column | type |
|---|---|
| `conversation_id` | string |
| `operator_name` / `schema_version` | string |
| `received_at` / `enriched_at` | timestamp |
| `s3_uri` / `enrichment_error` | string |
| `enriched_payload` / `display_fields` | string (JSON) |
| **partitions** | `tenant_id`, `year`, `month`, `day` |

### `lakehouse_metrics`
| column | type |
|---|---|
| `date` | string (YYYYMMDD) |
| `metric_name` | string |
| `value` | double |
| **partitions** | `tenant_id`, `year`, `month` |

**Always include partition predicates** (`tenant_id`, `year`, `month`) — without them you'll scan every tenant's history and rack up cost.

---

## Cookbook

Examples below assume tenant `inter-mvp` and April 2026 data — substitute your own. Both modes shown side-by-side where useful.

### 1. All metrics for a given day

**Lakehouse:**
```sql
SELECT metric_name, value
FROM cirl_inter.lakehouse_metrics
WHERE tenant_id = 'inter-mvp'
  AND year = '2026' AND month = '04'
  AND date = '20260428'
ORDER BY metric_name;
```

**Simple:**
```sql
SELECT metricName, json_extract_scalar(payload, '$.value') AS value
FROM "cirl_dynamo_inter"."default"."cirl-inter"
WHERE PK = 'TENANT#inter-mvp#AGG#DAY'
  AND date = '20260428'
ORDER BY metricName;
```

### 2. CSAT trend over time

```sql
SELECT date, value AS csat_avg
FROM cirl_inter.lakehouse_metrics
WHERE tenant_id = 'inter-mvp'
  AND year = '2026' AND month = '04'
  AND metric_name = 'poc_csat_avg'
ORDER BY date;
```

### 3. Handoff rate breakdown by reason

```sql
SELECT
  date,
  SUM(CASE WHEN metric_name = 'poc_handoff_lack_of_comprehension_rate_percent' THEN value END) AS lack_of_comprehension_pct,
  SUM(CASE WHEN metric_name = 'poc_handoff_lack_of_knowledge_rate_percent'     THEN value END) AS lack_of_knowledge_pct,
  SUM(CASE WHEN metric_name = 'poc_handoff_customer_request_rate_percent'      THEN value END) AS customer_request_pct
FROM cirl_inter.lakehouse_metrics
WHERE tenant_id = 'inter-mvp'
  AND year = '2026' AND month = '04'
GROUP BY date
ORDER BY date;
```

### 4. Top topics in a date range

```sql
SELECT metric_name, SUM(value) AS hits
FROM cirl_inter.lakehouse_metrics
WHERE tenant_id = 'inter-mvp'
  AND year = '2026' AND month = '04'
  AND metric_name LIKE 'poc_topic_%'
GROUP BY metric_name
ORDER BY hits DESC
LIMIT 20;
```

To get subtopic granularity, swap `poc_topic_%` for `poc_subtopic_%`.

### 5. CSAT distribution

```sql
SELECT
  CAST(SUBSTR(metric_name, LENGTH('poc_csat_') + 1) AS INTEGER) AS score,
  SUM(value) AS responses
FROM cirl_inter.lakehouse_metrics
WHERE tenant_id = 'inter-mvp'
  AND year = '2026' AND month = '04'
  AND REGEXP_LIKE(metric_name, '^poc_csat_[1-5]$')
GROUP BY metric_name
ORDER BY score;
```

### 6. Conversation list with partition pruning (lakehouse only)

```sql
SELECT conversation_id, agent_id, team_id, queue_id, started_at, operator_count
FROM cirl_inter.lakehouse_conversations
WHERE tenant_id = 'inter-mvp'
  AND year = '2026' AND month = '04' AND day = '28'
ORDER BY started_at DESC
LIMIT 100;
```

### 7. Drill into operator output (e.g., extract a specific field from enriched_payload)

```sql
SELECT
  conversation_id,
  json_extract_scalar(enriched_payload, '$.handoff_reason') AS handoff_reason,
  json_extract_scalar(enriched_payload, '$.inferred_csat')  AS inferred_csat
FROM cirl_inter.lakehouse_operator_results
WHERE tenant_id = 'inter-mvp'
  AND year = '2026' AND month = '04' AND day = '28'
  AND operator_name = 'Analytics'
ORDER BY received_at DESC
LIMIT 50;
```

### 8. KPI averages, last 7 days

```sql
SELECT
  metric_name,
  AVG(value) AS avg_value
FROM cirl_inter.lakehouse_metrics
WHERE tenant_id = 'inter-mvp'
  AND year = '2026' AND month = '04'
  AND date >= '20260422'
  AND metric_name LIKE 'kpi_%_avg'
GROUP BY metric_name
ORDER BY metric_name;
```

---

## Tips

- **Always filter by partitions** in lakehouse mode — `tenant_id`, `year`, `month`, and (where relevant) `day`. Otherwise Athena scans the whole bucket.
- **Use `LIKE` and `REGEXP_LIKE`** on `metric_name` to slice by metric prefix (`poc_*`, `kpi_*`, `poc_topic_*`, etc.).
- **Discover available metric names** with: `SELECT DISTINCT metric_name FROM cirl_<env>.lakehouse_metrics WHERE tenant_id = '<id>' AND year = '<YYYY>' AND month = '<MM>'`.
- **Lakehouse data freshness** is governed by the Glue ETL schedule — confirm with `MSCK REPAIR TABLE cirl_<env>.lakehouse_metrics;` if you suspect a missing partition.
- **Simple mode is for low volume** — federated queries pay per Lambda invocation. If a query runs for >30s or you're slicing across many days, lakehouse will be cheaper and faster.

For the full list of metric names emitted by the current config, see the API at `GET /tenants/<id>/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD` — the `metricName` field on each result is exactly what you'll find in the `lakehouse_metrics.metric_name` column.
