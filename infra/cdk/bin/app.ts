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
// The DOTENV_CONFIG_PATH env var (set by deploy scripts) controls which file to load.
// Falls back to .env if not set.
const projectRoot = path.join(__dirname, '..', '..', '..');
const envFilePath = process.env.DOTENV_CONFIG_PATH || path.join(projectRoot, '.env');
dotenv.config({ path: envFilePath });

const app = new cdk.App();

const env = app.node.tryGetContext('env') || process.env.CIRL_ENV || 'dev';
const stackPrefix = `Cirl${env.charAt(0).toUpperCase() + env.slice(1)}`;

// Analytics mode:
//   "none"      — No Athena/analytics stack. REST API only (Grafana, Metabase, custom).
//   "simple"    — Athena DynamoDB Connector. SQL-based BI tools query DynamoDB directly.
//   "lakehouse" — Glue ETL + S3 Parquet. Best for heavy analytics.
// Default: none — just the API, no extra infrastructure.
const analyticsMode =
  app.node.tryGetContext('analytics') || process.env.CIRL_ANALYTICS || 'none';

if (!['none', 'simple', 'lakehouse'].includes(analyticsMode)) {
  throw new Error(
    `Invalid CIRL_ANALYTICS value: "${analyticsMode}". Must be "none", "simple", or "lakehouse".`
  );
}

// Auth mode: "none" (default) or "apikey"
const authMode = (
  app.node.tryGetContext('auth') || process.env.CIRL_AUTH || 'none'
) as 'none' | 'apikey';

if (!['none', 'apikey'].includes(authMode)) {
  throw new Error(
    `Invalid CIRL_AUTH value: "${authMode}". Must be "none" or "apikey".`
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
  authMode,
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
} else if (analyticsMode === 'simple') {
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
// analyticsMode === 'none': no analytics stack — REST API only

app.synth();
