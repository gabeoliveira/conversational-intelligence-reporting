import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';

export interface AnalyticsStackProps extends cdk.StackProps {
  envName: string;
  rawBucket: s3.Bucket;
  table: dynamodb.Table;
  encryptionKey: cdk.aws_kms.IKey;
}

export class AnalyticsStack extends cdk.Stack {
  public readonly athenaResultsBucket: s3.Bucket;
  public readonly curatedBucket: s3.Bucket;
  public readonly aggregatedBucket: s3.Bucket;
  public readonly glueDatabase: glue.CfnDatabase;
  public readonly athenaWorkgroup: athena.CfnWorkGroup;

  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    const { envName, rawBucket, table, encryptionKey } = props;

    // S3 bucket for Athena query results
    this.athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      bucketName: `cirl-athena-${envName}-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'delete-old-results',
          expiration: cdk.Duration.days(30),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // S3 bucket for curated data (Silver layer - Parquet, partitioned)
    this.curatedBucket = new s3.Bucket(this, 'CuratedBucket', {
      bucketName: `cirl-curated-${envName}-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      lifecycleRules: [
        {
          id: 'transition-to-ia',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
      removalPolicy: envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: envName !== 'prod',
    });

    // S3 bucket for aggregated metrics (Gold layer - pre-computed rollups)
    this.aggregatedBucket = new s3.Bucket(this, 'AggregatedBucket', {
      bucketName: `cirl-aggregated-${envName}-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      lifecycleRules: [
        {
          id: 'transition-to-ia',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
      removalPolicy: envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: envName !== 'prod',
    });

    // Glue Database for organizing Athena tables
    this.glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: `cirl_${envName}`,
        description: 'CIRL Conversational Intelligence lakehouse (Parquet data in S3)',
      },
    });

    // Glue table for curated conversations (Silver layer)
    new glue.CfnTable(this, 'CuratedConversationsTable', {
      catalogId: this.account,
      databaseName: this.glueDatabase.ref,
      tableInput: {
        name: 'lakehouse_conversations',
        description: 'Curated conversation data (flattened from JSON, Parquet format)',
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [
          { name: 'tenant_id', type: 'string' },
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
        storageDescriptor: {
          location: `s3://${this.curatedBucket.bucketName}/conversations/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          compressed: true,
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
            parameters: {
              'serialization.format': '1',
            },
          },
          columns: [
            { name: 'conversation_id', type: 'string' },
            { name: 'customer_key', type: 'string' },
            { name: 'channel', type: 'string' },
            { name: 'agent_id', type: 'string' },
            { name: 'team_id', type: 'string' },
            { name: 'queue_id', type: 'string' },
            { name: 'started_at', type: 'timestamp' },
            { name: 'created_at', type: 'timestamp' },
            { name: 'updated_at', type: 'timestamp' },
            { name: 'operator_count', type: 'int' },
          ],
        },
      },
    });

    // Glue table for curated operator results (Silver layer)
    new glue.CfnTable(this, 'CuratedOperatorResultsTable', {
      catalogId: this.account,
      databaseName: this.glueDatabase.ref,
      tableInput: {
        name: 'lakehouse_operator_results',
        description: 'Curated operator result data (flattened from JSON, Parquet format)',
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [
          { name: 'tenant_id', type: 'string' },
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
        storageDescriptor: {
          location: `s3://${this.curatedBucket.bucketName}/operator_results/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          compressed: true,
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
            parameters: {
              'serialization.format': '1',
            },
          },
          columns: [
            { name: 'conversation_id', type: 'string' },
            { name: 'operator_name', type: 'string' },
            { name: 'schema_version', type: 'string' },
            { name: 'received_at', type: 'timestamp' },
            { name: 's3_uri', type: 'string' },
            { name: 'enriched_at', type: 'timestamp' },
            { name: 'enrichment_error', type: 'string' },
            { name: 'enriched_payload', type: 'string' }, // JSON string for complex nested data
            { name: 'display_fields', type: 'string' }, // JSON string
          ],
        },
      },
    });

    // Glue table for aggregated metrics (Gold layer)
    new glue.CfnTable(this, 'AggregatedMetricsTable', {
      catalogId: this.account,
      databaseName: this.glueDatabase.ref,
      tableInput: {
        name: 'lakehouse_metrics',
        description: 'Pre-computed daily metrics (Gold layer, Parquet format)',
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [
          { name: 'tenant_id', type: 'string' },
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
        ],
        storageDescriptor: {
          location: `s3://${this.aggregatedBucket.bucketName}/metrics/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          compressed: true,
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
            parameters: {
              'serialization.format': '1',
            },
          },
          columns: [
            { name: 'date', type: 'string' }, // YYYYMMDD format
            { name: 'metric_name', type: 'string' },
            { name: 'value', type: 'double' },
          ],
        },
      },
    });

    // Athena Workgroup for CIRL queries
    this.athenaWorkgroup = new athena.CfnWorkGroup(this, 'AthenaWorkgroup', {
      name: `cirl-${envName}`,
      description: 'Workgroup for CIRL analytics queries',
      workGroupConfiguration: {
        resultConfiguration: {
          outputLocation: `s3://${this.athenaResultsBucket.bucketName}/results/`,
          encryptionConfiguration: {
            encryptionOption: 'SSE_S3',
          },
        },
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        engineVersion: {
          selectedEngineVersion: 'AUTO',
        },
      },
    });

    // IAM role for Glue ETL jobs
    const glueRole = new iam.Role(this, 'GlueRole', {
      roleName: `cirl-glue-${envName}`,
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      description: 'Role for Glue ETL jobs to process CIRL data',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });

    // Grant Glue access to read from raw bucket and write to curated/aggregated buckets
    // Note: rawBucket is passed from StorageStack
    glueRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [
          `arn:aws:s3:::cirl-raw-${envName}-*`,
          `arn:aws:s3:::cirl-raw-${envName}-*/*`,
        ],
      })
    );

    this.curatedBucket.grantReadWrite(glueRole);
    this.aggregatedBucket.grantReadWrite(glueRole);

    // Grant Glue access to KMS key for encryption
    glueRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
        resources: [encryptionKey.keyArn],
      })
    );

    // Grant Glue access to DynamoDB for writing metrics back
    table.grantReadWriteData(glueRole);

    // ============================================================================
    // Deploy Glue ETL Scripts to S3
    // ============================================================================

    // Deploy Glue scripts to the raw bucket (which will also store glue-scripts/)
    const scriptDeployment = new s3deploy.BucketDeployment(this, 'GlueScripts', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', '..', 'glue-jobs'), {
          exclude: ['README.md', '*.pyc', '__pycache__'],
        }),
      ],
      destinationBucket: rawBucket,
      destinationKeyPrefix: 'glue-scripts/',
      retainOnDelete: false,
    });

    // ============================================================================
    // Create Glue Jobs
    // ============================================================================

    // Curated Layer Job (Bronze → Silver)
    const curatedLayerJob = new glue.CfnJob(this, 'CuratedLayerJob', {
      name: `cirl-curated-layer-${envName}`,
      description: 'Transform raw JSON to curated Parquet (Bronze → Silver)',
      role: glueRole.roleArn,
      command: {
        name: 'glueetl',
        scriptLocation: `s3://${rawBucket.bucketName}/glue-scripts/curated_layer_job.py`,
        pythonVersion: '3',
      },
      glueVersion: '4.0',
      numberOfWorkers: 2,
      workerType: 'G.1X',
      timeout: 60, // 60 minutes
      defaultArguments: {
        '--job-language': 'python',
        '--enable-metrics': 'true',
        '--enable-continuous-cloudwatch-log': 'true',
        '--RAW_BUCKET': rawBucket.bucketName,
        '--CURATED_BUCKET': this.curatedBucket.bucketName,
      },
    });
    curatedLayerJob.node.addDependency(scriptDeployment);

    // Aggregated Metrics Job (Silver → Gold + DynamoDB)
    const aggregatedMetricsJob = new glue.CfnJob(this, 'AggregatedMetricsJob', {
      name: `cirl-aggregated-metrics-${envName}`,
      description: 'Compute rollup metrics and write to S3 + DynamoDB (Silver → Gold)',
      role: glueRole.roleArn,
      command: {
        name: 'glueetl',
        scriptLocation: `s3://${rawBucket.bucketName}/glue-scripts/aggregated_metrics_job.py`,
        pythonVersion: '3',
      },
      glueVersion: '4.0',
      numberOfWorkers: 2,
      workerType: 'G.1X',
      timeout: 60, // 60 minutes
      defaultArguments: {
        '--job-language': 'python',
        '--enable-metrics': 'true',
        '--enable-continuous-cloudwatch-log': 'true',
        '--CURATED_BUCKET': this.curatedBucket.bucketName,
        '--AGGREGATED_BUCKET': this.aggregatedBucket.bucketName,
        '--DYNAMODB_TABLE': table.tableName,
      },
    });
    aggregatedMetricsJob.node.addDependency(scriptDeployment);

    // ============================================================================
    // Outputs
    // ============================================================================
    new cdk.CfnOutput(this, 'GlueDatabaseName', {
      value: this.glueDatabase.ref,
      description: 'Glue database name for BI tools',
      exportName: `cirl-${envName}-glue-database`,
    });

    new cdk.CfnOutput(this, 'AthenaWorkgroupName', {
      value: this.athenaWorkgroup.name!,
      description: 'Athena workgroup for queries',
      exportName: `cirl-${envName}-athena-workgroup`,
    });

    new cdk.CfnOutput(this, 'CuratedBucketName', {
      value: this.curatedBucket.bucketName,
      description: 'S3 bucket for curated data (Silver layer - Parquet)',
      exportName: `cirl-${envName}-curated-bucket`,
    });

    new cdk.CfnOutput(this, 'AggregatedBucketName', {
      value: this.aggregatedBucket.bucketName,
      description: 'S3 bucket for aggregated metrics (Gold layer - Parquet)',
      exportName: `cirl-${envName}-aggregated-bucket`,
    });

    new cdk.CfnOutput(this, 'GlueRoleName', {
      value: glueRole.roleName,
      description: 'IAM role for Glue ETL jobs',
      exportName: `cirl-${envName}-glue-role`,
    });

    new cdk.CfnOutput(this, 'GlueJobCuratedLayer', {
      value: curatedLayerJob.name!,
      description: 'Glue job name for curated layer (Bronze → Silver)',
      exportName: `cirl-${envName}-glue-job-curated`,
    });

    new cdk.CfnOutput(this, 'GlueJobAggregatedMetrics', {
      value: aggregatedMetricsJob.name!,
      description: 'Glue job name for aggregated metrics (Silver → Gold + DynamoDB)',
      exportName: `cirl-${envName}-glue-job-aggregated`,
    });

    new cdk.CfnOutput(this, 'RunGlueJobsCommands', {
      value: `
# Run Curated Layer Job (Bronze → Silver)
aws glue start-job-run \\
  --job-name ${curatedLayerJob.name} \\
  --region ${this.region}

# Run Aggregated Metrics Job (Silver → Gold + DynamoDB)
aws glue start-job-run \\
  --job-name ${aggregatedMetricsJob.name} \\
  --region ${this.region}

# Run with specific date (YYYY-MM-DD)
aws glue start-job-run \\
  --job-name ${curatedLayerJob.name} \\
  --arguments '{"--PROCESS_DATE":"2026-01-29"}' \\
  --region ${this.region}

# Check job run status
aws glue get-job-runs \\
  --job-name ${curatedLayerJob.name} \\
  --max-results 5 \\
  --region ${this.region}
      `.trim(),
      description: 'Commands to run Glue ETL jobs',
    });

    new cdk.CfnOutput(this, 'SampleAthenaQueries', {
      value: `
-- Query curated conversations (Silver layer):
SELECT conversation_id, tenant_id, customer_key, channel, started_at
FROM ${this.glueDatabase.ref}.lakehouse_conversations
WHERE tenant_id = 'demo'
  AND year = '2026'
  AND month = '01'
ORDER BY started_at DESC
LIMIT 10;

-- Query aggregated metrics (Gold layer):
SELECT tenant_id, date, metric_name, value
FROM ${this.glueDatabase.ref}.lakehouse_metrics
WHERE tenant_id = 'demo'
  AND year = '2026'
  AND month = '01'
ORDER BY date DESC, metric_name
LIMIT 100;

-- Query operator results (Silver layer):
SELECT conversation_id, operator_name, schema_version, received_at
FROM ${this.glueDatabase.ref}.lakehouse_operator_results
WHERE tenant_id = 'demo'
  AND year = '2026'
  AND month = '01'
LIMIT 10;
      `,
      description: 'Sample Athena queries for CIRL lakehouse tables',
    });

    new cdk.CfnOutput(this, 'QuickSightSetup', {
      value: `QuickSight Setup Instructions:

1. Create Athena Data Source:
   - Data source name: CIRL-${envName}
   - Workgroup: ${this.athenaWorkgroup.name}
   - Database: ${this.glueDatabase.ref}

2. Create Datasets:
   - Conversations: Use table "lakehouse_conversations"
   - Metrics: Use table "lakehouse_metrics"
   - Operator Results: Use table "lakehouse_operator_results"

3. All tables are partitioned by tenant_id, year, month (and day for conversations/operator_results)
   - Use partition filters for better performance

4. Query mode: Choose "Direct Query" for real-time or "SPICE" for faster dashboards
      `,
      description: 'Instructions for setting up QuickSight with CIRL lakehouse',
    });

    new cdk.CfnOutput(this, 'NextSteps', {
      value: `✅ Lakehouse Infrastructure Deployed!

Next Steps:

1. Run Glue ETL jobs manually to process existing data:
   See "RunGlueJobsCommands" output for ready-to-run commands

2. After first job run, discover partitions in Athena:
   MSCK REPAIR TABLE ${this.glueDatabase.ref}.lakehouse_conversations;
   MSCK REPAIR TABLE ${this.glueDatabase.ref}.lakehouse_operator_results;
   MSCK REPAIR TABLE ${this.glueDatabase.ref}.lakehouse_metrics;

3. Test Athena queries using workgroup: ${this.athenaWorkgroup.name}
   See "SampleAthenaQueries" output for examples

4. (Optional) Schedule Glue jobs with EventBridge:
   - Curated layer (${curatedLayerJob.name}): Run hourly or daily
   - Aggregated metrics (${aggregatedMetricsJob.name}): Run daily after curated layer

5. Connect your BI tool (QuickSight, Tableau, PowerBI):
   See "QuickSightSetup" output for instructions
      `,
      description: 'Post-deployment steps for CIRL lakehouse',
    });
  }
}
