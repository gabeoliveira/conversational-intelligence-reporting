# BI Tool Integration Guide

CIRL provides two integration paths for connecting Business Intelligence tools. Which path you use depends on your BI tool — not on a preference.

## Which Path for Your BI Tool?

| BI Tool | Connection Path | Analytics Mode Required |
|---|---|---|
| **Grafana** | REST API (Infinity plugin) | `none` or higher |
| **Metabase** | REST API (native JSON source) or Athena | `none` (REST) or `simple`/`lakehouse` (Athena) |
| **PowerBI** | Athena (ODBC driver) | `simple` or `lakehouse` |
| **QuickSight** | Athena (native) | `simple` or `lakehouse` |
| **Tableau** | Athena (connector) | `simple` or `lakehouse` |
| **Looker** | Athena (database connection) | `simple` or `lakehouse` |

> **Note:** QuickSight, Tableau, and Looker are SQL-first tools — they **cannot** connect to a REST API directly. They require Athena, which means you need `CIRL_ANALYTICS=simple` or `CIRL_ANALYTICS=lakehouse`.
>
> Grafana and Metabase work with the REST API, so `CIRL_ANALYTICS=none` (the default) is sufficient.

---

## Quick Start: Sample Dashboards

Ready-to-use dashboard templates are available in [`dashboards/`](../dashboards/):

- **Grafana** — Real-time dashboard via REST API ([`grafana-cirl-dashboard.json`](../dashboards/grafana-cirl-dashboard.json))
- **Grafana POC** — AI Virtual Agent analytics ([`grafana-poc-dashboard.json`](../dashboards/grafana-poc-dashboard.json))
- **QuickSight** — AWS-native analytics reference ([`quicksight-cirl-dashboard.json`](../dashboards/quicksight-cirl-dashboard.json))
- **Tableau** — Athena-connected workbook ([`tableau-cirl-workbook.twb`](../dashboards/tableau-cirl-workbook.twb))
- **Metabase** — Pre-built questions collection ([`metabase-cirl-collection.json`](../dashboards/metabase-cirl-collection.json))
- **PowerBI** — Step-by-step setup guide ([`powerbi-setup-guide.md`](../dashboards/powerbi-setup-guide.md))

See [dashboards/README.md](../dashboards/README.md) for import instructions.

---

## Path 1: REST API (Grafana, Metabase)

Works with all analytics modes (`none`, `simple`, `lakehouse`). No AWS credentials needed in the BI tool.

### Prerequisites

1. **API URL**: Your deployed CIRL API endpoint (from CDK output `ApiUrl`)
2. **Tenant ID**: Your tenant identifier
3. **No authentication required** (planned — see Roadmap in README)

### API Endpoints

| Endpoint | Description |
|---|---|
| `GET /tenants/{tenantId}/metrics?from=&to=&metric=` | Aggregated metrics (supports derived metrics like `avg_handling_time_sec`) |
| `GET /tenants/{tenantId}/conversations?from=&to=&agentId=&queueId=&customerKey=` | Conversation list with filters |
| `GET /tenants/{tenantId}/conversations/{conversationId}` | Single conversation with operator results |

> **Note:** The response includes both `metricName` (internal, e.g., `poc_topic_atendimento`) and `displayName` (friendly, e.g., `Atendimento`). The `metric` filter parameter uses internal names. Use `displayName` for chart labels and `metricName` for filtering.

### Grafana Setup

1. Install the [Infinity data source plugin](https://grafana.com/grafana/plugins/yesoreyeram-infinity-datasource/)
2. Configure a new Infinity data source:
   - **Base URL**: Your API Gateway URL (e.g., `https://xxx.execute-api.us-east-1.amazonaws.com/v1`)
3. Create panels with:
   - **Type**: JSON
   - **Source**: URL
   - **Method**: GET
   - **URL**: `/tenants/{tenantId}/metrics?from=${__from:date:YYYY-MM-DD}&to=${__to:date:YYYY-MM-DD}&metric=conversation_count`
   - **Parser**: JSONata
   - **Rows/Root**: `metrics`
4. Set **Fields** to `value` in the Stat panel options

See [`grafana-poc-dashboard.json`](../dashboards/grafana-poc-dashboard.json) for a working example with AI analytics metrics.

### Metabase Setup (REST API)

1. Add a new data source of type **JSON API**
2. Configure:
   - **URL**: Your API Gateway URL
3. Create questions pointing to the metrics and conversations endpoints

---

## Path 2: Athena (QuickSight, Tableau, PowerBI, Looker)

Requires `CIRL_ANALYTICS=simple` or `CIRL_ANALYTICS=lakehouse`.

### Simple Mode vs. Lakehouse Mode

**Simple** (`CIRL_ANALYTICS=simple`):
- Athena queries DynamoDB directly via federated query (Lambda connector)
- Always real-time — queries hit live data
- Trade-off: higher per-query cost, PK/SK patterns require parsing
- QuickSight needs `lambda:InvokeFunction` permission

**Lakehouse** (`CIRL_ANALYTICS=lakehouse`):
- Athena queries S3 Parquet tables (Glue ETL transforms raw data)
- Clean flat schemas — no PK/SK parsing needed
- Trade-off: data freshness depends on ETL schedule
- Best for heavy analytics and >100K conversations/month

### QuickSight Setup

#### Step 1: Configure Permissions

1. QuickSight → **Manage QuickSight** → **Permissions** → **AWS resources**
2. Enable **Amazon Athena** and **Amazon S3** (select Athena results bucket)
3. **(Simple mode only)**: Grant Lambda invoke permission:
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
4. **(Lakehouse mode only)**: Also enable S3 access for curated and aggregated buckets

#### Step 2: Create Data Source

1. **Datasets** → **New dataset** → **Athena**
2. **Data source name**: `CIRL-{env}`
3. **Athena workgroup**: `cirl-{env}`

#### Step 3: Select Data

**Simple Mode:**
- **Catalog**: `cirl_dynamo_{env}` → **Database**: `default` → **Table**: `cirl-{env}`
- Use **Custom SQL** to filter by entity type

**Lakehouse Mode:**
- **Catalog**: `AwsDataCatalog` → **Database**: `cirl_{env}`
- **Tables**: `lakehouse_metrics`, `lakehouse_conversations`, `lakehouse_operator_results`

#### Step 4: Sample Queries

**Simple Mode:**
```sql
SELECT tenantId, date, metricName,
       json_extract_scalar(payload, '$.value') as value
FROM "cirl_dynamo_demo"."default"."cirl-demo"
WHERE PK = 'TENANT#demo#AGG#DAY'
  AND entityType = 'AGGREGATE'
```

**Lakehouse Mode:**
```sql
SELECT date, metric_name, value
FROM cirl_demo.lakehouse_metrics
WHERE tenant_id = 'demo'
  AND year = '2026' AND month = '01'
ORDER BY date
```

### Tableau Setup

1. Install the [Amazon Athena Connector](https://www.tableau.com/support/drivers)
2. **Connect** → **To a Server** → **Amazon Athena**
3. Configure:
   - **Server**: `athena.{region}.amazonaws.com`
   - **Port**: 443
   - **S3 Staging Directory**: `s3://cirl-athena-{env}-{account}-{region}/results/`
   - **Workgroup**: `cirl-{env}`
4. Select database `cirl_{env}` and browse lakehouse tables, or use Custom SQL

### PowerBI Setup

1. Install [Amazon Athena ODBC Driver](https://docs.aws.amazon.com/athena/latest/ug/connect-with-odbc.html)
2. Configure ODBC data source with Athena server, S3 output location, and workgroup
3. In PowerBI Desktop: **Get Data** → **ODBC** → select your data source
4. Browse lakehouse tables or use Custom SQL

See [powerbi-setup-guide.md](../dashboards/powerbi-setup-guide.md) for complete step-by-step instructions with DAX measures and visual specifications.

### Looker Setup

1. Add a new database connection → **Amazon Athena**
2. Configure region, S3 staging directory, workgroup, IAM credentials
3. Create LookML views against lakehouse tables

### Metabase Setup (Athena)

1. **Admin** → **Databases** → **Add database** → **Amazon Athena**
2. Configure region, S3 staging directory, workgroup
3. Browse lakehouse tables or create custom questions with SQL

---

## Lakehouse Table Schemas

Available when `CIRL_ANALYTICS=lakehouse`. All tables have clean, flat schemas.

### `lakehouse_metrics` (Gold Layer)

| Column | Type | Description |
|--------|------|-------------|
| `date` | string | ISO 8601 date |
| `metric_name` | string | Metric identifier |
| `value` | double | Metric value |
| `tenant_id` | string | Partition key |
| `year`, `month` | string | Partition keys |

### `lakehouse_conversations` (Silver Layer)

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
| `tenant_id`, `year`, `month`, `day` | string | Partition keys |

### `lakehouse_operator_results` (Silver Layer)

| Column | Type | Description |
|--------|------|-------------|
| `conversation_id` | string | Parent conversation |
| `operator_name` | string | Operator identifier |
| `schema_version` | string | Schema version used |
| `received_at` | timestamp | When result was received |
| `enriched_payload` | string | JSON string with full operator output |
| `display_fields` | string | JSON string with summary fields |
| `tenant_id`, `year`, `month`, `day` | string | Partition keys |

---

## Metrics Catalog

### Core Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `conversation_count` | Counter | Total conversations processed |
| `operator_{name}_count` | Counter | Per-operator execution count |

### Timing Metrics (from Transcript Sentences)

| Metric Name | Type | Description |
|-------------|------|-------------|
| `handling_time_sum` / `_count` | Sum/Counter | For computing average |
| `avg_handling_time_sec` | Computed | Average conversation duration (seconds) |
| `response_time_sum` / `_count` | Sum/Counter | For computing average |
| `avg_response_time_sec` | Computed | Average agent response time (seconds) |
| `customer_wait_time_sum` / `_count` | Sum/Counter | For computing average |
| `avg_customer_wait_time_sec` | Computed | Average customer wait time (seconds) |
| `sentence_count_total` | Counter | Total transcript sentences |
| `agent_sentence_count` | Counter | Agent sentences |
| `customer_sentence_count` | Counter | Customer sentences |

### Sentiment Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `sentiment_positive` / `_negative` / `_neutral` | Counter | Count per sentiment |
| `sentiment_score_sum` / `_count` | Sum/Counter | For averaging (0-100 scale) |
| `sentiment_avg` | Computed | Average sentiment score (0-100) |

### Classification & Intent Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `classification_{label}` | Counter | Count per classification label |
| `classification_avg_confidence` | Computed | Average classification confidence |
| `intent_{type}` | Counter | Count per intent type |
| `intent_avg_confidence` | Computed | Average intent confidence (0-100) |
| `resolution_{status}` | Counter | Count per resolution status |

### Quality Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `virtual_agent_quality_avg` | Computed | Average VA quality (0-10 scale) |
| `human_agent_quality_avg` | Computed | Average human agent quality (0-10 scale) |
| `transfer_rate_percent` | Computed | % of conversations transferred to human |
| `virtual_agent_resolved_without_human_percent` | Computed | Auto-resolution rate |

### AI Analytics Metrics (from Analytics Operator)

| Metric Name | Type | Description |
|-------------|------|-------------|
| `poc_ai_retention_rate_percent` | Computed | % resolved by AI without human |
| `poc_csat_avg` | Computed | Average inferred CSAT (1-5) |
| `poc_csat_{1-5}` | Counter | CSAT score distribution |
| `poc_topic_{name}` | Counter | Count per primary topic |
| `poc_subtopic_{primary_-_subtopic}` | Counter | Count per topic-subtopic combination |
| `poc_error_rate_percent` | Computed | % with AI errors |
| `poc_back_to_ivr_rate_percent` | Computed | % where customer returned to IVR |

### Handoff Reason Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `poc_handoff_customer_request` | Counter | Conversations where customer requested human |
| `poc_handoff_lack_of_comprehension` | Counter | Conversations where AI failed to understand |
| `poc_handoff_lack_of_knowledge` | Counter | Conversations where AI lacked knowledge |
| `poc_handoff_total` | Counter | Total conversations with any handoff |
| `poc_handoff_customer_request_rate_percent` | Computed | % of all conversations (tracks AI acceptance) |
| `poc_handoff_lack_of_comprehension_rate_percent` | Computed | % of all conversations (tracks AI quality) |
| `poc_handoff_lack_of_knowledge_rate_percent` | Computed | % of all conversations (tracks knowledge base quality) |

### PII & Summary Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `pii_entities_detected` | Counter | Total PII entities found |
| `pii_avg_entities_per_conversation` | Computed | Average PII per conversation |
| `summary_avg_words` | Computed | Average summary length |

---

## Period-Level Metrics

The metrics API returns two types of derived metrics:

- **Per-day**: One data point per date (e.g., `avg_handling_time_sec` for `2026-04-16`). Used for time series charts.
- **Period**: A single data point with `date = "period"` that sums numerators and denominators across all days in the requested range, then computes the derived value. Used for stat panels.

This ensures that stat panels showing a rate (like `poc_handoff_lack_of_comprehension_rate_percent`) compute the correct aggregate — `total comprehension handoffs / total conversations` — rather than averaging daily rates, which would be mathematically incorrect.

Stat panels should use **Calculation: Last (not null)** to pick up the period value. Time series panels automatically use the per-day values.

---

## Conversation List Enrichment

The conversations list endpoint (`GET /tenants/{id}/conversations`) can include operator result fields alongside conversation metadata. This enables drill-down in BI tools — for example, filtering conversations by `handoff_reason` without a separate query.

**Configuration:** Edit `config/operator-fields.json` to define which fields to surface:

```json
{
  "operators": {
    "Analytics": {
      "fields": ["handoff_reason"]
    }
  }
}
```

The config file is deployed to S3 (`s3://{raw-bucket}/config/`) at deploy time. The API Lambda reads it on cold start and caches it in memory. To update, edit the file and redeploy.

> **Note:** This config will be replaced by the `surfaceInList` flag in `config/operator-metrics.json` once the config-driven metrics system is fully implemented.

**Performance note:** This makes one additional DynamoDB query per conversation in the list. Safe up to ~500 conversations per request. For larger datasets, consider the indexed approach described in the Roadmap.

---

## Cost Considerations

### Athena Pricing (Simple + Lakehouse)
- **Simple**: Lambda invocations + DynamoDB RCUs per query
- **Lakehouse**: $5 per TB scanned (Parquet is columnar — efficient)
- Glue ETL: ~$0.44 per DPU-hour (jobs typically < 5 min)

### REST API Pricing
- API Gateway: $3.50 per million requests
- Lambda: $0.20 per million requests
- DynamoDB reads: included in PAY_PER_REQUEST

**Recommendation:** Use the REST API for real-time dashboards (Grafana). Use Athena for historical analysis (QuickSight, Tableau).

---

## Security Best Practices

1. **QuickSight/Tableau/PowerBI/Looker**: Use IAM roles with least-privilege access to Athena, Glue, and S3
2. **Grafana/Metabase**: Use API keys with tenant-level isolation (planned — see Roadmap)
3. **Multi-tenancy**: Always filter by `tenant_id`
4. **Data masking**: Consider AWS Lake Formation for column-level security

---

## Troubleshooting

### REST API: No data
- Verify API URL is correct (check CDK output `ApiUrl`)
- Test with curl: `curl -s "$API_URL/tenants/$TENANT/metrics" | jq .`
- Check CloudWatch logs for `/aws/lambda/cirl-{env}-dashboard`

### Athena: Can't connect
- Verify Athena workgroup `cirl-{env}` exists
- For Simple mode: check QuickSight has `lambda:InvokeFunction` permission
- For Lakehouse: verify Glue ETL jobs have run and partitions discovered (`MSCK REPAIR TABLE`)

### Athena: Empty results
- For Simple mode: verify DynamoDB has data
- For Lakehouse: run Glue ETL jobs, then `MSCK REPAIR TABLE`
- Check partition filters match your data

### Athena: Slow queries
- Use partition filters (`tenant_id`, `year`, `month`, `day`)
- Query Gold layer (`lakehouse_metrics`) instead of Silver
- Select only needed columns

### Grafana: Panels show "No data"
- Check Infinity data source name matches panel configuration
- Verify **Rows/Root** is set to `metrics` (or `items` for conversations)
- Check **Parser** is set to `JSONata`
- Test query in Grafana **Explore** first

---

## See Also

- [README.md](../README.md) — Main documentation and metrics catalog
- [LAKEHOUSE-ARCHITECTURE.md](./LAKEHOUSE-ARCHITECTURE.md) — Lakehouse design details
- [schema-design.md](./schema-design.md) — Operator schema patterns
- [POC-SETUP.md](./POC-SETUP.md) — POC environment setup and testing guide
- [dashboards/README.md](../dashboards/README.md) — Dashboard import instructions
