#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { StorageStack } from '../lib/storage-stack';
import { ApiStack } from '../lib/api-stack';

// Load .env from project root
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const app = new cdk.App();

const env = app.node.tryGetContext('env') || process.env.CIRL_ENV || 'dev';
const stackPrefix = `Cirl${env.charAt(0).toUpperCase() + env.slice(1)}`;

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

app.synth();
