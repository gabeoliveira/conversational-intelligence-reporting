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

/**
 * Aggregate metrics for an operator based on its config.
 * Returns true if a config was found and processed, false if no config exists.
 */
export async function aggregateFromConfig(
  tenantId: string,
  date: string,
  operatorName: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const config = getOperatorConfig(operatorName);
  if (!config) return false;

  for (const metric of config.metrics) {
    const value = extractField(payload, metric);
    await aggregateByType(tenantId, date, metric, value);
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
  value: unknown
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
      await aggregateCategoryArray(tenantId, date, metric, value);
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
  value: unknown
): Promise<void> {
  if (!Array.isArray(value)) return;

  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;

    const record = item as Record<string, unknown>;
    const category = record[metric.categoryField] as string;

    if (!category || typeof category !== 'string') continue;

    const normalizedCategory = category.toLowerCase().replace(/\s+/g, '_');
    await incrementMetric(tenantId, date, `${metric.metricPrefix}_${normalizedCategory}`, 1);

    // Combined category + subcategory metric
    if (metric.subcategoryField && metric.subcategoryPrefix) {
      const subcategory = record[metric.subcategoryField] as string;
      if (subcategory && typeof subcategory === 'string') {
        const normalizedCombined = `${category} - ${subcategory}`.toLowerCase().replace(/\s+/g, '_');
        await incrementMetric(tenantId, date, `${metric.subcategoryPrefix}_${normalizedCombined}`, 1);
      }
    }
  }
}
