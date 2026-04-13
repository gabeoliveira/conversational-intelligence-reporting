# PowerBI Dashboard Setup Guide

Since PowerBI uses a binary format (.pbix), we provide this guide to help you create a CIRL dashboard in PowerBI Desktop.

## Prerequisites

1. PowerBI Desktop installed ([Download here](https://powerbi.microsoft.com/desktop/))
2. Amazon Athena ODBC driver installed ([Download here](https://docs.aws.amazon.com/athena/latest/ug/connect-with-odbc.html))
3. CIRL stack deployed with Analytics stack (Glue ETL jobs have been run at least once)
4. AWS credentials with Athena and S3 access

---

## Step 1: Configure Athena ODBC Data Source

1. Open **ODBC Data Source Administrator** (Windows) or **iODBC Administrator** (Mac)

2. Add a new **System DSN**:
   - Driver: **Amazon Athena ODBC Driver**
   - Data Source Name: `CIRL`
   - Description: `CIRL Conversational Intelligence`

3. Configure connection:
   - **Athena Server**: `athena.{region}.amazonaws.com` (e.g., `athena.us-east-1.amazonaws.com`)
   - **Port**: `443`
   - **S3 Output Location**: `s3://cirl-athena-{env}-{account}-{region}/results/`
   - **Workgroup**: `cirl-{env}` (e.g., `cirl-demo`)
   - **Authentication Method**: IAM Credentials or IAM Profile

4. Test connection and save

---

## Step 2: Connect PowerBI to Athena

1. Open **PowerBI Desktop**

2. Click **Get Data** → **ODBC**

3. Select your **CIRL** data source

4. Choose **Database**: `cirl_{env}` (e.g., `cirl_demo`)

5. Select lakehouse tables:
   - `lakehouse_metrics` - Pre-computed daily metrics (recommended starting point)
   - `lakehouse_conversations` - Flattened conversation metadata
   - `lakehouse_operator_results` - Operator results with enriched payloads

6. Click **Load** or **Transform Data** to customize

---

## Step 3: Create Metrics View (Power Query)

The lakehouse tables have clean, flat schemas — minimal Power Query transforms needed:

### Metrics Transform

1. Select the `lakehouse_metrics` table in Power Query Editor

2. Convert date string (YYYYMMDD) to Date type:
   ```powerquery
   = Date.FromText(Text.Start([date], 4) & "-" & Text.Middle([date], 4, 2) & "-" & Text.End([date], 2))
   ```

3. Filter by your tenant ID: `tenant_id = "your-tenant"`

4. Rename table to `Metrics Clean`

### Conversations Transform

1. Select the `lakehouse_conversations` table

2. Convert `started_at` to DateTime type (already a timestamp)

3. Filter by your tenant ID: `tenant_id = "your-tenant"`

4. Rename table to `Conversations Clean`

---

## Step 4: Create Visualizations

Now build your dashboard with these suggested visuals:

### Page 1: Overview

#### KPI Cards (Top Row)
1. **Total Conversations**
   - Visual: Card
   - Field: `SUM(Metrics Clean[value])`
   - Filter: `metric_name = "conversation_count"`

2. **Average Sentiment**
   - Visual: Card
   - Field: `AVERAGE(Metrics Clean[value])`
   - Filter: `metric_name = "sentiment_avg"`
   - Conditional Formatting:
     - Red: 0-50
     - Yellow: 50-70
     - Green: 70-100

3. **Transfer Rate**
   - Visual: Card
   - Field: `AVERAGE(Metrics Clean[value])`
   - Filter: `metric_name = "transfer_rate_percent"`
   - Format: Percentage

4. **Virtual Agent Quality**
   - Visual: Gauge
   - Field: `AVERAGE(Metrics Clean[value])`
   - Filter: `metric_name = "virtual_agent_quality_avg"`
   - Min: 0, Max: 10
   - Target: 7

#### Charts

5. **Sentiment Trend (Line Chart)**
   - Axis: `Metrics Clean[date]`
   - Values: `AVERAGE(Metrics Clean[value])`
   - Legend: `metric_name`
   - Filter: `metric_name = "sentiment_avg"`

6. **Daily Conversation Volume (Column Chart)**
   - Axis: `Metrics Clean[date]`
   - Values: `SUM(Metrics Clean[value])`
   - Filter: `metric_name = "conversation_count"`

7. **Operator Usage (Horizontal Bar Chart)**
   - Axis: `metric_name`
   - Values: `SUM(Metrics Clean[value])`
   - Filter: `metric_name CONTAINS "operator_"`
   - Sort: Descending by value
   - Top N: 10

8. **Channel Distribution (Pie Chart)**
   - Legend: `Conversations Clean[channel_type]`
   - Values: `COUNT(Conversations Clean[conversation_id])`

### Page 2: Customer Insights

9. **Top Customers (Table)**
   - Columns:
     - `Conversations Clean[customer_key]`
     - `Conversation Count = COUNT(Conversations Clean[conversation_id])`
     - `Last Contact = MAX(Conversations Clean[started_at])`
   - Sort: Descending by Conversation Count
   - Top N: 20

10. **Recent Conversations (Table)**
    - Columns:
      - `conversation_id`
      - `started_at`
      - `customer_key`
      - `agent_id`
      - `channel_type`
      - `operator_count`
    - Sort: Descending by started_at
    - Top N: 50

11. **Conversation Volume Heatmap**
    - Rows: `WEEKDAY(started_at)`
    - Columns: `HOUR(started_at)`
    - Values: `COUNT(conversation_id)`
    - Color scale: Light to dark blue

---

## Step 5: Add Filters and Slicers

Add these slicers to enable interactive filtering:

1. **Date Range Slicer**
   - Field: `Metrics Clean[date]`
   - Type: Between
   - Default: Last 30 days

2. **Tenant Filter** (if multi-tenant)
   - Field: `Metrics Clean[tenant_id]`
   - Type: Dropdown
   - Apply to: All pages

3. **Channel Filter**
   - Field: `Conversations Clean[channel_type]`
   - Type: Buttons
   - Apply to: Page 2

---

## Step 6: Apply Themes and Formatting

1. Go to **View** → **Themes** → Choose a theme or create custom

2. Recommended color scheme:
   - Primary: `#509EE3` (Blue)
   - Success: `#84BB4C` (Green)
   - Warning: `#F9CF48` (Yellow)
   - Danger: `#ED6E6E` (Red)

3. Set page background and canvas settings

4. Add dashboard title: **"CIRL - Conversational Intelligence"**

---

## Step 7: Configure Data Refresh

For automatic data refresh in PowerBI Service:

1. Publish to PowerBI Service

2. Configure gateway connection:
   - Install **On-premises data gateway**
   - Configure gateway to use your ODBC connection

3. Set refresh schedule:
   - Go to dataset **Settings**
   - **Scheduled refresh** → Configure
   - Recommended: Hourly or daily refresh

---

## Step 8: Save and Share

1. Save as `.pbix` file:
   - File name: `CIRL-Dashboard.pbix`
   - Location: Your dashboards directory

2. Publish to PowerBI Service:
   - Click **Publish** → Select workspace
   - Share with team members

3. (Optional) Export as template:
   - **File** → **Export** → **PowerBI Template (.pbit)**
   - Remove sensitive data and credentials
   - Share template with team

---

## DAX Measures Reference

Here are useful DAX measures to add to your data model:

### Total Conversations (Last 30 Days)
```dax
Total Conversations =
CALCULATE(
    SUM('Metrics Clean'[value]),
    'Metrics Clean'[metric_name] = "conversation_count",
    'Metrics Clean'[date] >= TODAY() - 30
)
```

### Average Sentiment
```dax
Avg Sentiment =
CALCULATE(
    AVERAGE('Metrics Clean'[value]),
    'Metrics Clean'[metric_name] = "sentiment_avg"
)
```

### Transfer Rate %
```dax
Transfer Rate =
CALCULATE(
    AVERAGE('Metrics Clean'[value]),
    'Metrics Clean'[metric_name] = "transfer_rate_percent"
)
```

### Previous Period Comparison
```dax
Previous Period Conversations =
CALCULATE(
    SUM('Metrics Clean'[value]),
    'Metrics Clean'[metric_name] = "conversation_count",
    DATEADD('Metrics Clean'[date], -30, DAY)
)
```

### Percent Change
```dax
Conversations Change % =
DIVIDE(
    [Total Conversations] - [Previous Period Conversations],
    [Previous Period Conversations],
    0
)
```

---

## Troubleshooting

### Connection Errors

**"Unable to connect to Athena"**
- Verify ODBC driver is installed correctly
- Check AWS credentials are valid
- Ensure Athena workgroup exists and is accessible

**"Query timeout"**
- Add partition filters to reduce data volume (`tenant_id`, `year`, `month`)
- Query `lakehouse_metrics` (Gold, small) instead of `lakehouse_conversations` (Silver, large)
- Increase timeout in ODBC connection settings

### Performance Issues

**Slow visuals loading**
- Import data to PowerBI instead of DirectQuery
- Use partition filters in queries (`tenant_id`, `year`, `month`)
- Query Gold layer (`lakehouse_metrics`) instead of Silver for aggregated data
- Reduce date range filter

**Large dataset errors**
- Use DirectQuery mode instead of Import
- Filter by tenant_id and date partitions in Power Query
- Limit historical data to last 90 days

### Data Quality Issues

**Missing or incorrect data**
- Verify Glue ETL jobs have been run successfully (check Glue console)
- Run partition discovery: `MSCK REPAIR TABLE cirl_demo.lakehouse_metrics;`
- Ensure raw data exists in S3 Bronze layer
- Check Glue job CloudWatch logs for errors

**Date formatting errors**
- Ensure date columns are properly typed in Power Query
- Use `Date.FromText()` to parse YYYYMMDD format
- Set data type to Date, not Text

---

## Resources

- [PowerBI Desktop Download](https://powerbi.microsoft.com/desktop/)
- [Athena ODBC Driver Documentation](https://docs.aws.amazon.com/athena/latest/ug/connect-with-odbc.html)
- [PowerBI DAX Reference](https://docs.microsoft.com/dax/)
- [CIRL BI Integration Guide](../docs/06-bi-integration.md)
- [CIRL API Reference](../docs/04-api-reference.md)

---

## Need Help?

- See full BI integration guide: [docs/06-bi-integration.md](../docs/06-bi-integration.md)
- Report issues: GitHub Issues
- Check CloudWatch logs for CIRL stack errors
