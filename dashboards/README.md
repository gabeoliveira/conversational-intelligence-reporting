# Sample BI Dashboards

This directory contains working dashboard examples for the BI tools mentioned in the CIRL documentation. Import these templates to get started quickly with pre-built visualizations.

**New to dashboards?** See [QUICKSTART.md](QUICKSTART.md) for the fastest path to visualizing your CIRL data (5-10 minutes).

## Important: Lakehouse Architecture

CIRL uses a **lakehouse architecture** (Bronze → Silver → Gold) with S3 Parquet tables queried via Athena. The dashboard templates in this directory are reference examples that require customization with your environment details.

**Key points:**
- Glue ETL jobs transform raw JSON into optimized Parquet tables
- Query lakehouse tables via Athena: `SELECT * FROM cirl_{env}.lakehouse_metrics`
- Clean, flat schemas — no PK/SK parsing or `regexp_extract()` needed
- All tables are partitioned by `tenant_id`, `year`, `month` (and `day` for conversations/operators)
- All query examples are in [docs/06-bi-integration.md](../docs/06-bi-integration.md)

The JSON/TWB files provide visualization layouts and references, but **you must update the database/table names** to match your environment.

## Available Dashboards

### QuickSight
- **File**: `quicksight-cirl-dashboard.json`
- **Type**: QuickSight Analysis definition (CloudFormation-compatible)
- **Features**: Daily metrics trends, conversation volume, sentiment analysis, operator performance
- **Import**: See [QuickSight Import Guide](#quicksight-import)

### Grafana
- **File**: `grafana-cirl-dashboard.json`
- **Type**: Grafana dashboard JSON
- **Features**: Real-time metrics via REST API, conversation volume, sentiment trends, operator counts
- **Import**: See [Grafana Import Guide](#grafana-import)

### Tableau
- **File**: `tableau-cirl-workbook.twb`
- **Type**: Tableau workbook (XML)
- **Features**: Athena-based analysis with daily trends, customer insights, agent performance
- **Import**: See [Tableau Import Guide](#tableau-import)

### Metabase
- **File**: `metabase-cirl-collection.json`
- **Type**: Metabase collection export
- **Features**: Pre-built questions for metrics, conversations, and operators
- **Import**: See [Metabase Import Guide](#metabase-import)

### PowerBI
- **File**: `powerbi-setup-guide.md`
- **Type**: Step-by-step setup guide (PowerBI uses binary .pbix format)
- **Features**: Complete instructions for creating CIRL dashboard with DAX measures, visuals, and data transforms
- **Import**: See [PowerBI Setup Guide](powerbi-setup-guide.md)

### Grafana POC (AI Virtual Agent Analytics)
- **File**: `grafana-poc-dashboard.json`
- **Type**: Grafana dashboard JSON (uses Infinity plugin with JSONata parser)
- **Features**: AI retention rate, inferred CSAT, error rate, handling time, response time, topics distribution, CSAT distribution, conversations table
- **Best for**: POC demos using `CIRL_ANALYTICS=none` mode with REST API
- **Import**: Grafana UI → Dashboards → Import → upload JSON. Set API URL and Tenant ID template variables after import.

---

## Import Guides

### QuickSight Import

1. Deploy your CIRL stack and run Glue ETL jobs to populate lakehouse tables (see [docs/06-bi-integration.md](../docs/06-bi-integration.md))

2. Update the dashboard template with your environment details:
   ```bash
   # Edit quicksight-cirl-dashboard.json
   # Replace placeholders:
   # - {AWS_ACCOUNT_ID} with your AWS account ID
   # - {AWS_REGION} with your region
   # - {CIRL_ENV} with your environment name (e.g., demo)
   # - {TENANT_ID} with your tenant ID
   ```

3. Create the QuickSight dataset:
   - In QuickSight, go to **Datasets** → **New dataset**
   - Select **Athena**
   - Data source name: `CIRL-{env}` (e.g., `CIRL-Demo`)
   - Athena workgroup: `cirl-{env}`
   - **Catalog**: Select `AwsDataCatalog`
   - **Database**: Select `cirl_{env}` (e.g., `cirl_demo`)
   - **Table**: Select a lakehouse table (e.g., `lakehouse_metrics`)
   - Or choose **Use custom SQL** for more complex queries
   - **Import mode**: Choose "Directly query your data" for latest data or "Import to SPICE" for faster cached dashboards

4. Write your custom SQL query (optional):
   ```sql
   -- Example: Metrics Query (clean schema - no regexp_extract needed)
   SELECT
     date,
     metric_name,
     value
   FROM cirl_demo.lakehouse_metrics
   WHERE tenant_id = 'demo'
     AND year = '2026'
   ORDER BY date, metric_name
   ```
   See [BI Integration Guide](../docs/06-bi-integration.md) for more query examples.

5. Create a new Analysis:
   - Use the imported dataset
   - Manually recreate the visuals from the JSON template
   - QuickSight doesn't support direct JSON import, but the template provides exact specifications

**Alternative: Use CloudFormation**

If you want to automate dashboard creation, use the AWS CLI:
```bash
# Create a QuickSight template from the JSON definition
aws quicksight create-template \
  --aws-account-id YOUR_ACCOUNT_ID \
  --template-id cirl-dashboard-template \
  --name "CIRL Dashboard Template" \
  --cli-input-json file://quicksight-cirl-dashboard.json
```

### Grafana Import

1. Install the Infinity data source plugin:
   ```bash
   grafana-cli plugins install yesoreyeram-infinity-datasource
   ```

2. Configure the Infinity data source:
   - Go to **Configuration** → **Data Sources** → **Add data source**
   - Select **Infinity**
   - URL: Your CIRL API Gateway URL (e.g., `https://xxx.execute-api.us-east-1.amazonaws.com/v1`)
   - Authentication: None (or add API key if configured)

3. Update the dashboard JSON:
   ```bash
   # Edit grafana-cirl-dashboard.json
   # Replace placeholders:
   # - ${API_URL} with your API Gateway URL
   # - ${TENANT_ID} with your tenant ID
   ```

4. Import the dashboard:
   - Go to **Dashboards** → **Import**
   - Upload `grafana-cirl-dashboard.json`
   - Select your Infinity data source
   - Click **Import**

### Tableau Import

1. Install the [Amazon Athena connector](https://www.tableau.com/support/drivers) for Tableau

2. Connect to Athena:
   - Open Tableau Desktop
   - **Connect** → **To a Server** → **Amazon Athena**
   - Server: `athena.{region}.amazonaws.com`
   - S3 Staging Directory: `s3://cirl-athena-{env}-{account}-{region}/results/`
   - Workgroup: `cirl-{env}`
   - Authentication: IAM credentials or IAM role

3. Select database `cirl_{env}` and browse lakehouse tables, or use Custom SQL:
   ```sql
   -- Example: Metrics Query (clean schema - no parsing needed)
   SELECT date, metric_name, value
   FROM cirl_demo.lakehouse_metrics
   WHERE tenant_id = 'demo'
     AND year = '2026'
   ORDER BY date
   ```
   Replace `cirl_demo` with your actual Glue database name (`cirl_{env}`).

4. Update the workbook:
   - Edit `tableau-cirl-workbook.twb` in a text editor
   - Replace connection placeholders and database/table names
   - See [BI Integration Guide](../docs/06-bi-integration.md) for complete query examples

5. Open the workbook:
   - Open `tableau-cirl-workbook.twb` in Tableau Desktop
   - Tableau will prompt you for Athena credentials
   - Update data sources with your custom SQL queries

### Metabase Import

1. Set up Athena connection in Metabase:
   - Go to **Admin** → **Databases** → **Add database**
   - Select **Amazon Athena**
   - Configure connection details (see [docs/06-bi-integration.md](../docs/06-bi-integration.md))
   - Region: Your AWS region
   - S3 Staging Directory: `s3://cirl-athena-{env}-{account}-{region}/results/`
   - Workgroup: `cirl-{env}`

2. Create custom queries using lakehouse tables:
   ```sql
   -- Example: Metrics Query (clean schema - no parsing needed)
   SELECT date, metric_name, value
   FROM cirl_demo.lakehouse_metrics
   WHERE tenant_id = 'demo'
     AND year = '2026'
   ORDER BY date
   ```
   See [BI Integration Guide](../docs/06-bi-integration.md) for more examples.

3. Update the collection JSON:
   ```bash
   # Edit metabase-cirl-collection.json
   # Replace database_id with your Metabase Athena database ID
   # Update database/table references to match your environment
   ```

4. Import the collection:
   - Go to **Admin** → **Tools** → **Import**
   - Upload `metabase-cirl-collection.json`
   - Update the pre-built questions with your federated queries

---

## Dashboard Features

The dashboard templates provide these visualization types. Lakehouse tables have clean, flat schemas — no PK/SK parsing needed.

### Key Metrics Cards
- Total conversations (last 30 days) - `SELECT SUM(value) FROM lakehouse_metrics WHERE metric_name = 'conversation_count'`
- Average sentiment score - `SELECT AVG(value) FROM lakehouse_metrics WHERE metric_name = 'sentiment_avg'`
- Top operators by usage - `SELECT operator_name, COUNT(*) FROM lakehouse_operator_results GROUP BY operator_name`
- Transfer rate percentage - `SELECT value FROM lakehouse_metrics WHERE metric_name = 'transfer_rate_percent'`

### Visualizations

1. **Daily Metrics Trend (Line Chart)**
   - Sentiment average over time - Query `lakehouse_metrics` filtered by `metric_name`
   - Conversation volume - Query `lakehouse_metrics` for `conversation_count`
   - Quality scores - Query `lakehouse_metrics` for `virtual_agent_quality_avg`

2. **Operator Performance (Bar Chart)**
   - Execution counts by operator - `GROUP BY operator_name` on `lakehouse_operator_results`
   - Average confidence scores - From `lakehouse_metrics` classification metrics

3. **Customer Insights (Table)**
   - Top customers by conversation volume - `GROUP BY customer_key` on `lakehouse_conversations`
   - Recent conversations with metadata - Query `lakehouse_conversations` with date filters

4. **Hourly Heatmap**
   - Conversation volume by hour and day - Use `started_at` timestamp from `lakehouse_conversations`
   - Identifies peak support times

5. **Intent Distribution (Pie Chart)**
   - Top intents detected - From `lakehouse_metrics` intent count metrics
   - Intent confidence levels - From `lakehouse_metrics` confidence metrics

**Query Examples**: See [docs/06-bi-integration.md](../docs/06-bi-integration.md) for complete SQL examples for each visualization type.

---

## Customization

All dashboard templates are designed to be customized. **Required customizations:**

1. **Update Database/Table Names**: Replace `cirl_demo` with your Glue database name (`cirl_{env}`)

2. **Change Date Range**: Update partition filters to show different time periods
   - Use partition keys: `WHERE year = '2026' AND month = '01'`

3. **Add Tenant Filters**: If multi-tenant, add `tenant_id` filter to all visuals
   - `WHERE tenant_id = 'your-tenant-id'`

4. **Custom Metrics**: Add visualizations for custom metrics you've defined
   - `WHERE metric_name = 'your_custom_metric'` on `lakehouse_metrics`

5. **Branding**: Update colors, fonts, and logos to match your brand

6. **Additional Fields**: Include custom fields from your enrichment logic (stored in `enriched_payload` JSON column)

---

## Screenshots

Screenshots of each dashboard are available in the `screenshots/` directory:
- `quicksight-overview.png`
- `grafana-realtime.png`
- `tableau-analysis.png`
- `metabase-questions.png`

---

## Troubleshooting

### QuickSight: "No data to display"
- Verify you selected the correct database: `cirl_{env}` from `AwsDataCatalog`
- Ensure Glue ETL jobs have been run and partitions discovered (`MSCK REPAIR TABLE`)
- Check that QuickSight has S3 read permissions for curated/aggregated/results buckets
- Verify your query uses correct partition filters (`tenant_id`, `year`, `month`)
- Check QuickSight has access to the Athena workgroup

### Grafana: "Error fetching data"
- Verify the Infinity data source URL is correct
- Test the API endpoint directly with curl
- Check Grafana logs for detailed error messages

### Tableau: "Connection failed"
- Verify Athena ODBC driver is installed
- Check AWS credentials have athena:* permissions
- Ensure S3 staging directory exists and is writable

### Metabase: "Database connection error"
- Verify Athena connection settings
- Test connection in Metabase admin panel
- Check IAM credentials have glue:GetTable permissions

---

## Need Help?

- Full BI integration guide: [docs/06-bi-integration.md](../docs/06-bi-integration.md)
- API reference: [docs/04-api-reference.md](../docs/04-api-reference.md)
- Report issues: [GitHub Issues](https://github.com/your-org/cirl/issues)
