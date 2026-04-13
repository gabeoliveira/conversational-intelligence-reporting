"""
CIRL Glue ETL Job: Curated Layer (Bronze → Silver)

Reads raw CI payloads from S3 (JSON), flattens nested structures,
and writes curated Parquet files partitioned by tenant_id/year/month/day.

Tables created:
- conversations: Flattened conversation metadata
- operator_results: Flattened operator results with JSON strings for complex nested data
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

# Get job parameters
args = getResolvedOptions(sys.argv, [
    'JOB_NAME',
    'RAW_BUCKET',
    'CURATED_BUCKET',
    'TENANT_ID',  # Optional: process specific tenant
    'PROCESS_DATE',  # Optional: process specific date (YYYY-MM-DD)
])

sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args['JOB_NAME'], args)

raw_bucket = args['RAW_BUCKET']
curated_bucket = args['CURATED_BUCKET']
tenant_id = args.get('TENANT_ID', None)
process_date = args.get('PROCESS_DATE', datetime.now().strftime('%Y-%m-%d'))

print(f"Processing raw data from s3://{raw_bucket}/")
print(f"Writing curated data to s3://{curated_bucket}/")
print(f"Process date: {process_date}")

# Read raw JSON files from S3
# Files are stored as: s3://raw-bucket/{tenant_id}/{conversation_id}/{timestamp}.json
raw_df = spark.read.json(f"s3://{raw_bucket}/")

# Filter by tenant if specified
if tenant_id:
    raw_df = raw_df.filter(F.col("tenantId") == tenant_id)

# Extract date parts from receivedAt for partitioning
raw_df = raw_df.withColumn("received_timestamp", F.to_timestamp("receivedAt"))
raw_df = raw_df.withColumn("year", F.year("received_timestamp").cast("string"))
raw_df = raw_df.withColumn("month", F.lpad(F.month("received_timestamp").cast("string"), 2, "0"))
raw_df = raw_df.withColumn("day", F.lpad(F.dayofmonth("received_timestamp").cast("string"), 2, "0"))

# ============================================================================
# Process Conversations
# ============================================================================
print("Processing conversations...")

conversations_df = raw_df.select(
    F.col("conversationId").alias("conversation_id"),
    F.col("tenantId").alias("tenant_id"),
    F.col("metadata.customerKey").alias("customer_key"),
    F.col("metadata.channel").alias("channel"),
    F.col("metadata.agentId").alias("agent_id"),
    F.col("metadata.teamId").alias("team_id"),
    F.col("metadata.queueId").alias("queue_id"),
    F.to_timestamp("receivedAt").alias("started_at"),
    F.current_timestamp().alias("created_at"),
    F.current_timestamp().alias("updated_at"),
    F.lit(1).alias("operator_count"),  # Will be updated by aggregation later
    "year",
    "month",
    "day"
).distinct()

# Write conversations to S3 as Parquet (partitioned)
conversations_df.write.mode("overwrite").partitionBy("tenant_id", "year", "month", "day") \
    .parquet(f"s3://{curated_bucket}/conversations/")

print(f"Wrote {conversations_df.count()} conversations to s3://{curated_bucket}/conversations/")

# ============================================================================
# Process Operator Results
# ============================================================================
print("Processing operator results...")

operator_results_df = raw_df.select(
    F.col("conversationId").alias("conversation_id"),
    F.col("tenantId").alias("tenant_id"),
    F.col("operatorName").alias("operator_name"),
    F.col("schemaVersion").alias("schema_version"),
    F.to_timestamp("receivedAt").alias("received_at"),
    F.col("s3Uri").alias("s3_uri"),
    F.to_timestamp("enrichedAt").alias("enriched_at"),
    F.col("enrichmentError").alias("enrichment_error"),
    # Store complex nested data as JSON strings for flexibility
    F.to_json(F.col("enrichedPayload")).alias("enriched_payload"),
    F.to_json(F.col("displayFields")).alias("display_fields"),
    "year",
    "month",
    "day"
)

# Write operator results to S3 as Parquet (partitioned)
operator_results_df.write.mode("overwrite").partitionBy("tenant_id", "year", "month", "day") \
    .parquet(f"s3://{curated_bucket}/operator_results/")

print(f"Wrote {operator_results_df.count()} operator results to s3://{curated_bucket}/operator_results/")

# ============================================================================
# Job Complete
# ============================================================================
job.commit()
print("Curated layer job completed successfully")
