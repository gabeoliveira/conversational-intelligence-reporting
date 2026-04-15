# Dashboard Quick Start

Get started with CIRL dashboards in 5 minutes.

## Choose Your BI Tool

| Tool | Best For | Time to Setup | File |
|------|----------|---------------|------|
| **Grafana** | Real-time monitoring, API-based dashboards | 5 min | [grafana-cirl-dashboard.json](grafana-cirl-dashboard.json) |
| **QuickSight** | AWS-native analytics, easy drag-and-drop | 10 min | [quicksight-cirl-dashboard.json](quicksight-cirl-dashboard.json) |
| **Tableau** | Advanced analytics, data exploration | 15 min | [tableau-cirl-workbook.twb](tableau-cirl-workbook.twb) |
| **Metabase** | Quick questions, self-service analytics | 10 min | [metabase-cirl-collection.json](metabase-cirl-collection.json) |
| **PowerBI** | Microsoft ecosystem, enterprise reporting | 20 min | [powerbi-setup-guide.md](powerbi-setup-guide.md) |

---

## Fastest Path: Grafana

If you want to see results immediately, start with Grafana:

1. **Install Infinity plugin**:
   ```bash
   grafana-cli plugins install yesoreyeram-infinity-datasource
   ```

2. **Configure data source**:
   - URL: Your CIRL API Gateway URL
   - No authentication needed (or add API key)

3. **Import dashboard**:
   - Copy your API URL and Tenant ID
   - Edit `grafana-cirl-dashboard.json` and replace:
     - `${API_URL}` → Your API Gateway URL
     - `${TENANT_ID}` → Your tenant ID
   - Import in Grafana UI

4. **Done!** Real-time metrics are now visible.

---

## Most Popular: QuickSight

For AWS users, QuickSight is the easiest SQL-based option:

1. **Prerequisites**:
   - CIRL stack deployed (includes Glue ETL jobs and Athena workgroup)
   - Glue ETL jobs have been run at least once (see CDK output `RunGlueJobsCommands`)
   - QuickSight account in same region
   - QuickSight permissions for Athena and S3 (see [docs/bi-integration.md](../docs/bi-integration.md))

2. **Connect to Athena**:
   - In QuickSight: **Datasets** → **New dataset** → **Athena**
   - Data source name: `CIRL-demo` (or your env)
   - Athena workgroup: `cirl-demo`
   - **Catalog**: Select `AwsDataCatalog`
   - **Database**: Select `cirl_demo` (or `cirl_{env}`)
   - **Table**: Select `lakehouse_metrics` (recommended starting point)
   - Or choose **Use custom SQL** for more complex queries
   - **Import mode**: Choose "Directly query your data" (recommended)
     - **SPICE**: Caches data for faster dashboards but requires refresh schedules
     - **Direct query**: Always shows latest data from S3 Parquet

3. **Write Custom SQL** (optional):
   ```sql
   -- Example: Get metrics for January 2026
   SELECT
     date,
     metric_name,
     value
   FROM cirl_demo.lakehouse_metrics
   WHERE tenant_id = 'demo'
     AND year = '2026' AND month = '01'
   ORDER BY date, metric_name
   ```
   Replace `cirl_demo` with your Glue database name (`cirl_{env}`).

4. **Create Analysis**:
   - Use the visual specs in `quicksight-cirl-dashboard.json` as reference
   - Create calculated fields to parse PK/SK patterns
   - Drag and drop fields to create:
     - KPI cards (Total Conversations, Sentiment, Transfer Rate)
     - Line charts (Sentiment Trend, Daily Volume)
     - Bar charts (Operator Usage)
     - Tables (Top Customers, Recent Conversations)

4. **Publish dashboard** and share with team

---

## Enterprise Choice: Tableau or PowerBI

### Tableau
- Install Athena ODBC driver
- Open `tableau-cirl-workbook.twb` and update connection details
- Tableau will load pre-built worksheets and dashboards

### PowerBI
- Follow the comprehensive [PowerBI Setup Guide](powerbi-setup-guide.md)
- Includes DAX measures, Power Query transforms, and visual specifications

---

## What's Included in Each Dashboard?

All dashboard templates include:

### KPI Cards (Top Row)
- Total Conversations
- Average Sentiment Score
- Transfer Rate %
- Virtual Agent Quality Score

### Trend Charts
- Daily sentiment trend (line chart)
- Conversation volume over time (bar/area chart)
- Quality scores over time

### Operational Insights
- Top 10 operators by usage (bar chart)
- Top customers by conversation volume (table)
- Recent conversations with details (table)
- Channel distribution (pie chart)

### Time Analysis
- Conversation volume heatmap (by hour/day)
- Peak hours identification

---

## Prerequisites for All Dashboards

Before importing any dashboard:

1. **Deploy CIRL stack**:
   ```bash
   npm run deploy:demo
   ```
   This deploys the Glue ETL jobs, Athena workgroup, and lakehouse infrastructure.

2. **Verify data exists**:
   ```bash
   # Test API endpoint
   curl https://your-api-url/v1/tenants/your-tenant-id/metrics

   # Or run demo seed script
   npm run demo:seed
   ```

---

## Customization

All templates are designed to be customized:

### Change Tenant ID
- Update filters in each dashboard to show your tenant
- For multi-tenant: add tenant selector dropdown

### Adjust Date Range
- Default: Last 30 days
- Modify to 7 days, 90 days, or custom range

### Add Custom Metrics
- If you've added custom metrics to CIRL (see [README](../README.md#add-custom-metrics))
- Add new visuals using your custom metric names

### Branding
- Update colors to match your brand
- Add company logo
- Customize titles and descriptions

---

## Troubleshooting

### No Data Showing
- Verify CIRL stack is deployed
- Ensure Glue ETL jobs have been run at least once
- Discover partitions: `MSCK REPAIR TABLE cirl_demo.lakehouse_metrics;`
- For Athena: Test with: `SELECT * FROM cirl_demo.lakehouse_metrics LIMIT 10`
- For API: Test endpoints with curl

### Connection Errors
- **Athena**: Check IAM permissions for Athena, Glue, and S3
- **Athena**: Verify QuickSight has S3 read permissions for curated/aggregated buckets
- **API**: Verify API Gateway URL is correct and accessible

### Performance Issues
- Use partition filters: `WHERE tenant_id = 'demo' AND year = '2026' AND month = '01'`
- Query Gold layer (`lakehouse_metrics`) instead of Silver for aggregated data
- For Grafana: reduce refresh rate

---

## Next Steps

After importing your first dashboard:

1. **Share with team**: Publish and set up user access
2. **Set up alerts**: Configure notifications for anomalies (sentiment drops, high transfer rates)
3. **Schedule reports**: Export daily/weekly reports via email
4. **Add more visuals**: Customize based on your specific use cases

---

## Resources

- [Full BI Integration Guide](../docs/bi-integration.md)
- [Dashboard README](README.md) - Detailed import instructions
- [API Reference](../docs/04-api-reference.md)
- [Metrics Catalog](../docs/05-metrics-catalog.md)

---

**Questions?** Open an issue on GitHub or see the main [CIRL documentation](../README.md).
