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
| `GET /tenants/{tenantId}/conversations?from=&to=&agentId=&queueId=&customerKey=&{indexedField}=` | Conversation list with filters. Supports indexed operator field filters (e.g., `?handoff_reason=LACK_OF_KNOWLEDGE`) |
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

> For SQL examples, schema reference, and a query cookbook, see [`athena-cookbook.md`](./athena-cookbook.md). The per-tool sections below cover only the connection setup.

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

See [`athena-cookbook.md`](./athena-cookbook.md) for working examples in both simple and lakehouse modes.

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

CIRL emits two layers of metrics. Rather than maintain a hand-curated list here that drifts every time the config changes, this section describes how metric names are *derived* — the live list for any tenant is always one API call away.

### Built-in Metrics (always present)

| Metric Name | Type | Description |
|---|---|---|
| `conversation_count` | Counter | Total conversations per day |
| `operator_<Name>_count` | Counter | Execution count per Twilio operator |
| `agent_sentence_count` | Counter | Agent sentences (from transcript) |
| `customer_sentence_count` | Counter | Customer sentences |
| `sentence_count_total` | Counter | Total transcript sentences |
| `handling_time_sum` / `_count` | Sum/Counter | For computing average |
| `avg_handling_time_sec` | Computed | Average conversation duration (seconds) |
| `response_time_sum` / `_count` | Sum/Counter | For computing average |
| `avg_response_time_sec` | Computed | Average agent response time (seconds) |
| `customer_wait_time_sum` / `_count` | Sum/Counter | For computing average |
| `avg_customer_wait_time_sec` | Computed | Average customer wait time (seconds) |

### Config-Driven Metrics

Every metric defined in [`config/operator-metrics.json`](../config/operator-metrics.json) emits a fixed set of names auto-derived from its `metricPrefix`. The exact set depends on the primitive type:

| Primitive | Emitted metrics |
|---|---|
| `boolean` | `<prefix>_count`, `<prefix>_total`, `<prefix>_rate_percent` |
| `integer` | `<prefix>_count`, `<prefix>_sum`, `<prefix>_avg`, plus `<prefix>_<value>` if `distribution: true` |
| `category` | `<prefix>_<value>` per distinct value |
| `enum` | `<prefix>_<value>` per value, `<prefix>_total`, `<prefix>_<value>_rate_percent` |
| `category_array` | `<prefix>_<primary>` per primary; if `subcategoryField` set, also `<subcategoryPrefix>_<primary>_-_<sub>` |

Example — the Inter POC's [Analytics operator config](../config/operator-metrics.json) defines `ai_retained` (boolean, prefix `poc_ai_retained`), `inferred_csat` (integer with `distribution: true`, prefix `poc_csat`), `handoff_reason` (enum, prefix `poc_handoff`), and `topics` (category_array, prefix `poc_topic`/`poc_subtopic`). Those alone produce ~20 metric names without any custom code.

### Discovering Live Metrics

```http
GET /tenants/<id>/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Each result has a `metricName` (internal) and `displayName` (friendly, derived from the config's `displayName` field). Period-level rates also appear with `date: "period"` for stat panels — see the next section.

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

**Configuration:** Set `surfaceInList: true` on any metric in `config/operator-metrics.json`:

```json
{
  "field": "handoff_reason",
  "type": "enum",
  "metricPrefix": "poc_handoff",
  "displayName": "Transbordo",
  "surfaceInList": true
}
```

The config is deployed to S3 and read by the API Lambda on cold start. Fields with `surfaceInList: true` are automatically extracted from operator results and included in the conversations list response.

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
2. **Grafana/Metabase**: Set `CIRL_AUTH=apikey` and configure the API key in the data source settings (`x-api-key` header)
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
