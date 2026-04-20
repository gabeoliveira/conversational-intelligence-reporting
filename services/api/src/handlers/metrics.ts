import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  buildDerivedMetricDependencies,
  configFriendlyMetricName,
  computeConfigDerivedMetrics,
  ensureConfigLoaded,
} from '@cirl/shared';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

interface GetMetricsParams {
  from?: string;
  to?: string;
  metric?: string;
}

interface MetricValue {
  date: string;
  metricName: string;
  value: number;
}

/**
 * Built-in derived metrics that aren't operator-specific.
 * These come from the ingest pipeline (timing, sentence counts)
 * or from the legacy conversation-intelligence operator.
 * They'll remain until those are also config-driven.
 */
const builtInDerivedDependencies: Record<string, string[]> = {
  // Timing metrics (from transcript sentences — not operator-specific)
  'avg_handling_time_sec': ['handling_time_sum', 'handling_time_count'],
  'avg_response_time_sec': ['response_time_sum', 'response_time_count'],
  'avg_customer_wait_time_sec': ['customer_wait_time_sum', 'customer_wait_time_count'],
  // Legacy conversation-intelligence operator metrics
  'sentiment_avg': ['sentiment_score_sum', 'sentiment_score_count'],
  'summary_avg_words': ['summary_word_count_sum', 'summary_word_count_count'],
  'classification_avg_confidence': ['classification_confidence_sum', 'classification_confidence_count'],
  'pii_avg_entities_per_conversation': ['pii_entities_detected', 'pii_conversations_with_entities'],
  'intent_avg_confidence': ['intent_confidence_sum', 'intent_confidence_count'],
  'virtual_agent_quality_avg': ['virtual_agent_quality_sum', 'virtual_agent_quality_count'],
  'human_agent_quality_avg': ['human_agent_quality_sum', 'human_agent_quality_count'],
  'transfer_rate_percent': ['human_agent_transfers', 'conversation_count'],
  // Legacy percent metrics
  'virtual_agent_resolved_questions_percent': ['virtual_agent_resolved_questions', 'conversation_count'],
  'virtual_agent_resolved_without_human_percent': ['virtual_agent_resolved_without_human', 'conversation_count'],
  'virtual_agent_avoided_hallucinations_percent': ['virtual_agent_avoided_hallucinations', 'conversation_count'],
  'virtual_agent_avoided_repetitions_percent': ['virtual_agent_avoided_repetitions', 'conversation_count'],
  'virtual_agent_maintained_consistency_percent': ['virtual_agent_maintained_consistency', 'conversation_count'],
  'human_agent_resolved_questions_percent': ['human_agent_resolved_questions', 'human_agent_transfers'],
  'human_agent_was_cordial_percent': ['human_agent_was_cordial', 'human_agent_transfers'],
  'human_agent_avoided_repetitions_percent': ['human_agent_avoided_repetitions', 'human_agent_transfers'],
  'human_agent_resolved_problem_percent': ['human_agent_resolved_problem', 'human_agent_transfers'],
  'human_agent_clear_closing_percent': ['human_agent_clear_closing', 'human_agent_transfers'],
};

/**
 * Built-in display names for non-config metrics.
 */
const builtInDisplayNames: Record<string, string> = {
  'conversation_count': 'Conversas',
  'avg_handling_time_sec': 'Tempo Média de Atendimento (s)',
  'avg_response_time_sec': 'Tempo Média de Resposta (s)',
  'avg_customer_wait_time_sec': 'Tempo Média de Espera do Cliente (s)',
  'sentiment_avg': 'Sentimento Média',
  'transfer_rate_percent': 'Taxa de Transferência (%)',
  'virtual_agent_quality_avg': 'Qualidade do Agente Virtual',
  'human_agent_quality_avg': 'Qualidade do Agente Humano',
};

export async function getMetrics(
  tenantId: string,
  params: GetMetricsParams
): Promise<{ metrics: MetricValue[]; period: { from: string; to: string } }> {
  const { metric } = params;

  // Ensure config is loaded from S3
  await ensureConfigLoaded();

  // Merge config-driven and built-in dependency maps
  const configDeps = buildDerivedMetricDependencies();
  const allDependencies = { ...builtInDerivedDependencies, ...configDeps };

  // Default to last 30 days
  const to = params.to ? new Date(params.to) : new Date();
  const from = params.from ? new Date(params.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

  const fromDate = formatDate(from);
  const toDate = formatDate(to);

  // Build query
  let keyCondition = 'PK = :pk AND SK BETWEEN :fromSk AND :toSk';
  const expressionValues: Record<string, unknown> = {
    ':pk': `TENANT#${tenantId}#AGG#DAY`,
    ':fromSk': `DAY#${fromDate}`,
    ':toSk': `DAY#${toDate}#METRIC#zzzzzzzz`,
  };

  const isDerived = metric ? metric in allDependencies : false;
  const rawMetricsToFetch = isDerived ? allDependencies[metric!] : null;

  // Filter by specific metric if provided (and it's a raw metric, not derived)
  let filterExpression: string | undefined;
  if (metric && !isDerived) {
    filterExpression = 'metricName = :metricName';
    expressionValues[':metricName'] = metric;
  } else if (rawMetricsToFetch) {
    // Fetch only the raw ingredients needed for the derived metric
    const conditions = rawMetricsToFetch.map((_, i) => `metricName = :mn${i}`);
    filterExpression = `(${conditions.join(' OR ')})`;
    rawMetricsToFetch.forEach((name, i) => {
      expressionValues[`:mn${i}`] = name;
    });
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: keyCondition,
      FilterExpression: filterExpression,
      ExpressionAttributeValues: expressionValues,
    })
  );

  const metrics: MetricValue[] = (result.Items || []).map(item => {
    // Parse payload to access entity-specific fields (spine + payload pattern)
    const payload = item.payload ? JSON.parse(item.payload as string) : {};

    // Convert YYYYMMDD to ISO date for BI tool compatibility
    const rawDate = item.date as string;
    const isoDate = rawDate.length === 8
      ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}T00:00:00Z`
      : rawDate;

    return {
      date: isoDate,
      metricName: item.metricName as string,
      value: payload.value as number,
    };
  });

  // Compute derived metrics per day (config-driven + built-in)
  const computedMetrics = computeAllDerivedMetrics(metrics);

  // Compute period-level aggregates (sum across all days, then derive)
  const periodMetrics = computeAllPeriodMetrics(metrics);

  let allMetrics = [...metrics, ...computedMetrics, ...periodMetrics];

  // If caller requested a specific derived metric, return only that metric
  if (metric && isDerived) {
    allMetrics = allMetrics.filter(m => m.metricName === metric);
  }

  // Add friendly display names alongside internal names
  const displayMetrics = allMetrics.map(m => ({
    ...m,
    displayName: getDisplayName(m.metricName),
  }));

  return {
    metrics: displayMetrics,
    period: {
      from: from.toISOString().split('T')[0],
      to: to.toISOString().split('T')[0],
    },
  };
}

/**
 * Get display name from config first, then built-in, then fallback.
 */
function getDisplayName(name: string): string {
  // Try config-driven display name
  const configName = configFriendlyMetricName(name);
  if (configName !== name) return configName;

  // Try built-in display names
  if (builtInDisplayNames[name]) return builtInDisplayNames[name];

  // Fallback
  return name;
}

/**
 * Compute derived metrics per day from raw metrics.
 * Uses config-driven computation + built-in legacy computation.
 */
function computeAllDerivedMetrics(rawMetrics: MetricValue[]): MetricValue[] {
  const derived: MetricValue[] = [];

  // Group metrics by date
  const byDate = new Map<string, Map<string, number>>();
  for (const m of rawMetrics) {
    if (!byDate.has(m.date)) {
      byDate.set(m.date, new Map());
    }
    byDate.get(m.date)!.set(m.metricName, m.value);
  }

  for (const [date, metricsMap] of byDate) {
    // Config-driven derived metrics
    derived.push(...computeConfigDerivedMetrics(date, metricsMap));

    // Built-in derived metrics (timing, legacy operators)
    derived.push(...computeBuiltInDerived(date, metricsMap));
  }

  return derived;
}

/**
 * Compute period-level aggregates across all days.
 */
function computeAllPeriodMetrics(rawMetrics: MetricValue[]): MetricValue[] {
  const date = 'period';

  // Sum all raw metrics across all days
  const totals = new Map<string, number>();
  for (const m of rawMetrics) {
    totals.set(m.metricName, (totals.get(m.metricName) || 0) + m.value);
  }

  const derived: MetricValue[] = [];

  // Config-driven period metrics
  derived.push(...computeConfigDerivedMetrics(date, totals));

  // Built-in period metrics
  derived.push(...computeBuiltInDerived(date, totals));

  return derived;
}

/**
 * Built-in derived metrics for non-config operators (timing, legacy).
 */
function computeBuiltInDerived(
  date: string,
  metrics: Map<string, number>
): MetricValue[] {
  const derived: MetricValue[] = [];
  const get = (name: string) => metrics.get(name);

  const derive = (name: string, numerator: number | undefined, denominator: number | undefined) => {
    if (numerator !== undefined && denominator !== undefined && denominator > 0) {
      derived.push({ date, metricName: name, value: Math.round((numerator / denominator) * 100) / 100 });
    }
  };

  const derivePercent = (name: string, numerator: number | undefined, denominator: number | undefined) => {
    if (numerator !== undefined && denominator !== undefined && denominator > 0) {
      derived.push({ date, metricName: name, value: Math.round((numerator / denominator) * 100 * 100) / 100 });
    }
  };

  // Timing metrics
  derive('avg_handling_time_sec', get('handling_time_sum'), get('handling_time_count'));
  derive('avg_response_time_sec', get('response_time_sum'), get('response_time_count'));
  derive('avg_customer_wait_time_sec', get('customer_wait_time_sum'), get('customer_wait_time_count'));

  // Legacy conversation-intelligence operator
  derive('sentiment_avg', get('sentiment_score_sum'), get('sentiment_score_count'));
  derive('summary_avg_words', get('summary_word_count_sum'), get('summary_word_count_count'));
  derive('classification_avg_confidence', get('classification_confidence_sum'), get('classification_confidence_count'));
  derive('pii_avg_entities_per_conversation', get('pii_entities_detected'), get('pii_conversations_with_entities'));
  derive('intent_avg_confidence', get('intent_confidence_sum'), get('intent_confidence_count'));
  derive('virtual_agent_quality_avg', get('virtual_agent_quality_sum'), get('virtual_agent_quality_count'));
  derive('human_agent_quality_avg', get('human_agent_quality_sum'), get('human_agent_quality_count'));

  const convCount = get('conversation_count');
  derivePercent('transfer_rate_percent', get('human_agent_transfers'), convCount);

  // VA/HA percent metrics
  const vaMetrics = ['resolved_questions', 'resolved_without_human', 'avoided_hallucinations', 'avoided_repetitions', 'maintained_consistency'];
  for (const m of vaMetrics) {
    derivePercent(`virtual_agent_${m}_percent`, get(`virtual_agent_${m}`), convCount);
  }
  const transfers = get('human_agent_transfers');
  const haMetrics = ['resolved_questions', 'was_cordial', 'avoided_repetitions', 'resolved_problem', 'clear_closing'];
  for (const m of haMetrics) {
    derivePercent(`human_agent_${m}_percent`, get(`human_agent_${m}`), transfers);
  }

  return derived;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0].replace(/-/g, '');
}
