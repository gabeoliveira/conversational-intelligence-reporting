/**
 * Seed demo data into DynamoDB and S3
 *
 * Usage: npm run demo:seed
 *
 * Prerequisites:
 * - AWS credentials configured
 * - Stack deployed (npm run deploy:demo)
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from project root
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import * as fs from 'fs';

const ENV = process.env.CIRL_ENV || 'demo';
const TENANT_ID = 'demo';

async function main() {
  console.log(`Seeding demo data for environment: ${ENV}`);

  // Get resource names from SSM or construct them
  const region = process.env.AWS_REGION || 'us-east-1';
  const account = process.env.AWS_ACCOUNT_ID || (await getAccountId());

  const tableName = `cirl-${ENV}`;
  const bucketName = `cirl-raw-${ENV}-${account}-${region}`;

  console.log(`Table: ${tableName}`);
  console.log(`Bucket: ${bucketName}`);

  const dynamoClient = new DynamoDBClient({});
  const docClient = DynamoDBDocumentClient.from(dynamoClient);
  const s3Client = new S3Client({});

  // Load seed data
  const configPath = path.join(__dirname, '..', 'config');
  const conversations = JSON.parse(
    fs.readFileSync(path.join(configPath, 'demo-data', 'seed-conversations.json'), 'utf-8')
  ).conversations;

  const operatorResults = JSON.parse(
    fs.readFileSync(path.join(configPath, 'demo-data', 'seed-operator-results.json'), 'utf-8')
  ).operatorResults;

  // Load and seed schemas
  console.log('\nSeeding schemas...');
  const schemasDir = path.join(configPath, 'schemas');
  for (const operatorDir of fs.readdirSync(schemasDir)) {
    const schemaPath = path.join(schemasDir, operatorDir);
    if (!fs.statSync(schemaPath).isDirectory()) continue;

    for (const schemaFile of fs.readdirSync(schemaPath)) {
      if (!schemaFile.endsWith('.schema.json')) continue;

      const version = schemaFile.replace('.schema.json', '');
      const schema = JSON.parse(fs.readFileSync(path.join(schemaPath, schemaFile), 'utf-8'));

      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: `TENANT#${TENANT_ID}#SCHEMA`,
            SK: `OP#${operatorDir}#V#${version}`,
            operatorName: operatorDir,
            schemaVersion: version,
            jsonSchema: schema,
            status: 'active',
            createdAt: new Date().toISOString(),
            entityType: 'SCHEMA',
          },
        })
      );
      console.log(`  ✓ Schema: ${operatorDir}/${version}`);
    }
  }

  // Load and seed view configs
  console.log('\nSeeding view configs...');
  const viewsDir = path.join(configPath, 'views');
  for (const operatorDir of fs.readdirSync(viewsDir)) {
    const viewPath = path.join(viewsDir, operatorDir);
    if (!fs.statSync(viewPath).isDirectory()) continue;

    for (const viewFile of fs.readdirSync(viewPath)) {
      if (!viewFile.endsWith('.view.json')) continue;

      const version = viewFile.replace('.view.json', '');
      const view = JSON.parse(fs.readFileSync(path.join(viewPath, viewFile), 'utf-8'));

      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: `TENANT#${TENANT_ID}#VIEW`,
            SK: `OP#${operatorDir}#V#${version}`,
            ...view,
            tenantId: TENANT_ID,
            createdAt: new Date().toISOString(),
            entityType: 'VIEW',
          },
        })
      );
      console.log(`  ✓ View: ${operatorDir}/${version}`);
    }
  }

  // Seed conversations
  console.log('\nSeeding conversations...');
  for (const conv of conversations) {
    const timestamp = formatTimestamp(new Date(conv.startedAt));

    // Build GSI keys
    const gsiKeys: Record<string, string> = {};
    if (conv.agentId) {
      gsiKeys.GSI1PK = `TENANT#${TENANT_ID}#AGENT#${conv.agentId}`;
      gsiKeys.GSI1SK = `TS#${timestamp}#CONV#${conv.conversationId}`;
    }
    if (conv.queueId) {
      gsiKeys.GSI2PK = `TENANT#${TENANT_ID}#QUEUE#${conv.queueId}`;
      gsiKeys.GSI2SK = `TS#${timestamp}`;
    }
    if (conv.customerKey) {
      gsiKeys.GSI3PK = `TENANT#${TENANT_ID}#CK#${conv.customerKey}`;
      gsiKeys.GSI3SK = `TS#${timestamp}`;
    }

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `TENANT#${TENANT_ID}#CONV`,
          SK: `TS#${timestamp}#CONV#${conv.conversationId}`,
          ...conv,
          tenantId: TENANT_ID,
          operatorCount: operatorResults.filter((r: any) => r.conversationId === conv.conversationId).length,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          entityType: 'CONVERSATION',
          ...gsiKeys,
        },
      })
    );
    console.log(`  ✓ Conversation: ${conv.conversationId}`);
  }

  // Seed operator results
  console.log('\nSeeding operator results...');
  for (const result of operatorResults) {
    const conv = conversations.find((c: any) => c.conversationId === result.conversationId);
    const timestamp = formatTimestamp(new Date(conv?.startedAt || new Date()));

    // Write to S3
    const date = new Date(conv?.startedAt || new Date()).toISOString().split('T')[0];
    const s3Key = `${TENANT_ID}/${result.operatorName}/${result.schemaVersion}/${date}/${result.conversationId}-${timestamp}.json`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        Body: JSON.stringify(result, null, 2),
        ContentType: 'application/json',
      })
    );

    // Write to DynamoDB
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `TENANT#${TENANT_ID}#CONV#${result.conversationId}`,
          SK: `OP#${result.operatorName}#V#${result.schemaVersion}#TS#${timestamp}`,
          conversationId: result.conversationId,
          tenantId: TENANT_ID,
          operatorName: result.operatorName,
          schemaVersion: result.schemaVersion,
          s3Uri: `s3://${bucketName}/${s3Key}`,
          displayFields: extractDisplayFields(result.data),
          enrichedPayload: result.data,
          receivedAt: conv?.startedAt || new Date().toISOString(),
          entityType: 'OPERATOR_RESULT',
        },
      })
    );
    console.log(`  ✓ Operator result: ${result.conversationId}/${result.operatorName}`);
  }

  // Seed aggregates
  console.log('\nSeeding aggregates...');
  const dateSet = new Set<string>();
  for (const c of conversations) {
    dateSet.add(formatDate(new Date(c.startedAt)));
  }
  const dates = Array.from(dateSet);

  for (const date of dates) {
    const dayConversations = conversations.filter(
      (c: any) => formatDate(new Date(c.startedAt)) === date
    );

    // Conversation count
    await putAggregate(docClient, tableName, TENANT_ID, date, 'conversation_count', dayConversations.length);

    // Sentiment metrics
    const sentimentResults = operatorResults.filter(
      (r: any) =>
        r.operatorName === 'sentiment' &&
        dayConversations.some((c: any) => c.conversationId === r.conversationId)
    );

    const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
    let sentimentSum = 0;

    for (const result of sentimentResults) {
      const sentiment = result.data.overall_sentiment as keyof typeof sentimentCounts;
      if (sentiment in sentimentCounts) {
        sentimentCounts[sentiment]++;
      }
      sentimentSum += result.data.sentiment_score || 0;
    }

    await putAggregate(docClient, tableName, TENANT_ID, date, 'sentiment_positive', sentimentCounts.positive);
    await putAggregate(docClient, tableName, TENANT_ID, date, 'sentiment_neutral', sentimentCounts.neutral);
    await putAggregate(docClient, tableName, TENANT_ID, date, 'sentiment_negative', sentimentCounts.negative);
    await putAggregate(docClient, tableName, TENANT_ID, date, 'sentiment_score_sum', sentimentSum);
    await putAggregate(docClient, tableName, TENANT_ID, date, 'sentiment_score_count', sentimentResults.length);

    console.log(`  ✓ Aggregates for ${date}`);
  }

  console.log('\n✅ Demo data seeded successfully!');
}

async function putAggregate(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  tenantId: string,
  date: string,
  metricName: string,
  value: number
) {
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: `TENANT#${tenantId}#AGG#DAY`,
        SK: `DAY#${date}#METRIC#${metricName}`,
        tenantId,
        date,
        metricName,
        value,
        entityType: 'AGGREGATE',
      },
    })
  );
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '').split('.')[0];
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0].replace(/-/g, '');
}

function extractDisplayFields(data: Record<string, unknown>): Record<string, unknown> {
  const displayFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (Array.isArray(value) && value.length <= 5 && value.every(v => typeof v === 'string'))
    ) {
      displayFields[key] = value;
    }
  }
  return displayFields;
}

async function getAccountId(): Promise<string> {
  if (process.env.AWS_ACCOUNT_ID) {
    return process.env.AWS_ACCOUNT_ID;
  }

  try {
    const stsClient = new STSClient({});
    const response = await stsClient.send(new GetCallerIdentityCommand({}));
    return response.Account || '123456789012';
  } catch {
    console.warn('Could not get AWS account ID from STS, using placeholder');
    return '123456789012';
  }
}

main().catch(console.error);
