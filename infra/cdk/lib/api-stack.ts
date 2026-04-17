import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';

export interface ApiStackProps extends cdk.StackProps {
  envName: string;
  rawBucket: s3.Bucket;
  table: dynamodb.Table;
  eventBus: events.EventBus;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly ingestFunction: lambdaNode.NodejsFunction;
  public readonly processorFunction: lambdaNode.NodejsFunction;
  public readonly dashboardFunction: lambdaNode.NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { envName, rawBucket, table, eventBus } = props;

    const servicesRoot = path.join(__dirname, '..', '..', '..', 'services');

    // Load operator fields config from file (passed to API Lambda as env var)
    const configRoot = path.join(__dirname, '..', '..', '..', 'config');
    let operatorFieldsConfig = '';
    try {
      operatorFieldsConfig = fs.readFileSync(path.join(configRoot, 'operator-fields.json'), 'utf-8');
    } catch {
      // Config file not found — Lambda will use its built-in default
    }

    // Common Lambda environment variables
    const commonEnv = {
      CIRL_ENV: envName,
      TABLE_NAME: table.tableName,
      RAW_BUCKET_NAME: rawBucket.bucketName,
      EVENT_BUS_NAME: eventBus.eventBusName,
      NODE_OPTIONS: '--enable-source-maps',
      // Default tenant ID for single-tenant deployments
      ...(process.env.CIRL_TENANT_ID && { CIRL_TENANT_ID: process.env.CIRL_TENANT_ID }),
      // Operator fields config for conversations list enrichment
      ...(operatorFieldsConfig && { OPERATOR_FIELDS_CONFIG: operatorFieldsConfig }),
    };

    // Log groups for Lambdas
    const ingestLogGroup = new logs.LogGroup(this, 'IngestLogGroup', {
      logGroupName: `/aws/lambda/cirl-${envName}-ingest`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const processorLogGroup = new logs.LogGroup(this, 'ProcessorLogGroup', {
      logGroupName: `/aws/lambda/cirl-${envName}-processor`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const dashboardLogGroup = new logs.LogGroup(this, 'DashboardLogGroup', {
      logGroupName: `/aws/lambda/cirl-${envName}-dashboard`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Common bundling options - use local esbuild (no Docker required)
    const bundlingOptions: lambdaNode.BundlingOptions = {
      minify: true,
      sourceMap: true,
      externalModules: ['@aws-sdk/*'],
      forceDockerBundling: false, // Use local esbuild instead of Docker
    };

    // Ingest Lambda environment (includes Twilio credentials for API calls and signature validation)
    const ingestEnv = {
      ...commonEnv,
      // Twilio credentials - required for fetching operator results from Twilio CI API
      // Set via environment variables or SSM for production
      ...(process.env.TWILIO_ACCOUNT_SID && { TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID }),
      ...(process.env.TWILIO_AUTH_TOKEN && { TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN }),
      // Skip signature validation for testing (set SKIP_SIGNATURE_VALIDATION=true)
      ...(process.env.SKIP_SIGNATURE_VALIDATION && { SKIP_SIGNATURE_VALIDATION: process.env.SKIP_SIGNATURE_VALIDATION }),
    };

    // Ingest Lambda - handles webhook, writes to S3, emits event
    this.ingestFunction = new lambdaNode.NodejsFunction(this, 'IngestFunction', {
      functionName: `cirl-${envName}-ingest`,
      entry: path.join(servicesRoot, 'ingest', 'src', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: ingestEnv,
      logGroup: ingestLogGroup,
      bundling: bundlingOptions,
    });

    rawBucket.grantWrite(this.ingestFunction);
    eventBus.grantPutEventsTo(this.ingestFunction);

    // Processor Lambda - triggered by EventBridge, enriches, writes to DynamoDB
    this.processorFunction = new lambdaNode.NodejsFunction(this, 'ProcessorFunction', {
      functionName: `cirl-${envName}-processor`,
      entry: path.join(servicesRoot, 'processor', 'src', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(1),
      environment: commonEnv,
      logGroup: processorLogGroup,
      bundling: bundlingOptions,
    });

    rawBucket.grantRead(this.processorFunction);
    table.grantReadWriteData(this.processorFunction);
    // Grant processor permission to emit events for potential chaining
    eventBus.grantPutEventsTo(this.processorFunction);

    // EventBridge rule to trigger processor
    new events.Rule(this, 'ProcessorRule', {
      eventBus,
      ruleName: `cirl-${envName}-process-payload`,
      eventPattern: {
        source: ['cirl.ingest'],
        detailType: ['PayloadReceived'],
      },
      targets: [new targets.LambdaFunction(this.processorFunction)],
    });

    // Dashboard API Lambda - read APIs for UI
    this.dashboardFunction = new lambdaNode.NodejsFunction(this, 'DashboardFunction', {
      functionName: `cirl-${envName}-dashboard`,
      entry: path.join(servicesRoot, 'api', 'src', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: commonEnv,
      logGroup: dashboardLogGroup,
      bundling: bundlingOptions,
    });

    table.grantReadData(this.dashboardFunction);
    rawBucket.grantRead(this.dashboardFunction);

    // API Gateway
    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `cirl-${envName}`,
      description: 'Conversational Intelligence Reporting Layer API',
      deployOptions: {
        stageName: 'v1',
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id', 'X-Twilio-Signature'],
      },
    });

    // Webhook endpoint
    const webhook = this.api.root.addResource('webhook');
    const ciWebhook = webhook.addResource('ci');
    ciWebhook.addMethod('POST', new apigateway.LambdaIntegration(this.ingestFunction));

    // Dashboard API endpoints
    const tenants = this.api.root.addResource('tenants');
    const tenant = tenants.addResource('{tenantId}');

    // /tenants/{tenantId}/conversations
    const conversations = tenant.addResource('conversations');
    conversations.addMethod('GET', new apigateway.LambdaIntegration(this.dashboardFunction));

    // /tenants/{tenantId}/conversations/{conversationId}
    const conversation = conversations.addResource('{conversationId}');
    conversation.addMethod('GET', new apigateway.LambdaIntegration(this.dashboardFunction));

    // /tenants/{tenantId}/metrics
    const metrics = tenant.addResource('metrics');
    metrics.addMethod('GET', new apigateway.LambdaIntegration(this.dashboardFunction));

    // /tenants/{tenantId}/schemas
    const schemas = tenant.addResource('schemas');
    schemas.addMethod('GET', new apigateway.LambdaIntegration(this.dashboardFunction));

    // /tenants/{tenantId}/schemas/{operatorName}/versions/{version}
    const schemaOperator = schemas.addResource('{operatorName}');
    const schemaVersions = schemaOperator.addResource('versions');
    const schemaVersion = schemaVersions.addResource('{version}');
    schemaVersion.addMethod('GET', new apigateway.LambdaIntegration(this.dashboardFunction));

    // /tenants/{tenantId}/views
    const views = tenant.addResource('views');
    views.addMethod('GET', new apigateway.LambdaIntegration(this.dashboardFunction));
    views.addMethod('POST', new apigateway.LambdaIntegration(this.dashboardFunction));

    // Store API URL in SSM for easy reference
    new ssm.StringParameter(this, 'ApiUrlParameter', {
      parameterName: `/cirl/${envName}/api-url`,
      stringValue: this.api.url,
      description: 'CIRL API Gateway URL',
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'API Gateway URL',
    });

    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `${this.api.url}webhook/ci`,
      description: 'CI Webhook URL - configure this in your CI service',
    });
  }
}
