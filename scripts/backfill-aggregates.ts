/**
 * Backfill Aggregates Script
 *
 * Re-computes aggregated metrics from existing operator results in DynamoDB.
 * Use this when:
 * - A new operator aggregation block was added after data was already ingested
 * - Metrics need recalculation (e.g., after fixing a bug)
 * - You can't retrigger webhooks from Twilio
 *
 * Usage:
 *   npx ts-node scripts/backfill-aggregates.ts
 *
 * Environment variables (loaded from .env.poc or .env):
 *   TABLE_NAME  — DynamoDB table name
 *   AWS_REGION  — AWS region
 *
 * Options (via env vars):
 *   BACKFILL_TENANT   — Tenant ID to backfill (default: CIRL_TENANT_ID from env)
 *   BACKFILL_OPERATOR — Only backfill this operator name (default: all operators)
 *   BACKFILL_DRY_RUN  — Set to "true" to preview without writing (default: false)
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';

// Load env
const envFile = process.env.DOTENV_CONFIG_PATH || path.join(__dirname, '..', '.env');
dotenv.config({ path: envFile });

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'sa-east-1' });
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME || `cirl-${process.env.CIRL_ENV || 'poc'}`;

const TENANT_ID = process.env.BACKFILL_TENANT || process.env.CIRL_TENANT_ID || 'poc-inter';
const OPERATOR_FILTER = process.env.BACKFILL_OPERATOR || null;
const DRY_RUN = process.env.BACKFILL_DRY_RUN === 'true';

// Import the aggregation functions from the processor
// We can't import directly since they use module-level env vars,
// so we inline the metric increment logic here.

interface MetricWrite {
  tenantId: string;
  date: string;
  metricName: string;
  increment: number;
}

const pendingWrites: MetricWrite[] = [];

function queueMetric(tenantId: string, date: string, metricName: string, increment: number) {
  pendingWrites.push({ tenantId, date, metricName, increment });
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0].replace(/-/g, '');
}

/**
 * Aggregation logic — mirrors dynamo.ts updateAggregates but queues writes
 * instead of writing directly. Add new operator blocks here to match the processor.
 */
function computeAggregates(
  tenantId: string,
  operatorName: string,
  payload: Record<string, unknown>,
  receivedAt: string
) {
  const date = formatDate(new Date(receivedAt));

  // operator count (always)
  queueMetric(tenantId, date, `operator_${operatorName}_count`, 1);

  // Analytics operator
  if (operatorName === 'Analytics') {
    const aiRetained = payload.ai_retained;
    if (typeof aiRetained === 'boolean') {
      queueMetric(tenantId, date, 'poc_ai_retained_count', aiRetained ? 1 : 0);
      queueMetric(tenantId, date, 'poc_ai_not_retained_count', aiRetained ? 0 : 1);
      queueMetric(tenantId, date, 'poc_ai_retained_total', 1);
    }

    const topic = payload.topic as string;
    if (topic && typeof topic === 'string') {
      queueMetric(tenantId, date, `poc_topic_${topic.toLowerCase()}`, 1);
    }

    const backToIvr = payload.back_to_ivr;
    if (typeof backToIvr === 'boolean' && backToIvr) {
      queueMetric(tenantId, date, 'poc_back_to_ivr_count', 1);
    }

    const askedForHuman = payload.asked_for_human;
    if (typeof askedForHuman === 'boolean' && askedForHuman) {
      queueMetric(tenantId, date, 'poc_asked_for_human_count', 1);
    }

    const inferredCsat = payload.inferred_csat as number;
    if (typeof inferredCsat === 'number' && inferredCsat >= 1 && inferredCsat <= 5) {
      queueMetric(tenantId, date, 'poc_csat_sum', inferredCsat);
      queueMetric(tenantId, date, 'poc_csat_count', 1);
      queueMetric(tenantId, date, `poc_csat_${inferredCsat}`, 1);
    }

    const errors = payload.errors;
    if (typeof errors === 'boolean' && errors) {
      queueMetric(tenantId, date, 'poc_errors_count', 1);
    }
  }

  // General KPIs operator
  if (operatorName === 'MVP - Inter - General KPIs') {
    const intMetrics = [
      { field: 'precisao', metric: 'kpi_precisao' },
      { field: 'cobertura_conhecimento', metric: 'kpi_cobertura_conhecimento' },
      { field: 'alucinacoes', metric: 'kpi_alucinacoes' },
      { field: 'compreensao', metric: 'kpi_compreensao' },
      { field: 'aderencia', metric: 'kpi_aderencia' },
    ];

    for (const { field, metric } of intMetrics) {
      const value = payload[field] as number;
      if (typeof value === 'number') {
        queueMetric(tenantId, date, `${metric}_sum`, value);
        queueMetric(tenantId, date, `${metric}_count`, 1);
      }
    }

    const desambiguador = payload.desambiguador;
    if (typeof desambiguador === 'boolean' && desambiguador) {
      queueMetric(tenantId, date, 'kpi_desambiguador_count', 1);
    }
    if (typeof desambiguador === 'boolean') {
      queueMetric(tenantId, date, 'kpi_desambiguador_total', 1);
    }
  }
}

/**
 * Read all operator results for a tenant from DynamoDB.
 * Operator results have PK = TENANT#{tenantId}#CONV#{conversationId}, SK starts with OP#
 */
async function fetchAllOperatorResults(): Promise<Array<{
  operatorName: string;
  receivedAt: string;
  enrichedPayload: Record<string, unknown>;
}>> {
  const results: Array<{
    operatorName: string;
    receivedAt: string;
    enrichedPayload: Record<string, unknown>;
  }> = [];

  // First get all conversations to find their IDs
  let lastKey: Record<string, unknown> | undefined;
  const conversationIds: string[] = [];

  do {
    const params: QueryCommandInput = {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${TENANT_ID}#CONV`,
      },
      ExclusiveStartKey: lastKey,
    };

    const result = await docClient.send(new QueryCommand(params));
    for (const item of result.Items || []) {
      if (item.conversationId) {
        conversationIds.push(item.conversationId as string);
      }
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  console.log(`Found ${conversationIds.length} conversations`);

  // For each conversation, get operator results
  for (const convId of conversationIds) {
    let opLastKey: Record<string, unknown> | undefined;

    do {
      const params: QueryCommandInput = {
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': `TENANT#${TENANT_ID}#CONV#${convId}`,
          ':skPrefix': 'OP#',
        },
        ExclusiveStartKey: opLastKey,
      };

      const result = await docClient.send(new QueryCommand(params));
      for (const item of result.Items || []) {
        const operatorName = item.operatorName as string;

        // Skip if filtering by operator and this isn't it
        if (OPERATOR_FILTER && operatorName !== OPERATOR_FILTER) continue;

        const payloadStr = item.payload as string;
        if (!payloadStr) continue;

        try {
          const parsedPayload = JSON.parse(payloadStr);
          const enrichedPayload = parsedPayload.enrichedPayload || {};

          results.push({
            operatorName,
            receivedAt: item.receivedAt as string || new Date().toISOString(),
            enrichedPayload,
          });
        } catch {
          console.warn(`Failed to parse payload for ${convId}/${operatorName}`);
        }
      }
      opLastKey = result.LastEvaluatedKey;
    } while (opLastKey);
  }

  return results;
}

/**
 * Write queued metrics to DynamoDB
 */
async function flushMetrics() {
  // Consolidate: sum up increments for the same metric+date
  const consolidated = new Map<string, MetricWrite>();
  for (const write of pendingWrites) {
    const key = `${write.tenantId}|${write.date}|${write.metricName}`;
    const existing = consolidated.get(key);
    if (existing) {
      existing.increment += write.increment;
    } else {
      consolidated.set(key, { ...write });
    }
  }

  console.log(`Writing ${consolidated.size} consolidated metrics...`);

  const { UpdateCommand, GetCommand } = await import('@aws-sdk/lib-dynamodb');

  let written = 0;
  for (const [, write] of consolidated) {
    if (DRY_RUN) {
      console.log(`  [DRY RUN] ${write.date} | ${write.metricName} = +${write.increment}`);
      continue;
    }

    const pk = `TENANT#${write.tenantId}#AGG#DAY`;
    const sk = `DAY#${write.date}#METRIC#${write.metricName}`;

    // Read current value
    let currentValue = 0;
    try {
      const existing = await docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { PK: pk, SK: sk },
          ProjectionExpression: 'payload',
        })
      );
      if (existing.Item?.payload) {
        currentValue = JSON.parse(existing.Item.payload as string).value || 0;
      }
    } catch {
      // doesn't exist yet
    }

    const newValue = currentValue + write.increment;

    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: pk, SK: sk },
        UpdateExpression: 'SET entityType = :entityType, metricName = :metricName, #date = :date, tenantId = :tenantId, payload = :payload',
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: {
          ':entityType': 'AGGREGATE',
          ':metricName': write.metricName,
          ':date': write.date,
          ':tenantId': write.tenantId,
          ':payload': JSON.stringify({ value: newValue }),
        },
      })
    );

    written++;
    if (written % 50 === 0) {
      console.log(`  Written ${written}/${consolidated.size}...`);
    }
  }

  console.log(`Done! Written ${written} metrics.`);
}

async function main() {
  console.log(`=== Backfill Aggregates ===`);
  console.log(`Table: ${TABLE_NAME}`);
  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`Operator filter: ${OPERATOR_FILTER || '(all)'}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log('');

  const operatorResults = await fetchAllOperatorResults();
  console.log(`Found ${operatorResults.length} operator results to process`);

  if (operatorResults.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  // Compute aggregates for each result
  for (const result of operatorResults) {
    computeAggregates(TENANT_ID, result.operatorName, result.enrichedPayload, result.receivedAt);
  }

  console.log(`Queued ${pendingWrites.length} metric increments`);

  // Write to DynamoDB
  await flushMetrics();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
