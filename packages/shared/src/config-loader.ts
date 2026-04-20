/**
 * Config loader — storage-agnostic interface for loading operator metric configs.
 *
 * The loader accepts a JSON string (from any source: S3, env var, file).
 * Callers are responsible for fetching the JSON — this module only parses and caches.
 */

import type { OperatorMetricsConfig, OperatorConfig } from './operator-config';

// In-memory cache — configs are loaded once per Lambda cold start
let cachedConfig: OperatorMetricsConfig | null = null;
let configByOperator: Map<string, OperatorConfig> | null = null;

/**
 * Initialize the config from a JSON string.
 * Call this once at Lambda cold start after fetching from S3 (or any source).
 * Returns the parsed config, or null if invalid.
 */
export function initializeConfig(configJson: string): OperatorMetricsConfig | null {
  try {
    const parsed = JSON.parse(configJson) as OperatorMetricsConfig;
    if (!parsed.operators || !Array.isArray(parsed.operators)) {
      console.warn('Invalid operator metrics config: missing operators array');
      return null;
    }
    cachedConfig = parsed;
    configByOperator = null; // Reset index so it's rebuilt on next access
    return cachedConfig;
  } catch (error) {
    console.error('Failed to parse operator metrics config:', error);
    return null;
  }
}

/**
 * Load the config. Tries cached first, then falls back to OPERATOR_METRICS_CONFIG env var.
 * For S3-based loading, call initializeConfig() first.
 */
export function loadOperatorMetricsConfig(): OperatorMetricsConfig | null {
  if (cachedConfig) return cachedConfig;

  // Fallback: try env var (for backward compatibility / testing)
  const configJson = process.env.OPERATOR_METRICS_CONFIG;
  if (configJson) {
    return initializeConfig(configJson);
  }

  return null;
}

/**
 * Get config for a specific operator by name.
 * Returns undefined if no config exists for this operator.
 */
export function getOperatorConfig(operatorName: string): OperatorConfig | undefined {
  if (!configByOperator) {
    const config = loadOperatorMetricsConfig();
    if (!config) return undefined;

    configByOperator = new Map();
    for (const op of config.operators) {
      configByOperator.set(op.operatorName, op);
      // Also index by SID if provided
      if (op.operatorSid) {
        configByOperator.set(op.operatorSid, op);
      }
    }
  }

  return configByOperator.get(operatorName);
}

/**
 * Get all operator configs.
 */
export function getAllOperatorConfigs(): OperatorConfig[] {
  const config = loadOperatorMetricsConfig();
  return config?.operators || [];
}

/**
 * Get all fields that should be surfaced in the conversations list view.
 * Returns a map of operatorName → field names.
 */
export function getListSurfaceFields(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const op of getAllOperatorConfigs()) {
    const fields = op.metrics
      .filter(m => m.surfaceInList)
      .map(m => m.field);
    if (fields.length > 0) {
      result[op.operatorName] = fields;
    }
  }
  return result;
}

/**
 * Reset the cached config. Useful for testing.
 */
export function resetConfigCache(): void {
  cachedConfig = null;
  configByOperator = null;
}
