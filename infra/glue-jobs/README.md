# CIRL Glue ETL Jobs

This directory contains AWS Glue ETL jobs for the CIRL lakehouse architecture.

## Architecture

```
S3 Raw (Bronze)
  ↓
[curated_layer_job.py]
  ↓
S3 Curated (Silver - Parquet)
  ↓
[aggregated_metrics_job.py]
  ↓
  ├─→ S3 Aggregated (Gold - Parquet) → Athena → QuickSight/Tableau
  └─→ DynamoDB → API → Grafana
```

## Jobs

### 1. Curated Layer Job (`curated_layer_job.py`)

**Purpose**: Transform raw JSON files into curated Parquet files with flattened schema.

**Input**: S3 Raw bucket (`cirl-raw-{env}-*`)
- Raw CI payloads as JSON files

**Output**: S3 Curated bucket (`cirl-curated-{env}-*`)
- `conversations/` - Flattened conversation metadata (Parquet)
- `operator_results/` - Flattened operator results (Parquet)

**Partitioning**: `tenant_id/year/month/day/`

**Schedule**: Hourly or daily

**Parameters**:
- `--RAW_BUCKET`: S3 bucket name for raw data
- `--CURATED_BUCKET`: S3 bucket name for curated data
- `--TENANT_ID` (optional): Process specific tenant only
- `--PROCESS_DATE` (optional): Process specific date (YYYY-MM-DD)

**Example**:
```bash
aws glue start-job-run \
  --job-name cirl-curated-layer-demo \
  --arguments '{
    "--RAW_BUCKET":"cirl-raw-demo-123456789012-us-east-1",
    "--CURATED_BUCKET":"cirl-curated-demo-123456789012-us-east-1",
    "--PROCESS_DATE":"2026-01-29"
  }'
```

### 2. Aggregated Metrics Job (`aggregated_metrics_job.py`)

**Purpose**: Compute daily rollup metrics and write to both S3 Parquet (for BI) and DynamoDB (for API).

**Input**: S3 Curated bucket (`cirl-curated-{env}-*`)
- `operator_results/` - Curated operator results (Parquet)

**Output**:
1. S3 Aggregated bucket (`cirl-aggregated-{env}-*`)
   - `metrics/` - Pre-computed daily metrics (Parquet)
2. DynamoDB table (`cirl-{env}`)
   - Writes metrics with `entityType=AGGREGATE` for API reads

**Partitioning**: `tenant_id/year/month/`

**Schedule**: Daily (after curated layer job completes)

**Parameters**:
- `--CURATED_BUCKET`: S3 bucket name for curated data
- `--AGGREGATED_BUCKET`: S3 bucket name for aggregated data
- `--DYNAMODB_TABLE`: DynamoDB table name
- `--TENANT_ID` (optional): Process specific tenant only
- `--PROCESS_DATE` (optional): Process specific date (YYYY-MM-DD)

**Example**:
```bash
aws glue start-job-run \
  --job-name cirl-aggregated-metrics-demo \
  --arguments '{
    "--CURATED_BUCKET":"cirl-curated-demo-123456789012-us-east-1",
    "--AGGREGATED_BUCKET":"cirl-aggregated-demo-123456789012-us-east-1",
    "--DYNAMODB_TABLE":"cirl-demo",
    "--PROCESS_DATE":"2026-01-29"
  }'
```

## Deployment

### Manual Deployment

1. **Upload scripts to S3**:
```bash
aws s3 cp curated_layer_job.py s3://cirl-raw-{env}-{account}-{region}/glue-scripts/
aws s3 cp aggregated_metrics_job.py s3://cirl-raw-{env}-{account}-{region}/glue-scripts/
```

2. **Create Glue jobs** (via AWS Console or CLI):

```bash
# Curated Layer Job
aws glue create-job \
  --name cirl-curated-layer-{env} \
  --role cirl-glue-{env} \
  --command '{
    "Name":"glueetl",
    "ScriptLocation":"s3://cirl-raw-{env}-{account}-{region}/glue-scripts/curated_layer_job.py",
    "PythonVersion":"3"
  }' \
  --default-arguments '{
    "--job-language":"python",
    "--enable-metrics":"true",
    "--enable-continuous-cloudwatch-log":"true"
  }' \
  --glue-version "4.0" \
  --number-of-workers 2 \
  --worker-type "G.1X"

# Aggregated Metrics Job
aws glue create-job \
  --name cirl-aggregated-metrics-{env} \
  --role cirl-glue-{env} \
  --command '{
    "Name":"glueetl",
    "ScriptLocation":"s3://cirl-raw-{env}-{account}-{region}/glue-scripts/aggregated_metrics_job.py",
    "PythonVersion":"3"
  }' \
  --default-arguments '{
    "--job-language":"python",
    "--enable-metrics":"true",
    "--enable-continuous-cloudwatch-log":"true"
  }' \
  --glue-version "4.0" \
  --number-of-workers 2 \
  --worker-type "G.1X"
```

3. **Create EventBridge schedules**:

```bash
# Schedule curated layer job (daily at 2 AM)
aws events put-rule \
  --name cirl-curated-layer-schedule-{env} \
  --schedule-expression "cron(0 2 * * ? *)"

aws events put-targets \
  --rule cirl-curated-layer-schedule-{env} \
  --targets '[{
    "Id":"1",
    "Arn":"arn:aws:glue:{region}:{account}:job/cirl-curated-layer-{env}",
    "RoleArn":"arn:aws:iam::{account}:role/cirl-glue-{env}",
    "Input":"{\"--RAW_BUCKET\":\"cirl-raw-{env}-{account}-{region}\",\"--CURATED_BUCKET\":\"cirl-curated-{env}-{account}-{region}\"}"
  }]'

# Schedule aggregated metrics job (daily at 4 AM, after curated layer)
aws events put-rule \
  --name cirl-aggregated-metrics-schedule-{env} \
  --schedule-expression "cron(0 4 * * ? *)"

aws events put-targets \
  --rule cirl-aggregated-metrics-schedule-{env} \
  --targets '[{
    "Id":"1",
    "Arn":"arn:aws:glue:{region}:{account}:job/cirl-aggregated-metrics-{env}",
    "RoleArn":"arn:aws:iam::{account}:role/cirl-glue-{env}",
    "Input":"{\"--CURATED_BUCKET\":\"cirl-curated-{env}-{account}-{region}\",\"--AGGREGATED_BUCKET\":\"cirl-aggregated-{env}-{account}-{region}\",\"--DYNAMODB_TABLE\":\"cirl-{env}\"}"
  }]'
```

### ✅ Automated CDK Deployment

**The Glue scripts and jobs are now automatically deployed via CDK!**

When you deploy the analytics stack, the `AnalyticsStack` automatically:
1. ✅ Uploads scripts to S3 (`glue-scripts/` folder)
2. ✅ Creates Glue jobs with proper configuration
3. ✅ Sets up IAM roles and permissions
4. ✅ Outputs ready-to-run AWS CLI commands

After deployment, check the CloudFormation stack outputs:
- `GlueJobCuratedLayer` - Job name for curated layer
- `GlueJobAggregatedMetrics` - Job name for aggregated metrics
- `RunGlueJobsCommands` - Ready-to-run AWS CLI commands

**No manual steps required!** The manual deployment instructions above are only for reference or special cases.

## Partition Management

After running the Glue jobs, you need to inform Athena about new partitions:

```sql
-- Repair tables to discover new partitions
MSCK REPAIR TABLE cirl_{env}.conversations;
MSCK REPAIR TABLE cirl_{env}.operator_results;
MSCK REPAIR TABLE cirl_{env}.metrics;

-- Or add partitions manually
ALTER TABLE cirl_{env}.conversations ADD IF NOT EXISTS
PARTITION (tenant_id='demo', year='2026', month='01', day='29')
LOCATION 's3://cirl-curated-{env}-{account}-{region}/conversations/tenant_id=demo/year=2026/month=01/day=29/';
```

## Monitoring

**CloudWatch Logs**: Glue job logs are automatically sent to CloudWatch Logs
- Log group: `/aws-glue/jobs/output`
- Log stream: `{job-name}/{job-run-id}`

**Metrics**:
- Job run duration
- Records processed
- Errors and retries

**Alarms** (recommended):
- Job failure rate > 10%
- Job duration > 30 minutes
- DynamoDB write throttling

## Troubleshooting

### Job fails with "No files found"
- **Cause**: No raw data in S3 for the specified date/tenant
- **Fix**: Check that raw data exists, or adjust `PROCESS_DATE` parameter

### Partition not visible in Athena
- **Cause**: Athena doesn't know about new partitions
- **Fix**: Run `MSCK REPAIR TABLE` or add partition manually

### DynamoDB throttling errors
- **Cause**: Too many writes in aggregated metrics job
- **Fix**: Increase DynamoDB table capacity or use batch_writer with smaller batches

### Schema mismatch errors
- **Cause**: Raw JSON schema changed
- **Fix**: Update curated layer job to handle new schema version

## Performance Tuning

- **Worker type**: Use `G.2X` for larger datasets (> 100GB)
- **Number of workers**: Scale based on data volume (2-10 workers typical)
- **Partitioning**: Ensure proper partitioning for fast queries
- **Compression**: Parquet with Snappy compression (default)
- **File size**: Aim for 128MB-1GB Parquet files for optimal performance

## See Also

- [Analytics Stack](../cdk/lib/analytics-stack.ts) - Infrastructure definition
- [Lakehouse Documentation](../../docs/LAKEHOUSE-ARCHITECTURE.md) - Architecture overview
- [BI Integration Guide](../../docs/bi-integration.md) - Connecting BI tools
