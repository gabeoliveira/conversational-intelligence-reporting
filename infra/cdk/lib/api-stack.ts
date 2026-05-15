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
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';

export interface ApiStackProps extends cdk.StackProps {
  envName: string;
  authMode: 'none' | 'apikey';
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

    const { envName, authMode, rawBucket, table, eventBus } = props;

    const servicesRoot = path.join(__dirname, '..', '..', '..', 'services');

    // Deploy operator config files to S3 for Lambda runtime access
    const configRoot = path.join(__dirname, '..', '..', '..', 'config');
    const configDeployment = new s3deploy.BucketDeployment(this, 'OperatorConfigs', {
      sources: [
        s3deploy.Source.asset(configRoot, {
          exclude: ['schemas/**', 'demo-data/**'],
        }),
      ],
      destinationBucket: rawBucket,
      destinationKeyPrefix: 'config/',
      retainOnDelete: false,
    });

    // Common Lambda environment variables
    // Config S3 paths (Lambdas read these at cold start)
    const configBucket = rawBucket.bucketName;
    const configPrefix = 'config/';

    const commonEnv = {
      CIRL_ENV: envName,
      TABLE_NAME: table.tableName,
      RAW_BUCKET_NAME: configBucket,
      EVENT_BUS_NAME: eventBus.eventBusName,
      NODE_OPTIONS: '--enable-source-maps',
      // Config location in S3
      CONFIG_BUCKET: configBucket,
      CONFIG_PREFIX: configPrefix,
      // Default tenant ID for single-tenant deployments
      ...(process.env.CIRL_TENANT_ID && { CIRL_TENANT_ID: process.env.CIRL_TENANT_ID }),
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
      runtime: lambda.Runtime.NODEJS_22_X,
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
      runtime: lambda.Runtime.NODEJS_22_X,
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
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      // Bound the blast radius: even an unauthenticated flood can't spawn more
      // than 50 concurrent dashboard Lambdas, which caps Lambda + downstream
      // DDB cost. Tune up if 3-user real load ever runs into 429s.
      reservedConcurrentExecutions: 50,
      environment: commonEnv,
      logGroup: dashboardLogGroup,
      bundling: bundlingOptions,
    });

    table.grantReadData(this.dashboardFunction);
    rawBucket.grantRead(this.dashboardFunction);

    // API Gateway
    const requireApiKey = authMode === 'apikey';

    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `cirl-${envName}`,
      description: 'Conversational Intelligence Reporting Layer API',
      deployOptions: {
        stageName: 'v1',
        // Stage-level throttle applies whether or not API keys are required.
        // Tightened for the open-API testing window — generous for 3 dashboard
        // users (Grafana fires panel queries near-simultaneously, hence the
        // burst headroom), and any sustained excess gets 429 Too Many Requests.
        throttlingBurstLimit: 50,
        throttlingRateLimit: 20,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id', 'X-Twilio-Signature', 'x-api-key'],
      },
    });

    // API key authentication (when CIRL_AUTH=apikey)
    let apiKeyMethodOptions: apigateway.MethodOptions = {};
    if (requireApiKey) {
      const apiKey = this.api.addApiKey('ApiKey', {
        apiKeyName: `cirl-${envName}-key`,
        description: `API key for CIRL ${envName} environment`,
      });

      const usagePlan = this.api.addUsagePlan('UsagePlan', {
        name: `cirl-${envName}-usage-plan`,
        description: `Usage plan for CIRL ${envName}`,
        throttle: {
          rateLimit: 50,
          burstLimit: 100,
        },
        apiStages: [{
          api: this.api,
          stage: this.api.deploymentStage,
        }],
      });

      usagePlan.addApiKey(apiKey);

      // Method options that require API key — applied to dashboard endpoints only
      apiKeyMethodOptions = {
        apiKeyRequired: true,
      };
    }

    // Webhook endpoint — NO API key required (Twilio needs to POST freely)
    const webhook = this.api.root.addResource('webhook');
    const ciWebhook = webhook.addResource('ci');
    ciWebhook.addMethod('POST', new apigateway.LambdaIntegration(this.ingestFunction));

    // Dashboard API endpoints — API key required when authMode=apikey
    const dashboardIntegration = new apigateway.LambdaIntegration(this.dashboardFunction);
    const tenants = this.api.root.addResource('tenants');
    const tenant = tenants.addResource('{tenantId}');

    // /tenants/{tenantId}/conversations
    const conversations = tenant.addResource('conversations');
    conversations.addMethod('GET', dashboardIntegration, apiKeyMethodOptions);

    // /tenants/{tenantId}/conversations/{conversationId}
    const conversation = conversations.addResource('{conversationId}');
    conversation.addMethod('GET', dashboardIntegration, apiKeyMethodOptions);

    // /tenants/{tenantId}/metrics
    const metrics = tenant.addResource('metrics');
    metrics.addMethod('GET', dashboardIntegration, apiKeyMethodOptions);

    // /tenants/{tenantId}/schemas
    const schemas = tenant.addResource('schemas');
    schemas.addMethod('GET', dashboardIntegration, apiKeyMethodOptions);

    // /tenants/{tenantId}/schemas/{operatorName}/versions/{version}
    const schemaOperator = schemas.addResource('{operatorName}');
    const schemaVersions = schemaOperator.addResource('versions');
    const schemaVersion = schemaVersions.addResource('{version}');
    schemaVersion.addMethod('GET', dashboardIntegration, apiKeyMethodOptions);

    // /tenants/{tenantId}/views
    const views = tenant.addResource('views');
    views.addMethod('GET', dashboardIntegration, apiKeyMethodOptions);
    views.addMethod('POST', dashboardIntegration, apiKeyMethodOptions);

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

    new cdk.CfnOutput(this, 'AuthMode', {
      value: authMode,
      description: 'API authentication mode (none or apikey)',
    });

    if (requireApiKey) {
      new cdk.CfnOutput(this, 'ApiKeyName', {
        value: `cirl-${envName}-key`,
        description: 'API key name — retrieve the key value with: aws apigateway get-api-keys --name-query cirl-{env}-key --include-values',
      });
    }
  }
}
