/**
 * Config-driven aggregation engine.
 *
 * Reads operator config and aggregates metrics based on primitive types.
 * Replaces the hardcoded per-operator blocks in dynamo.ts.
 *
 * Usage:
 *   import { aggregateFromConfig } from './aggregation-engine';
 *   await aggregateFromConfig(tenantId, date, operatorName, payload);
 */

import type {
  OperatorConfig,
  MetricDefinition,
  BooleanMetric,
  IntegerMetric,
  CategoryMetric,
  EnumMetric,
  CategoryArrayMetric,
} from '@cirl/shared';
import { getOperatorConfig } from '@cirl/shared';

// Import incrementMetric from dynamo.ts — shared write function
import { incrementMetric } from './dynamo';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const indexClient = new DynamoDBClient({});
const indexDocClient = DynamoDBDocumentClient.from(indexClient);
const TABLE_NAME = process.env.TABLE_NAME!;

const INDEX_TTL_DAYS = 180;

/**
 * Aggregate metrics for an operator based on its config.
 * Also writes index records for fields marked surfaceInList.
 * Returns true if a config was found and processed, false if no config exists.
 */
export async function aggregateFromConfig(
  tenantId: string,
  date: string,
  operatorName: string,
  conversationId: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const config = getOperatorConfig(operatorName);
  if (!config) return false;

  for (const metric of config.metrics) {
    const value = extractField(payload, metric);
    await aggregateByType(tenantId, date, metric, value, conversationId);

    // Write index record for scalar surfaceInList fields.
    // category_array is handled inside aggregateCategoryArray (one record per primary item).
    if (
      metric.surfaceInList &&
      metric.type !== 'category_array' &&
      value !== undefined &&
      value !== null
    ) {
      await writeIndexRecord(tenantId, metric.field, String(value), conversationId, date);
    }
  }

  return true;
}

/**
 * Extract the field value from the payload.
 * For category_array, returns the array itself.
 * For nested fields (dot notation), traverses the object.
 */
function extractField(payload: Record<string, unknown>, metric: MetricDefinition): unknown {
  const parts = metric.field.split('.');
  let current: unknown = payload;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Dispatch to the appropriate aggregation handler based on metric type.
 */
async function aggregateByType(
  tenantId: string,
  date: string,
  metric: MetricDefinition,
  value: unknown,
  conversationId: string
): Promise<void> {
  switch (metric.type) {
    case 'boolean':
      await aggregateBoolean(tenantId, date, metric, value);
      break;
    case 'integer':
    case 'number':
      await aggregateInteger(tenantId, date, metric, value);
      break;
    case 'category':
      await aggregateCategory(tenantId, date, metric, value);
      break;
    case 'enum':
      await aggregateEnum(tenantId, date, metric, value);
      break;
    case 'category_array':
      await aggregateCategoryArray(tenantId, date, metric, value, conversationId);
      break;
  }
}

/**
 * Boolean: tracks count (when true) and total (always).
 * Derives: {prefix}_rate_percent = count / total * 100
 */
async function aggregateBoolean(
  tenantId: string,
  date: string,
  metric: BooleanMetric,
  value: unknown
): Promise<void> {
  if (typeof value !== 'boolean') return;

  if (value) {
    await incrementMetric(tenantId, date, `${metric.metricPrefix}_count`, 1);
  }
  await incrementMetric(tenantId, date, `${metric.metricPrefix}_total`, 1);
}

/**
 * Integer/Number: tracks sum and count, with optional distribution.
 * Derives: {prefix}_avg = sum / count
 */
async function aggregateInteger(
  tenantId: string,
  date: string,
  metric: IntegerMetric,
  value: unknown
): Promise<void> {
  if (typeof value !== 'number') return;

  // Sanity check min/max
  if (metric.min !== undefined && value < metric.min) return;
  if (metric.max !== undefined && value > metric.max) return;

  await incrementMetric(tenantId, date, `${metric.metricPrefix}_sum`, value);
  await incrementMetric(tenantId, date, `${metric.metricPrefix}_count`, 1);

  // Optional: track per-value distribution (e.g., CSAT 1, CSAT 2, ...)
  if (metric.distribution) {
    await incrementMetric(tenantId, date, `${metric.metricPrefix}_${value}`, 1);
  }
}

/**
 * Category: tracks count per distinct value (free-text, normalized).
 */
async function aggregateCategory(
  tenantId: string,
  date: string,
  metric: CategoryMetric,
  value: unknown
): Promise<void> {
  if (typeof value !== 'string' || !value) return;

  const normalized = value.toLowerCase().replace(/\s+/g, '_');
  await incrementMetric(tenantId, date, `${metric.metricPrefix}_${normalized}`, 1);
}

/**
 * Enum: tracks count per value and total. Skips ignored values.
 * Derives: {prefix}_{value}_rate_percent = value_count / denominator * 100
 */
async function aggregateEnum(
  tenantId: string,
  date: string,
  metric: EnumMetric,
  value: unknown
): Promise<void> {
  if (typeof value !== 'string') return;

  // Skip ignored values (e.g., "NONE")
  if (metric.ignoreValues?.includes(value)) return;

  const normalized = value.toLowerCase().replace(/\s+/g, '_');
  await incrementMetric(tenantId, date, `${metric.metricPrefix}_${normalized}`, 1);
  await incrementMetric(tenantId, date, `${metric.metricPrefix}_total`, 1);
}

/**
 * CategoryArray: loops over array items, tracks category + subcategory per item.
 */
async function aggregateCategoryArray(
  tenantId: string,
  date: string,
  metric: CategoryArrayMetric,
  value: unknown,
  conversationId: string
): Promise<void> {
  if (!Array.isArray(value)) return;

  const seenCategories = new Set<string>();

  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;

    const record = item as Record<string, unknown>;
    const category = record[metric.categoryField] as string;

    if (!category || typeof category !== 'string') continue;

    const normalizedCategory = category.toLowerCase().replace(/\s+/g, '_');
    await incrementMetric(tenantId, date, `${metric.metricPrefix}_${normalizedCategory}`, 1);

    // Index by primary category (deduped — one conversation can carry the same
    // category multiple times via different subcategories).
    if (metric.surfaceInList && !seenCategories.has(normalizedCategory)) {
      seenCategories.add(normalizedCategory);
      await writeIndexRecord(tenantId, metric.categoryField, category, conversationId, date);
    }

    // Combined category + subcategory metric
    if (metric.subcategoryField && metric.subcategoryPrefix) {
      const subcategory = record[metric.subcategoryField] as string;
      if (subcategory && typeof subcategory === 'string') {
        const normalizedCombined = `${category} - ${subcategory}`.toLowerCase().replace(/\s+/g, '_');
        await incrementMetric(tenantId, date, `${metric.subcategoryPrefix}_${normalizedCombined}`, 1);

        // Combined index record (primary + subtopic) for paired drill-down.
        // Field name is the subcategoryField so the API can resolve
        // `?primary_topic=X&subtopic=Y` by synthesizing the same value.
        if (metric.surfaceInList) {
          const comboValue = `${category}__${subcategory}`;
          await writeIndexRecord(tenantId, metric.subcategoryField, comboValue, conversationId, date);
        }
      }
    }
  }
}

/**
 * Write a denormalized index record for drill-down queries.
 * Enables O(1) lookup: "all conversations where fieldName = fieldValue"
 *
 * PK: TENANT#{tenantId}#IDX#{fieldName}#{normalizedValue}
 * SK: TS#{timestamp}#CONV#{conversationId}
 */
async function writeIndexRecord(
  tenantId: string,
  fieldName: string,
  fieldValue: string,
  conversationId: string,
  timestamp: string
): Promise<void> {
  const normalizedValue = fieldValue.toLowerCase().replace(/\s+/g, '_');
  const ttl = Math.floor(Date.now() / 1000) + INDEX_TTL_DAYS * 86400;

  await indexDocClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${tenantId}#IDX#${fieldName}#${normalizedValue}`,
      SK: `TS#${timestamp}#CONV#${conversationId}`,
      tenantId,
      conversationId,
      fieldName,
      fieldValue: normalizedValue,
      entityType: 'INDEX',
      ttl,
    },
  }));
}
