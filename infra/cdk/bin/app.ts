#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { StorageStack } from '../lib/storage-stack';
import { ApiStack } from '../lib/api-stack';
import { AnalyticsStack } from '../lib/analytics-stack';
import { SimpleAnalyticsStack } from '../lib/simple-analytics-stack';

// Load environment variables from project root
// Supports env-specific files: .env.poc, .env.dev, etc.
// Priority: .env.{CIRL_ENV || context.env} > .env (fallback)
const projectRoot = path.join(__dirname, '..', '..', '..');

// Peek at CDK context to determine which env file to load
const tempApp = new cdk.App();
const contextEnv = tempApp.node.tryGetContext('env');

const envName = contextEnv || process.env.CIRL_ENV;
if (envName) {
  const envSpecificPath = path.join(projectRoot, `.env.${envName}`);
  const result = dotenv.config({ path: envSpecificPath });
  if (result.error) {
    // Fall back to default .env
    dotenv.config({ path: path.join(projectRoot, '.env') });
  }
} else {
  dotenv.config({ path: path.join(projectRoot, '.env') });
}

const app = new cdk.App();

const env = app.node.tryGetContext('env') || process.env.CIRL_ENV || 'dev';
const stackPrefix = `Cirl${env.charAt(0).toUpperCase() + env.slice(1)}`;

// Analytics mode: "simple" (DynamoDB federated query) or "lakehouse" (Glue ETL + S3 Parquet)
// Default: simple — fewer moving parts, zero operational overhead
const analyticsMode =
  app.node.tryGetContext('analytics') || process.env.CIRL_ANALYTICS || 'simple';

if (analyticsMode !== 'simple' && analyticsMode !== 'lakehouse') {
  throw new Error(
    `Invalid CIRL_ANALYTICS value: "${analyticsMode}". Must be "simple" or "lakehouse".`
  );
}

const storageStack = new StorageStack(app, `${stackPrefix}StorageStack`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  envName: env,
});

new ApiStack(app, `${stackPrefix}ApiStack`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  envName: env,
  rawBucket: storageStack.rawBucket,
  table: storageStack.table,
  eventBus: storageStack.eventBus,
});

if (analyticsMode === 'lakehouse') {
  new AnalyticsStack(app, `${stackPrefix}AnalyticsStack`, {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
    envName: env,
    rawBucket: storageStack.rawBucket,
    table: storageStack.table,
    encryptionKey: storageStack.encryptionKey,
  });
} else {
  new SimpleAnalyticsStack(app, `${stackPrefix}SimpleAnalyticsStack`, {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
    envName: env,
    table: storageStack.table,
    encryptionKey: storageStack.encryptionKey,
  });
}

app.synth();
