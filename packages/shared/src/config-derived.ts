/**
 * Config-driven derived metrics, display names, and dependency maps.
 *
 * Generates all the metadata that the API needs from the operator config,
 * replacing hardcoded maps in metrics.ts.
 */

import type {
  OperatorConfig,
  MetricDefinition,
  BooleanMetric,
  IntegerMetric,
  EnumMetric,
  CategoryArrayMetric,
} from './operator-config';
import { getAllOperatorConfigs } from './config-loader';

// Cached results — rebuilt when config changes
let cachedDependencies: Record<string, string[]> | null = null;
let cachedDisplayNames: Record<string, string> | null = null;

/**
 * Build the derived metric dependency map from config.
 * Maps derived metric names to the raw metrics needed to compute them.
 *
 * Example: { 'poc_csat_avg': ['poc_csat_sum', 'poc_csat_count'] }
 */
export function buildDerivedMetricDependencies(): Record<string, string[]> {
  if (cachedDependencies) return cachedDependencies;

  const map: Record<string, string[]> = {};
  const configs = getAllOperatorConfigs();

  for (const config of configs) {
    for (const metric of config.metrics) {
      switch (metric.type) {
        case 'boolean': {
          const m = metric as BooleanMetric;
          map[`${m.metricPrefix}_rate_percent`] = [
            `${m.metricPrefix}_count`,
            `${m.metricPrefix}_total`,
          ];
          break;
        }
        case 'integer':
        case 'number': {
          const m = metric as IntegerMetric;
          map[`${m.metricPrefix}_avg`] = [
            `${m.metricPrefix}_sum`,
            `${m.metricPrefix}_count`,
          ];
          break;
        }
        case 'enum': {
          const m = metric as EnumMetric;
          const denominator = m.rateDenominator || `${m.metricPrefix}_total`;
          const values = m.values.filter(v => !m.ignoreValues?.includes(v));
          for (const value of values) {
            const normalized = value.toLowerCase().replace(/\s+/g, '_');
            map[`${m.metricPrefix}_${normalized}_rate_percent`] = [
              `${m.metricPrefix}_${normalized}`,
              denominator,
            ];
          }
          break;
        }
        // category and category_array don't have derived metrics
      }
    }
  }

  cachedDependencies = map;
  return map;
}

/**
 * Build display name map from config.
 * Maps internal metric names to human-friendly labels.
 */
export function buildDisplayNames(): Record<string, string> {
  if (cachedDisplayNames) return cachedDisplayNames;

  const names: Record<string, string> = {};
  const configs = getAllOperatorConfigs();

  for (const config of configs) {
    for (const metric of config.metrics) {
      switch (metric.type) {
        case 'boolean': {
          const m = metric as BooleanMetric;
          names[`${m.metricPrefix}_count`] = m.displayName;
          names[`${m.metricPrefix}_total`] = `${m.displayName} (Total)`;
          names[`${m.metricPrefix}_rate_percent`] = `${m.displayName} (%)`;
          break;
        }
        case 'integer':
        case 'number': {
          const m = metric as IntegerMetric;
          names[`${m.metricPrefix}_sum`] = `${m.displayName} (Soma)`;
          names[`${m.metricPrefix}_count`] = `${m.displayName} (Contagem)`;
          names[`${m.metricPrefix}_avg`] = `${m.displayName} Médio`;
          // Distribution buckets get display name from the value
          if (m.distribution && m.min !== undefined && m.max !== undefined) {
            for (let i = m.min; i <= m.max; i++) {
              names[`${m.metricPrefix}_${i}`] = `${m.displayName} ${i}`;
            }
          }
          break;
        }
        case 'enum': {
          const m = metric as EnumMetric;
          names[`${m.metricPrefix}_total`] = `${m.displayName} (Total)`;
          for (const value of m.values) {
            if (m.ignoreValues?.includes(value)) continue;
            const normalized = value.toLowerCase().replace(/\s+/g, '_');
            const valueDisplay = m.valueDisplayNames?.[value] || titleCase(normalized);
            names[`${m.metricPrefix}_${normalized}`] = `${m.displayName}: ${valueDisplay}`;
            names[`${m.metricPrefix}_${normalized}_rate_percent`] = `${m.displayName}: ${valueDisplay} (%)`;
          }
          break;
        }
        case 'category': {
          // Category display names are dynamic (from the value itself)
          // Handled by the prefix-stripping logic in friendlyMetricName
          break;
        }
        case 'category_array': {
          // Same as category — dynamic display names
          break;
        }
      }
    }
  }

  cachedDisplayNames = names;
  return names;
}

/**
 * Get a friendly display name for a metric.
 * Tries config-generated names first, then handles dynamic patterns
 * (categories, subtopics), then falls back to the raw name.
 */
export function configFriendlyMetricName(name: string): string {
  const displayNames = buildDisplayNames();

  // Exact match from config
  if (displayNames[name]) return displayNames[name];

  // Dynamic patterns: category and category_array metrics
  // These have variable suffixes that can't be pre-computed
  const configs = getAllOperatorConfigs();
  for (const config of configs) {
    for (const metric of config.metrics) {
      if (metric.type === 'category_array') {
        const m = metric as CategoryArrayMetric;
        // Subtopic: poc_subtopic_renda_fixa_-_resgate → Renda Fixa - Resgate
        if (m.subcategoryPrefix && name.startsWith(`${m.subcategoryPrefix}_`)) {
          return titleCase(name.replace(`${m.subcategoryPrefix}_`, ''));
        }
        // Primary category: poc_topic_renda_fixa → Renda Fixa
        if (name.startsWith(`${m.metricPrefix}_`)) {
          return titleCase(name.replace(`${m.metricPrefix}_`, ''));
        }
      }
      if (metric.type === 'category') {
        if (name.startsWith(`${metric.metricPrefix}_`)) {
          return titleCase(name.replace(`${metric.metricPrefix}_`, ''));
        }
      }
    }
  }

  // Fallback: return as-is
  return name;
}

/**
 * Compute all derived metrics from raw metrics, using config.
 * Works for both per-day and period-level computation.
 */
export function computeConfigDerivedMetrics(
  date: string,
  rawMetricsByName: Map<string, number>
): Array<{ date: string; metricName: string; value: number }> {
  const derived: Array<{ date: string; metricName: string; value: number }> = [];
  const configs = getAllOperatorConfigs();

  for (const config of configs) {
    for (const metric of config.metrics) {
      switch (metric.type) {
        case 'boolean': {
          const m = metric as BooleanMetric;
          const count = rawMetricsByName.get(`${m.metricPrefix}_count`);
          const total = rawMetricsByName.get(`${m.metricPrefix}_total`);
          if (count !== undefined && total !== undefined && total > 0) {
            derived.push({
              date,
              metricName: `${m.metricPrefix}_rate_percent`,
              value: Math.round((count / total) * 100 * 100) / 100,
            });
          }
          break;
        }
        case 'integer':
        case 'number': {
          const m = metric as IntegerMetric;
          const sum = rawMetricsByName.get(`${m.metricPrefix}_sum`);
          const count = rawMetricsByName.get(`${m.metricPrefix}_count`);
          if (sum !== undefined && count !== undefined && count > 0) {
            derived.push({
              date,
              metricName: `${m.metricPrefix}_avg`,
              value: Math.round((sum / count) * 100) / 100,
            });
          }
          break;
        }
        case 'enum': {
          const m = metric as EnumMetric;
          const denominator = m.rateDenominator || `${m.metricPrefix}_total`;
          const denomValue = rawMetricsByName.get(denominator);
          if (denomValue === undefined || denomValue <= 0) break;

          const values = m.values.filter(v => !m.ignoreValues?.includes(v));
          for (const value of values) {
            const normalized = value.toLowerCase().replace(/\s+/g, '_');
            const count = rawMetricsByName.get(`${m.metricPrefix}_${normalized}`);
            if (count !== undefined) {
              derived.push({
                date,
                metricName: `${m.metricPrefix}_${normalized}_rate_percent`,
                value: Math.round((count / denomValue) * 100 * 100) / 100,
              });
            }
          }
          break;
        }
        // category and category_array don't produce derived metrics
      }
    }
  }

  return derived;
}

/**
 * Convert underscored_lowercase to Title Case.
 * Accent-safe: only capitalizes after spaces/start.
 */
function titleCase(str: string): string {
  return str
    .replace(/_/g, ' ')
    .replace(/\s+-\s+/g, ' - ')
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Reset caches. For testing.
 */
export function resetDerivedCaches(): void {
  cachedDependencies = null;
  cachedDisplayNames = null;
}
