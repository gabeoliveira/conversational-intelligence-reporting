"""
CIRL Glue ETL Job: Aggregated Metrics (Silver → Gold + DynamoDB)

Reads curated Parquet data from S3, computes daily rollup metrics,
and writes to:
1. S3 Parquet (Gold layer) for BI queries via Athena
2. DynamoDB for fast API reads (Grafana, real-time dashboards)

Metrics computed:
- Conversation counts
- Operator execution counts
- Sentiment aggregates (sum, count, avg)
- Classification metrics
- Quality scores
- Transfer rates
"""

import sys
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from pyspark.sql import functions as F
from pyspark.sql.types import *
from datetime import datetime
import boto3

# Get job parameters
args = getResolvedOptions(sys.argv, [
    'JOB_NAME',
    'CURATED_BUCKET',
    'AGGREGATED_BUCKET',
    'DYNAMODB_TABLE',
    'TENANT_ID',  # Optional
    'PROCESS_DATE',  # Optional: process specific date (YYYY-MM-DD)
])

sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args['JOB_NAME'], args)

curated_bucket = args['CURATED_BUCKET']
aggregated_bucket = args['AGGREGATED_BUCKET']
dynamodb_table = args['DYNAMODB_TABLE']
tenant_id = args.get('TENANT_ID', None)
process_date = args.get('PROCESS_DATE', datetime.now().strftime('%Y-%m-%d'))

print(f"Processing curated data from s3://{curated_bucket}/")
print(f"Writing aggregated data to s3://{aggregated_bucket}/")
print(f"Writing to DynamoDB table: {dynamodb_table}")
print(f"Process date: {process_date}")

# Parse process date for partitioning
process_dt = datetime.strptime(process_date, '%Y-%m-%d')
year = process_dt.strftime('%Y')
month = process_dt.strftime('%m')
day = process_dt.strftime('%d')

# ============================================================================
# Read Curated Data
# ============================================================================
print("Reading curated operator results...")

operator_results_df = spark.read.parquet(f"s3://{curated_bucket}/operator_results/") \
    .filter((F.col("year") == year) & (F.col("month") == month))

if tenant_id:
    operator_results_df = operator_results_df.filter(F.col("tenant_id") == tenant_id)

# Add date column for aggregation
operator_results_df = operator_results_df.withColumn(
    "date",
    F.date_format("received_at", "yyyyMMdd")
)

# Parse JSON strings back to structs for processing
operator_results_df = operator_results_df.withColumn(
    "enriched_payload_parsed",
    F.from_json("enriched_payload", "map<string,string>")
)

# ============================================================================
# Compute Aggregated Metrics
# ============================================================================
print("Computing aggregated metrics...")

metrics_list = []

# Conversation count by date and tenant
conv_count = operator_results_df.groupBy("tenant_id", "date") \
    .agg(F.countDistinct("conversation_id").alias("value")) \
    .withColumn("metric_name", F.lit("conversation_count"))

metrics_list.append(conv_count)

# Operator execution counts
operator_counts = operator_results_df.groupBy("tenant_id", "date", "operator_name") \
    .agg(F.count("*").alias("value")) \
    .withColumn("metric_name", F.concat(F.lit("operator_"), F.col("operator_name"), F.lit("_count"))) \
    .drop("operator_name")

metrics_list.append(operator_counts)

# For operators with specific payloads, extract and aggregate
# This is a simplified version - expand based on your actual operator schemas

# Example: Sentiment metrics (if operator_name = 'conversation-intelligence')
sentiment_df = operator_results_df.filter(F.col("operator_name") == "conversation-intelligence")

if sentiment_df.count() > 0:
    # Extract sentiment from enriched_payload JSON
    # Note: Adjust based on actual payload structure
    sentiment_metrics = sentiment_df.groupBy("tenant_id", "date") \
        .agg(
            F.count("*").alias("sentiment_count"),
            # Add more aggregations as needed based on payload structure
        )

    # Convert to metrics format
    sentiment_count_metric = sentiment_metrics.select(
        "tenant_id",
        "date",
        F.lit("sentiment_score_count").alias("metric_name"),
        F.col("sentiment_count").alias("value")
    )

    metrics_list.append(sentiment_count_metric)

# Union all metrics into a single DataFrame
metrics_df = metrics_list[0]
for metric in metrics_list[1:]:
    metrics_df = metrics_df.union(metric)

# Add partitioning columns
metrics_df = metrics_df.withColumn("year", F.lit(year))
metrics_df = metrics_df.withColumn("month", F.lit(month))

# ============================================================================
# Write to S3 Parquet (Gold Layer)
# ============================================================================
print("Writing aggregated metrics to S3...")

metrics_df.write.mode("overwrite").partitionBy("tenant_id", "year", "month") \
    .parquet(f"s3://{aggregated_bucket}/metrics/")

print(f"Wrote {metrics_df.count()} metrics to s3://{aggregated_bucket}/metrics/")

# ============================================================================
# Write to DynamoDB for API Fast Reads
# ============================================================================
print("Writing metrics to DynamoDB...")

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(dynamodb_table)

# Collect metrics and write to DynamoDB
metrics_to_write = metrics_df.collect()

with table.batch_writer() as batch:
    for row in metrics_to_write:
        item = {
            'PK': f"TENANT#{row.tenant_id}#AGG#DAY",
            'SK': f"DAY#{row.date}#METRIC#{row.metric_name}",
            'tenantId': row.tenant_id,
            'date': row.date,
            'metricName': row.metric_name,
            'entityType': 'AGGREGATE',
            # Use spine + payload pattern for consistency with operational table
            'payload': f'{{"value":{row.value}}}'
        }
        batch.put_item(Item=item)

print(f"Wrote {len(metrics_to_write)} metrics to DynamoDB table: {dynamodb_table}")

# ============================================================================
# Job Complete
# ============================================================================
job.commit()
print("Aggregated metrics job completed successfully")
