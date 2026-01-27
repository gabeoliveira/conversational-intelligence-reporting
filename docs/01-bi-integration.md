# BI Tool Integration Guide

This guide explains how to connect your CIRL API to popular BI tools for building custom dashboards and analytics.

## Table of Contents

- [QuickSight](#quicksight)
- [Tableau](#tableau)
- [Looker](#looker)
- [Power BI](#power-bi)
- [Metrics Catalog](#metrics-catalog)
- [Sample Dashboards](#sample-dashboards)

---

## Prerequisites

Before connecting any BI tool, you need:

1. **API URL**: Your deployed CIRL API endpoint (e.g., `https://xxx.execute-api.us-east-1.amazonaws.com/v1`)
2. **Tenant ID**: Your tenant identifier (e.g., `gleet`)
3. **Authentication**: Currently the API is open (add API Gateway auth if needed)

---

## QuickSight

AWS QuickSight has the best integration with CIRL since both run on AWS.

### Option 1: Direct API Connection

1. **Create New Data Source**
   - Go to QuickSight → Datasets → New dataset
   - Select "API" as data source

2. **Configure API Connection**
   ```
   Name: CIRL Metrics
   URL: https://your-api-url/v1/tenants/your-tenant-id/metrics?from=2026-01-01&to=2026-12-31
   Method: GET
   ```

3. **Set Refresh Schedule** (optional)
   - Hourly, daily, or manual refresh
   - Metrics are aggregated daily

4. **Create Analysis**
   - Drag `date` to X-axis
   - Drag `value` to Y-axis
   - Filter by `metricName`

### Option 2: S3 Export (For Large Datasets)

If you need better performance or historical data:

1. Export DynamoDB to S3 (add to your CDK stack)
2. Use QuickSight's S3 connector
3. Query with Athena for SQL-like interface

**Sample CDK Addition:**
```typescript
// Export DynamoDB table to S3 daily
const exportRule = new events.Rule(this, 'DailyExport', {
  schedule: events.Schedule.cron({ hour: '2', minute: '0' }),
});

exportRule.addTarget(new targets.LambdaFunction(exportLambda));
```

---

## Tableau

Tableau connects to CIRL via Web Data Connector.

### Setup

1. **Install Web Data Connector**
   - Tableau Desktop: Help → Settings and Performance → Manage Web Data Connectors
   - Enable WDC

2. **Create Custom Connector**

Save this as `cirl-connector.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <title>CIRL Data Connector</title>
  <script src="https://connectors.tableau.com/libs/tableauwdc-2.3.latest.js"></script>
  <script>
    (function() {
      var myConnector = tableau.makeConnector();

      myConnector.getSchema = function(schemaCallback) {
        var cols = [
          { id: "date", dataType: tableau.dataTypeEnum.date },
          { id: "metricName", dataType: tableau.dataTypeEnum.string },
          { id: "value", dataType: tableau.dataTypeEnum.float }
        ];

        var tableSchema = {
          id: "cirlMetrics",
          alias: "CIRL Metrics",
          columns: cols
        };

        schemaCallback([tableSchema]);
      };

      myConnector.getData = function(table, doneCallback) {
        var apiUrl = tableau.connectionData;

        fetch(apiUrl)
          .then(res => res.json())
          .then(data => {
            var tableData = data.metrics.map(m => ({
              date: m.date,
              metricName: m.metricName,
              value: m.value
            }));
            table.appendRows(tableData);
            doneCallback();
          });
      };

      tableau.registerConnector(myConnector);

      $(document).ready(function() {
        $("#submitButton").click(function() {
          var apiUrl = $("#apiUrl").val();
          tableau.connectionData = apiUrl;
          tableau.connectionName = "CIRL Metrics";
          tableau.submit();
        });
      });
    })();
  </script>
</head>
<body>
  <h2>CIRL Metrics Connector</h2>
  <label>API URL:</label>
  <input type="text" id="apiUrl"
         value="https://your-api-url/v1/tenants/your-tenant/metrics"
         size="80" />
  <button id="submitButton">Connect</button>
</body>
</html>
```

3. **Use in Tableau**
   - Open Tableau Desktop
   - Connect to Data → Web Data Connector
   - Enter URL: `file:///path/to/cirl-connector.html`
   - Enter your API URL
   - Click Connect

4. **Build Dashboard**
   - Create worksheets with metrics
   - Add filters for date ranges and metric names
   - Publish to Tableau Server/Online

---

## Looker

Looker works best with SQL databases, so we'll use a proxy approach.

### Option 1: API Proxy (Recommended)

1. **Create LookML Model**

```lookml
connection: "cirl_api"

explore: metrics {
  label: "CIRL Metrics"
}

view: metrics {
  derived_table: {
    sql: SELECT * FROM cirl_metrics_table ;;
  }

  dimension: date {
    type: date
    sql: ${TABLE}.date ;;
  }

  dimension: metric_name {
    type: string
    sql: ${TABLE}.metricName ;;
  }

  measure: total_value {
    type: sum
    sql: ${TABLE}.value ;;
  }

  measure: average_value {
    type: average
    sql: ${TABLE}.value ;;
  }
}
```

2. **Create API Adapter Lambda** (optional)

Add a Lambda that converts your REST API to Looker's expected format, or use Looker's native API connection if available.

### Option 2: Athena/Redshift Export

Export DynamoDB data to S3, then use Looker's Athena or Redshift connector.

---

## Power BI

Power BI connects via REST API connector.

### Setup

1. **Get Data → Web**
   - Click "Get Data" → More → Web

2. **Enter API URL**
   ```
   https://your-api-url/v1/tenants/your-tenant-id/metrics
   ```

3. **Transform Data** (Power Query)
   - Expand JSON columns
   - Convert date strings to date type
   - Filter metrics as needed

4. **Create Measures**

```dax
Total Conversations =
    SUM(Metrics[value])
    WHERE Metrics[metricName] = "conversation_count"

Average Sentiment =
    CALCULATE(
        AVERAGE(Metrics[value]),
        Metrics[metricName] = "sentiment_avg"
    )

PII Detection Rate =
    DIVIDE(
        CALCULATE(SUM(Metrics[value]), Metrics[metricName] = "pii_conversations_with_entities"),
        CALCULATE(SUM(Metrics[value]), Metrics[metricName] = "conversation_count")
    )
```

5. **Set Refresh Schedule**
   - Publish to Power BI Service
   - Configure scheduled refresh (hourly/daily)

---

## Metrics Catalog

### Core Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `conversation_count` | Counter | Total conversations processed |
| `operator_{name}_count` | Counter | Per-operator execution count |

### Sentiment Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `sentiment_positive` | Counter | Conversations with positive sentiment |
| `sentiment_negative` | Counter | Conversations with negative sentiment |
| `sentiment_neutral` | Counter | Conversations with neutral sentiment |
| `sentiment_score_sum` | Sum | Total sentiment scores (0-100 scale, for averaging) |
| `sentiment_score_count` | Counter | Count of sentiment scores |
| `sentiment_avg` | Computed | Average sentiment score (0-100 where 0 is very negative, 100 is very positive) |

### PII Detection Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `pii_entities_detected` | Counter | Total PII entities found |
| `pii_conversations_with_entities` | Counter | Conversations containing PII |
| `pii_avg_entities_per_conversation` | Computed | Average PII entities per conversation |

### Summary Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `summary_word_count_sum` | Sum | Total words in summaries |
| `summary_word_count_count` | Counter | Number of summaries |
| `summary_avg_words` | Computed | Average summary length |

### Classification Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `classification_{label}` | Counter | Count per classification label |
| `classification_confidence_sum` | Sum | Total confidence scores |
| `classification_confidence_count` | Counter | Number of classifications |
| `classification_avg_confidence` | Computed | Average classification confidence |

### Intent & Resolution Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `intent_scheduling` | Counter | Conversations with scheduling intent |
| `intent_cancellation` | Counter | Conversations with cancellation intent |
| `intent_problem` | Counter | Conversations with problem intent |
| `intent_other` | Counter | Conversations with other intent |
| `resolution_resolved` | Counter | Conversations with resolved status |
| `resolution_unresolved` | Counter | Conversations with unresolved status |
| `resolution_escalated` | Counter | Conversations that were escalated |
| `resolution_transferred` | Counter | Conversations that were transferred |
| `intent_confidence_sum` | Sum | Total intent confidence scores (0-100 scale) |
| `intent_confidence_count` | Counter | Number of intent detections |
| `intent_avg_confidence` | Computed | Average intent detection confidence (0-100) |

### Quality Metrics - Virtual Agent

| Metric Name | Type | Description |
|-------------|------|-------------|
| `virtual_agent_quality_sum` | Sum | Total virtual agent quality scores |
| `virtual_agent_quality_count` | Counter | Number of quality assessments |
| `virtual_agent_quality_avg` | Computed | Average virtual agent quality (0-10 scale) |
| `virtual_agent_resolved_questions` | Counter | Conversations where VA resolved questions |
| `virtual_agent_avoided_hallucinations` | Counter | Conversations where VA avoided hallucinations |
| `virtual_agent_avoided_repetitions` | Counter | Conversations where VA avoided repetitions |
| `virtual_agent_resolved_without_human` | Counter | Conversations resolved without human transfer |
| `virtual_agent_maintained_consistency` | Counter | Conversations where VA maintained consistency |
| `virtual_agent_resolved_questions_percent` | Computed | % of conversations where VA resolved questions |
| `virtual_agent_avoided_hallucinations_percent` | Computed | % of conversations with no hallucinations |
| `virtual_agent_avoided_repetitions_percent` | Computed | % of conversations with no repetitions |
| `virtual_agent_resolved_without_human_percent` | Computed | Auto-resolution rate (no human needed) |
| `virtual_agent_maintained_consistency_percent` | Computed | % of conversations with consistent VA responses |

### Quality Metrics - Human Agent

| Metric Name | Type | Description |
|-------------|------|-------------|
| `human_agent_transfers` | Counter | Total conversations transferred to human agents |
| `transfer_rate_percent` | Computed | % of conversations transferred to human (transfers ÷ total) |
| `human_agent_quality_sum` | Sum | Total human agent quality scores |
| `human_agent_quality_count` | Counter | Number of quality assessments |
| `human_agent_quality_avg` | Computed | Average human agent quality (0-10 scale) |
| `human_agent_resolved_questions` | Counter | Transferred conversations where human resolved questions |
| `human_agent_was_cordial` | Counter | Transferred conversations where human was cordial |
| `human_agent_avoided_repetitions` | Counter | Transferred conversations where human avoided repetitions |
| `human_agent_resolved_problem` | Counter | Transferred conversations where human resolved the problem |
| `human_agent_clear_closing` | Counter | Transferred conversations with clear closing |
| `human_agent_resolved_questions_percent` | Computed | % of transfers where human resolved questions |
| `human_agent_was_cordial_percent` | Computed | % of transfers with cordial human agent |
| `human_agent_avoided_repetitions_percent` | Computed | % of transfers with no repetitions |
| `human_agent_resolved_problem_percent` | Computed | % of transfers where problem was resolved |
| `human_agent_clear_closing_percent` | Computed | % of transfers with clear closing |

### Adding Custom Metrics

See [README.md - Customization](../README.md#add-custom-metrics) for how to add your own metrics.

---

## Sample Dashboards

### Executive Dashboard

**Metrics to Display:**
- Total conversations (trend over time)
- Average sentiment score (gauge)
- PII detection rate (percentage)
- Top classification categories (bar chart)
- Operator execution counts (pie chart)

**Sample QuickSight Visual:**
```
Line Chart:
- X-axis: date
- Y-axis: SUM(value)
- Filter: metricName = "conversation_count"
- Group by: Week

Gauge:
- Value: AVG(value) WHERE metricName = "sentiment_avg"
- Range: 0-10
```

### Agent Performance Dashboard

**Metrics to Display:**
- Conversations by agent (use conversations API with `agentId` filter)
- Average sentiment by agent
- Resolution rate
- Call duration

**Implementation:**
Use the Conversations API filtered by `agentId`:
```
GET /tenants/{tenantId}/conversations?agentId={agentId}&from=2026-01-01
```

Then aggregate in your BI tool.

### Operations Dashboard

**Metrics to Display:**
- Operator execution rates
- Processing errors (from enrichmentError field)
- Data freshness (last received conversation)
- PII compliance metrics

### Quality & Performance Dashboard

**Metrics to Display:**
- Virtual agent quality score (gauge, 0-10 scale)
- Human agent quality score (gauge, 0-10 scale)
- Transfer rate trend (line chart)
- Auto-resolution rate (percentage)
- Virtual agent success metrics (stacked bar chart):
  - Resolved questions %
  - Avoided hallucinations %
  - Avoided repetitions %
  - Maintained consistency %
- Human agent success metrics (stacked bar chart):
  - Resolved problems %
  - Was cordial %
  - Clear closing %

**Sample QuickSight Visuals:**
```
KPI Cards:
- Virtual Agent Quality: AVG(value) WHERE metricName = "virtual_agent_quality_avg"
- Human Agent Quality: AVG(value) WHERE metricName = "human_agent_quality_avg"
- Auto-Resolution Rate: AVG(value) WHERE metricName = "virtual_agent_resolved_without_human_percent"
- Transfer Rate: AVG(value) WHERE metricName = "transfer_rate_percent"

Line Chart (Transfer Rate Over Time):
- X-axis: date
- Y-axis: value
- Filter: metricName = "transfer_rate_percent"

Combo Chart (Quality Scores):
- X-axis: date
- Left Y-axis: Line for "virtual_agent_quality_avg"
- Right Y-axis: Line for "human_agent_quality_avg"
```

**Sample Looker Dashboard:**
```lookml
- dashboard: quality_overview
  title: "Agent Quality Overview"
  layout: newspaper

  elements:
  - name: virtual_agent_quality
    type: single_value
    model: cirl
    explore: metrics
    measures: [metrics.avg_value]
    filters:
      metrics.metric_name: virtual_agent_quality_avg

  - name: auto_resolution_rate
    type: gauge
    model: cirl
    explore: metrics
    measures: [metrics.avg_value]
    filters:
      metrics.metric_name: virtual_agent_resolved_without_human_percent

  - name: quality_trend
    type: looker_line
    model: cirl
    explore: metrics
    dimensions: [metrics.date]
    pivots: [metrics.metric_name]
    measures: [metrics.avg_value]
    filters:
      metrics.metric_name: virtual_agent_quality_avg,human_agent_quality_avg
```

---

## Best Practices

1. **Refresh Schedules**
   - Metrics are aggregated daily
   - Refresh dashboards once per day (overnight)
   - Use incremental refresh for conversations API

2. **Performance**
   - Use date filters in API calls
   - Cache results in BI tool
   - Consider S3 export for historical analysis

3. **Security**
   - Add API Gateway authentication (API keys, Cognito, IAM)
   - Use HTTPS only
   - Restrict BI tool IPs in API Gateway resource policy

4. **Data Modeling**
   - Create relationships between conversations and metrics
   - Use date tables for time intelligence
   - Pre-aggregate where possible

---

## Troubleshooting

### CORS Errors
- CORS is enabled for Flex integration
- If you get CORS errors from BI tools, add your domain to allowed origins in `services/api/src/handler.ts`

### Authentication Issues
- API is currently open (no auth required)
- To add auth, configure API Gateway authorizers in `infra/cdk/lib/api-stack.ts`

### Data Not Refreshing
- Check CloudWatch logs for Lambda errors
- Verify webhook is configured correctly in Twilio
- Ensure DynamoDB has recent data

### Performance Issues
- Add pagination to conversations API calls
- Use date filters to limit result set
- Consider exporting to S3 for large historical datasets

---

## Support

For issues or questions:
- GitHub Issues: [your-repo-url]
- Documentation: [docs/](.)
