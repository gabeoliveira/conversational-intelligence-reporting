/**
 * Config-driven operator metrics schema.
 *
 * Defines how operator result fields are aggregated into metrics.
 * Each operator has one config; each config has multiple metric definitions.
 * The processor reads the config to aggregate metrics generically,
 * and the API reads it to auto-derive computed metrics and display names.
 */

// ============================================================================
// Primitive metric types
// ============================================================================

/** Boolean field: tracks true count and total count, derives rate_percent */
export interface BooleanMetric {
  type: 'boolean';
  field: string;
  metricPrefix: string;
  displayName: string;
  /** Include this field in the conversations list response */
  surfaceInList?: boolean;
}

/** Integer/number field: tracks sum and count, derives avg. Optional distribution. */
export interface IntegerMetric {
  type: 'integer' | 'number';
  field: string;
  metricPrefix: string;
  displayName: string;
  /** Minimum valid value (values below this are discarded) */
  min?: number;
  /** Maximum valid value (values above this are discarded) */
  max?: number;
  /** Also track per-value counts (e.g., CSAT 1, CSAT 2, ...) */
  distribution?: boolean;
  surfaceInList?: boolean;
}

/** Category field: tracks count per distinct value (free-text, normalized) */
export interface CategoryMetric {
  type: 'category';
  field: string;
  metricPrefix: string;
  displayName: string;
  surfaceInList?: boolean;
}

/** Enum field: tracks count per value and total, derives per-value rate_percent */
export interface EnumMetric {
  type: 'enum';
  field: string;
  metricPrefix: string;
  displayName: string;
  /** Allowed values for this enum */
  values: string[];
  /** Human-readable names for enum values (used in displayName) */
  valueDisplayNames?: Record<string, string>;
  /** Values to skip when counting (e.g., "NONE" for handoff reasons) */
  ignoreValues?: string[];
  /**
   * Denominator for rate_percent computation.
   * Defaults to 'conversation_count'. Can reference another metric
   * (e.g., '{metricPrefix}_total' for share-of-enum calculations).
   */
  rateDenominator?: string;
  surfaceInList?: boolean;
}

/** Array of objects with category + subcategory fields */
export interface CategoryArrayMetric {
  type: 'category_array';
  field: string;
  metricPrefix: string;
  displayName: string;
  /** Field name within each array item for the primary category */
  categoryField: string;
  /** Field name within each array item for the subcategory */
  subcategoryField?: string;
  /** Metric prefix for the combined category-subcategory metric */
  subcategoryPrefix?: string;
  surfaceInList?: boolean;
}

// Union of all metric types
export type MetricDefinition =
  | BooleanMetric
  | IntegerMetric
  | CategoryMetric
  | EnumMetric
  | CategoryArrayMetric;

// ============================================================================
// Operator config
// ============================================================================

/**
 * Conversational Intelligence v3 rule trigger. Carried on the canonical
 * IntelligenceEvent for v3 webhooks; absent for v2 (which only fires
 * post-transcript, once per conversation).
 */
export type IntelligenceTrigger =
  | 'COMMUNICATION'
  | 'CONVERSATION_INACTIVE'
  | 'CONVERSATION_END';

export interface OperatorConfig {
  /** Operator name as it appears in Twilio (FriendlyName / displayName) */
  operatorName: string;
  /** Twilio operator SID (stable identifier, optional for matching) */
  operatorSid?: string;
  /** Human-readable name for this operator */
  displayName: string;
  /**
   * v3 only — restrict aggregation to results produced by a rule with one of
   * these triggers. Storage of the operator result still happens regardless.
   * Absent ⇒ aggregate on every fire (v2 behavior).
   *
   * Use for operators whose rule fires per-message but whose metric only
   * makes sense once per conversation (e.g. CSAT scored only at end).
   */
  aggregateOnTriggers?: IntelligenceTrigger[];
  /**
   * Per-conversation aggregation dedup. When set to "conversation", a given
   * (operator, conversationId) tuple only contributes once to aggregates,
   * even if the rule fires multiple times. Independent of aggregateOnTriggers
   * — use this when the rule MUST fire multiple times but you want metrics
   * to count conversations, not events.
   */
  dedupBy?: 'conversation';
  /** Metric definitions for this operator's output fields */
  metrics: MetricDefinition[];
}

// ============================================================================
// Full config file shape
// ============================================================================

export interface OperatorMetricsConfig {
  /** Schema version for forward compatibility */
  version: string;
  /** Description of this config */
  description?: string;
  /** List of operator configurations */
  operators: OperatorConfig[];
}
