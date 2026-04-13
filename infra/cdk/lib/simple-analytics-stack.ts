import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as sam from 'aws-cdk-lib/aws-sam';
import { Construct } from 'constructs';

/**
 * SimpleAnalyticsStack deploys the Athena DynamoDB Connector so BI tools
 * can query DynamoDB directly via SQL — no Glue ETL, no Parquet, no
 * Bronze/Silver/Gold layers. Trade-off: slower and costlier Athena queries,
 * but zero operational overhead.
 *
 * Use this for <100K conversations/month or when simplicity matters more
 * than query cost. Switch to AnalyticsStack (lakehouse mode) when you
 * outgrow it.
 */
export interface SimpleAnalyticsStackProps extends cdk.StackProps {
  envName: string;
  table: dynamodb.Table;
  encryptionKey: cdk.aws_kms.IKey;
}

export class SimpleAnalyticsStack extends cdk.Stack {
  public readonly athenaResultsBucket: s3.Bucket;
  public readonly athenaWorkgroup: athena.CfnWorkGroup;

  constructor(scope: Construct, id: string, props: SimpleAnalyticsStackProps) {
    super(scope, id, props);

    const { envName, table, encryptionKey } = props;

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

    // Athena Workgroup
    this.athenaWorkgroup = new athena.CfnWorkGroup(this, 'AthenaWorkgroup', {
      name: `cirl-${envName}`,
      description: 'Workgroup for CIRL analytics queries (simple mode)',
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

    // =========================================================================
    // Athena DynamoDB Connector via Serverless Application Repository (SAR)
    //
    // This deploys the official AWS connector that lets Athena query DynamoDB
    // directly via SQL. No ETL, no data duplication — queries hit live data.
    //
    // The connector is a Lambda function published by AWS as a SAR application.
    // CDK deploys it as a nested CloudFormation stack.
    //
    // Source: https://github.com/awslabs/aws-athena-query-federation
    // SAR:    https://serverlessrepo.aws.amazon.com/applications/us-east-1/292517598671/AthenaDynamoDBConnector
    // =========================================================================

    const connectorName = `cirl-dynamo-connector-${envName}`;
    const catalogName = `cirl_dynamo_${envName}`;

    // Spill bucket for large federated query results that exceed Lambda memory
    const spillBucket = new s3.Bucket(this, 'ConnectorSpillBucket', {
      bucketName: `cirl-athena-spill-${envName}-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'delete-spill-data',
          expiration: cdk.Duration.days(1),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Deploy the connector from SAR
    // This creates a Lambda function and associated IAM role automatically
    new sam.CfnApplication(this, 'DynamoDBConnector', {
      location: {
        applicationId:
          'arn:aws:serverlessrepo:us-east-1:292517598671:applications/AthenaDynamoDBConnector',
        semanticVersion: '2024.53.2',
      },
      parameters: {
        AthenaCatalogName: catalogName,
        SpillBucket: spillBucket.bucketName,
        SpillPrefix: 'athena-spill',
        DisableSpillEncryption: 'false',
        LambdaMemory: '3008',
        LambdaTimeout: '300',
      },
    });

    // Register the connector as an Athena Data Catalog
    new athena.CfnDataCatalog(this, 'DynamoDBCatalog', {
      name: catalogName,
      type: 'LAMBDA',
      description: `CIRL DynamoDB connector for Athena (${envName})`,
      parameters: {
        function: `arn:aws:lambda:${this.region}:${this.account}:function:${catalogName}`,
      },
    });

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'AnalyticsMode', {
      value: 'simple',
      description: 'Analytics mode: simple (DynamoDB federated query) or lakehouse (Glue ETL + S3 Parquet)',
    });

    new cdk.CfnOutput(this, 'AthenaWorkgroupName', {
      value: this.athenaWorkgroup.name!,
      description: 'Athena workgroup for queries',
    });

    new cdk.CfnOutput(this, 'AthenaCatalogName', {
      value: catalogName,
      description: 'Athena catalog name — use this in your BI tool connection',
    });

    new cdk.CfnOutput(this, 'AthenaTableName', {
      value: table.tableName,
      description: 'DynamoDB table name — use as the table in Athena queries',
    });

    new cdk.CfnOutput(this, 'SampleQueries', {
      value: `
-- List recent conversations:
SELECT conversationId, tenantId, startedAt, payload
FROM "${catalogName}"."default"."${table.tableName}"
WHERE PK = 'TENANT#demo#CONV'
  AND entityType = 'CONVERSATION'
LIMIT 20;

-- Query aggregated metrics:
SELECT tenantId, date, metricName, payload
FROM "${catalogName}"."default"."${table.tableName}"
WHERE PK = 'TENANT#demo#AGG#DAY'
  AND entityType = 'AGGREGATE'
LIMIT 50;
      `.trim(),
      description: 'Sample Athena queries for CIRL data',
    });

    new cdk.CfnOutput(this, 'QuickSightSetup', {
      value: `QuickSight Setup (Simple Mode):

1. In QuickSight: Datasets → New dataset → Athena
2. Data source name: CIRL-${envName}
3. Workgroup: ${this.athenaWorkgroup.name}
4. Catalog: ${catalogName}
5. Database: default
6. Table: ${table.tableName}
7. Use Custom SQL to filter by entity type (see SampleQueries output)

Note: QuickSight needs lambda:InvokeFunction permission for the connector.
See docs/06-bi-integration.md for details.`,
      description: 'QuickSight setup instructions for simple mode',
    });

    new cdk.CfnOutput(this, 'UpgradeToLakehouse', {
      value: `To upgrade to lakehouse mode (recommended for >100K conversations/month):
  1. Set CIRL_ANALYTICS=lakehouse in .env
  2. Run: npm run deploy
  3. Run Glue ETL jobs (see AnalyticsStack outputs)
  4. Update BI tools: switch from "${catalogName}" catalog to "cirl_${envName}" Glue database
  5. Switch from DynamoDB PK/SK queries to clean lakehouse_* Parquet tables`,
      description: 'Instructions to upgrade to lakehouse analytics',
    });
  }
}
