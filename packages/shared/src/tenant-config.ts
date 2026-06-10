/**
 * Per-tenant configuration. Ships to S3 alongside operator-metrics.json
 * and is loaded by the ingest Lambda at cold start to decide which
 * Conversational Intelligence version a tenant is on.
 */

import type { IntelligenceTrigger } from './operator-config';

export type CiVersion = 'v2' | 'v3';

export interface TenantConfig {
  /** Which Twilio Conversational Intelligence version this tenant uses. */
  ciVersion: CiVersion;
}

export interface TenantsConfig {
  /** Schema version for forward compatibility. */
  version: string;
  description?: string;
  /** Per-tenant configuration. Tenants not listed fall back to `defaults`. */
  tenants: Record<string, TenantConfig>;
  /** Defaults applied for any tenant not explicitly listed. */
  defaults: TenantConfig;
}

// Cache — loaded once per Lambda cold start.
let cachedTenantsConfig: TenantsConfig | null = null;

export function initializeTenantsConfig(json: string): TenantsConfig | null {
  try {
    const parsed = JSON.parse(json) as TenantsConfig;
    if (!parsed.tenants || !parsed.defaults?.ciVersion) {
      console.warn('Invalid tenants config: missing tenants map or defaults.ciVersion');
      return null;
    }
    cachedTenantsConfig = parsed;
    return cachedTenantsConfig;
  } catch (error) {
    console.error('Failed to parse tenants config:', error);
    return null;
  }
}

/**
 * Resolve a tenant's configuration. Returns the explicit tenant entry when
 * present, otherwise the `defaults` block. Returns null when no tenants
 * config has been loaded — caller should treat that as v2 (legacy behavior).
 */
export function getTenantConfig(tenantId: string): TenantConfig | null {
  if (!cachedTenantsConfig) return null;
  return cachedTenantsConfig.tenants[tenantId] ?? cachedTenantsConfig.defaults;
}

/** Reset for testing. */
export function resetTenantsConfigCache(): void {
  cachedTenantsConfig = null;
}

// Re-export the trigger type for ingest-side imports that already pull
// adapter-related symbols from this module.
export type { IntelligenceTrigger };
