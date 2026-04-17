import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

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

export async function getMetrics(
  tenantId: string,
  params: GetMetricsParams
): Promise<{ metrics: MetricValue[]; period: { from: string; to: string } }> {
  const { metric } = params;

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

  // Derived metrics are computed from raw sum/count pairs.
  // If the caller requests a derived metric, we need to fetch the raw ingredients
  // instead of filtering literally (the derived metric doesn't exist in DynamoDB).
  const derivedMetricDependencies: Record<string, string[]> = {
    'sentiment_avg': ['sentiment_score_sum', 'sentiment_score_count'],
    'summary_avg_words': ['summary_word_count_sum', 'summary_word_count_count'],
    'classification_avg_confidence': ['classification_confidence_sum', 'classification_confidence_count'],
    'pii_avg_entities_per_conversation': ['pii_entities_detected', 'pii_conversations_with_entities'],
    'intent_avg_confidence': ['intent_confidence_sum', 'intent_confidence_count'],
    'virtual_agent_quality_avg': ['virtual_agent_quality_sum', 'virtual_agent_quality_count'],
    'human_agent_quality_avg': ['human_agent_quality_sum', 'human_agent_quality_count'],
    'transfer_rate_percent': ['human_agent_transfers', 'conversation_count'],
    'avg_handling_time_sec': ['handling_time_sum', 'handling_time_count'],
    'avg_response_time_sec': ['response_time_sum', 'response_time_count'],
    'avg_customer_wait_time_sec': ['customer_wait_time_sum', 'customer_wait_time_count'],
    'poc_csat_avg': ['poc_csat_sum', 'poc_csat_count'],
    'poc_ai_retention_rate_percent': ['poc_ai_retained_count', 'poc_ai_retained_total'],
    'poc_error_rate_percent': ['poc_errors_count', 'poc_ai_retained_total'],
    'poc_asked_for_human_rate_percent': ['poc_asked_for_human_count', 'poc_ai_retained_total'],
    'poc_back_to_ivr_rate_percent': ['poc_back_to_ivr_count', 'poc_ai_retained_total'],
    // Handoff reason rates (as % of all conversations)
    'poc_handoff_customer_request_rate_percent': ['poc_handoff_customer_request', 'conversation_count'],
    'poc_handoff_lack_of_comprehension_rate_percent': ['poc_handoff_lack_of_comprehension', 'conversation_count'],
    'poc_handoff_lack_of_knowledge_rate_percent': ['poc_handoff_lack_of_knowledge', 'conversation_count'],
    // General KPIs averages
    'kpi_precisao_avg': ['kpi_precisao_sum', 'kpi_precisao_count'],
    'kpi_cobertura_conhecimento_avg': ['kpi_cobertura_conhecimento_sum', 'kpi_cobertura_conhecimento_count'],
    'kpi_alucinacoes_avg': ['kpi_alucinacoes_sum', 'kpi_alucinacoes_count'],
    'kpi_compreensao_avg': ['kpi_compreensao_sum', 'kpi_compreensao_count'],
    'kpi_aderencia_avg': ['kpi_aderencia_sum', 'kpi_aderencia_count'],
    'kpi_desambiguador_rate_percent': ['kpi_desambiguador_count', 'kpi_desambiguador_total'],
    // Percent metrics that depend on conversation_count
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

  const isDerived = metric ? metric in derivedMetricDependencies : false;
  const rawMetricsToFetch = isDerived ? derivedMetricDependencies[metric!] : null;

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

  // Compute derived metrics per day (for time series charts)
  const computedMetrics = computeDerivedMetrics(metrics);

  // Compute period-level aggregates (sum across all days, then derive)
  // This gives correct rates/averages for stat panels over a date range
  const periodMetrics = computePeriodMetrics(metrics);

  let allMetrics = [...metrics, ...computedMetrics, ...periodMetrics];

  // If caller requested a specific derived metric, return only that metric
  // (not the raw ingredients used to compute it)
  if (metric && isDerived) {
    allMetrics = allMetrics.filter(m => m.metricName === metric);
  }

  // Add friendly display names alongside internal names
  const displayMetrics = allMetrics.map(m => ({
    ...m,
    displayName: friendlyMetricName(m.metricName),
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
 * Convert internal metric names to human-friendly display names.
 * Strips prefixes, replaces underscores, capitalizes words.
 */
function friendlyMetricName(name: string): string {
  // Subtopic metrics (combined): poc_subtopic_renda_fixa_-_resgate → Renda Fixa - Resgate
  if (name.startsWith('poc_subtopic_')) {
    return titleCase(name.replace('poc_subtopic_', ''));
  }

  // Primary topic metrics: poc_topic_renda_fixa → Renda Fixa
  if (name.startsWith('poc_topic_')) {
    return titleCase(name.replace('poc_topic_', ''));
  }

  // CSAT distribution: poc_csat_3 → CSAT 3
  if (/^poc_csat_[1-5]$/.test(name)) {
    return `CSAT ${name.charAt(name.length - 1)}`;
  }

  // Known metrics with explicit friendly names
  const displayNames: Record<string, string> = {
    'conversation_count': 'Conversations',
    'avg_handling_time_sec': 'Avg Handling Time (s)',
    'avg_response_time_sec': 'Avg Response Time (s)',
    'avg_customer_wait_time_sec': 'Avg Customer Wait (s)',
    'poc_ai_retention_rate_percent': 'AI Retention Rate (%)',
    'poc_csat_avg': 'Avg CSAT',
    'poc_error_rate_percent': 'AI Error Rate (%)',
    'poc_asked_for_human_rate_percent': 'Asked for Human (%)',
    'poc_back_to_ivr_rate_percent': 'Back to IVR (%)',
    'poc_handoff_customer_request': 'Handoff: Customer Request',
    'poc_handoff_lack_of_comprehension': 'Handoff: Lack of Comprehension',
    'poc_handoff_lack_of_knowledge': 'Handoff: Lack of Knowledge',
    'poc_handoff_total': 'Total Handoffs',
    'poc_handoff_customer_request_rate_percent': 'Handoff: Customer Request (%)',
    'poc_handoff_lack_of_comprehension_rate_percent': 'Handoff: Comprehension (%)',
    'poc_handoff_lack_of_knowledge_rate_percent': 'Handoff: Knowledge (%)',
    'sentiment_avg': 'Avg Sentiment',
    'transfer_rate_percent': 'Transfer Rate (%)',
    'virtual_agent_quality_avg': 'VA Quality',
    'human_agent_quality_avg': 'Human Agent Quality',
    'kpi_precisao_avg': 'Precision',
    'kpi_cobertura_conhecimento_avg': 'Knowledge Coverage',
    'kpi_alucinacoes_avg': 'Hallucinations',
    'kpi_compreensao_avg': 'Comprehension',
    'kpi_aderencia_avg': 'Adherence',
    'kpi_desambiguador_rate_percent': 'Disambiguation Rate (%)',
  };

  if (displayNames[name]) return displayNames[name];

  // Fallback: return as-is
  return name;
}

/**
 * Convert underscored_lowercase to Title Case.
 * Handles the " - " separator for combined topic-subtopic names.
 * Accent-safe: only capitalizes after spaces/start, not after accented chars.
 * e.g., "renda_fixa_-_resgate" → "Renda Fixa - Resgate"
 * e.g., "previdência_privada_-_informações_gerais" → "Previdência Privada - Informações Gerais"
 */
function titleCase(str: string): string {
  return str
    .replace(/_/g, ' ')
    .replace(/\s+-\s+/g, ' - ')
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Compute period-level aggregate metrics across all days.
 * Sums raw counters across dates, then derives rates/averages from the totals.
 * These use date = "period" to distinguish from per-day metrics.
 * Stat panels should use these for correct rates over a date range.
 */
function computePeriodMetrics(rawMetrics: MetricValue[]): MetricValue[] {
  const derived: MetricValue[] = [];
  const date = 'period';

  // Sum all raw metrics across all days
  const totals = new Map<string, number>();
  for (const m of rawMetrics) {
    totals.set(m.metricName, (totals.get(m.metricName) || 0) + m.value);
  }

  const get = (name: string) => totals.get(name);

  // Helper to push a derived metric
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

  // Averages (sum / count)
  derive('sentiment_avg', get('sentiment_score_sum'), get('sentiment_score_count'));
  derive('summary_avg_words', get('summary_word_count_sum'), get('summary_word_count_count'));
  derive('classification_avg_confidence', get('classification_confidence_sum'), get('classification_confidence_count'));
  derive('pii_avg_entities_per_conversation', get('pii_entities_detected'), get('pii_conversations_with_entities'));
  derive('intent_avg_confidence', get('intent_confidence_sum'), get('intent_confidence_count'));
  derive('virtual_agent_quality_avg', get('virtual_agent_quality_sum'), get('virtual_agent_quality_count'));
  derive('human_agent_quality_avg', get('human_agent_quality_sum'), get('human_agent_quality_count'));
  derive('avg_handling_time_sec', get('handling_time_sum'), get('handling_time_count'));
  derive('avg_response_time_sec', get('response_time_sum'), get('response_time_count'));
  derive('avg_customer_wait_time_sec', get('customer_wait_time_sum'), get('customer_wait_time_count'));
  derive('poc_csat_avg', get('poc_csat_sum'), get('poc_csat_count'));

  // KPI averages
  for (const kpi of ['kpi_precisao', 'kpi_cobertura_conhecimento', 'kpi_alucinacoes', 'kpi_compreensao', 'kpi_aderencia']) {
    derive(`${kpi}_avg`, get(`${kpi}_sum`), get(`${kpi}_count`));
  }

  // Percentage metrics (count / total * 100)
  const convCount = get('conversation_count');
  derivePercent('transfer_rate_percent', get('human_agent_transfers'), convCount);
  derivePercent('poc_ai_retention_rate_percent', get('poc_ai_retained_count'), get('poc_ai_retained_total'));
  derivePercent('poc_error_rate_percent', get('poc_errors_count'), get('poc_ai_retained_total'));
  derivePercent('poc_asked_for_human_rate_percent', get('poc_asked_for_human_count'), get('poc_ai_retained_total'));
  derivePercent('poc_back_to_ivr_rate_percent', get('poc_back_to_ivr_count'), get('poc_ai_retained_total'));
  derivePercent('kpi_desambiguador_rate_percent', get('kpi_desambiguador_count'), get('kpi_desambiguador_total'));

  // Handoff reason rates (as % of all conversations)
  for (const reason of ['customer_request', 'lack_of_comprehension', 'lack_of_knowledge']) {
    derivePercent(`poc_handoff_${reason}_rate_percent`, get(`poc_handoff_${reason}`), convCount);
  }

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

  // Note: raw counters (conversation_count, poc_handoff_total, etc.) are NOT
  // included in period metrics — Stat panels sum them across days natively.
  // Only derived rates/averages need period-level computation.

  return derived;
}

function computeDerivedMetrics(rawMetrics: MetricValue[]): MetricValue[] {
  const derived: MetricValue[] = [];

  // Group metrics by date
  const byDate = new Map<string, Map<string, number>>();
  for (const m of rawMetrics) {
    if (!byDate.has(m.date)) {
      byDate.set(m.date, new Map());
    }
    byDate.get(m.date)!.set(m.metricName, m.value);
  }

  // Compute derived metrics for each date
  for (const [date, metrics] of byDate) {
    // Sentiment average
    const sentimentSum = metrics.get('sentiment_score_sum');
    const sentimentCount = metrics.get('sentiment_score_count');
    if (sentimentSum !== undefined && sentimentCount !== undefined && sentimentCount > 0) {
      derived.push({
        date,
        metricName: 'sentiment_avg',
        value: Math.round((sentimentSum / sentimentCount) * 100) / 100,
      });
    }

    // Summary word count average
    const summarySum = metrics.get('summary_word_count_sum');
    const summaryCount = metrics.get('summary_word_count_count');
    if (summarySum !== undefined && summaryCount !== undefined && summaryCount > 0) {
      derived.push({
        date,
        metricName: 'summary_avg_words',
        value: Math.round(summarySum / summaryCount),
      });
    }

    // Classification confidence average
    const confidenceSum = metrics.get('classification_confidence_sum');
    const confidenceCount = metrics.get('classification_confidence_count');
    if (confidenceSum !== undefined && confidenceCount !== undefined && confidenceCount > 0) {
      derived.push({
        date,
        metricName: 'classification_avg_confidence',
        value: Math.round((confidenceSum / confidenceCount) * 100) / 100,
      });
    }

    // PII entities per conversation
    const piiEntities = metrics.get('pii_entities_detected');
    const piiConversations = metrics.get('pii_conversations_with_entities');
    if (piiEntities !== undefined && piiConversations !== undefined && piiConversations > 0) {
      derived.push({
        date,
        metricName: 'pii_avg_entities_per_conversation',
        value: Math.round((piiEntities / piiConversations) * 100) / 100,
      });
    }

    // Intent confidence average
    const intentSum = metrics.get('intent_confidence_sum');
    const intentCount = metrics.get('intent_confidence_count');
    if (intentSum !== undefined && intentCount !== undefined && intentCount > 0) {
      derived.push({
        date,
        metricName: 'intent_avg_confidence',
        value: Math.round((intentSum / intentCount) * 100) / 100,
      });
    }

    // Virtual agent quality average
    const virtualQualitySum = metrics.get('virtual_agent_quality_sum');
    const virtualQualityCount = metrics.get('virtual_agent_quality_count');
    if (virtualQualitySum !== undefined && virtualQualityCount !== undefined && virtualQualityCount > 0) {
      derived.push({
        date,
        metricName: 'virtual_agent_quality_avg',
        value: Math.round((virtualQualitySum / virtualQualityCount) * 100) / 100,
      });
    }

    // Human agent quality average
    const humanQualitySum = metrics.get('human_agent_quality_sum');
    const humanQualityCount = metrics.get('human_agent_quality_count');
    if (humanQualitySum !== undefined && humanQualityCount !== undefined && humanQualityCount > 0) {
      derived.push({
        date,
        metricName: 'human_agent_quality_avg',
        value: Math.round((humanQualitySum / humanQualityCount) * 100) / 100,
      });
    }

    // Transfer rate (percentage of conversations transferred to human)
    const transfers = metrics.get('human_agent_transfers');
    const convCount = metrics.get('conversation_count');
    if (transfers !== undefined && convCount !== undefined && convCount > 0) {
      derived.push({
        date,
        metricName: 'transfer_rate_percent',
        value: Math.round((transfers / convCount) * 100 * 100) / 100,
      });
    }

    // Virtual agent success rates (as percentages)
    const vaResolvedQuestions = metrics.get('virtual_agent_resolved_questions');
    const vaResolvedWithoutHuman = metrics.get('virtual_agent_resolved_without_human');
    const vaAvoidedHallucinations = metrics.get('virtual_agent_avoided_hallucinations');
    const vaAvoidedRepetitions = metrics.get('virtual_agent_avoided_repetitions');
    const vaMaintainedConsistency = metrics.get('virtual_agent_maintained_consistency');

    if (vaResolvedQuestions !== undefined && convCount !== undefined && convCount > 0) {
      derived.push({
        date,
        metricName: 'virtual_agent_resolved_questions_percent',
        value: Math.round((vaResolvedQuestions / convCount) * 100 * 100) / 100,
      });
    }
    if (vaResolvedWithoutHuman !== undefined && convCount !== undefined && convCount > 0) {
      derived.push({
        date,
        metricName: 'virtual_agent_resolved_without_human_percent',
        value: Math.round((vaResolvedWithoutHuman / convCount) * 100 * 100) / 100,
      });
    }
    if (vaAvoidedHallucinations !== undefined && convCount !== undefined && convCount > 0) {
      derived.push({
        date,
        metricName: 'virtual_agent_avoided_hallucinations_percent',
        value: Math.round((vaAvoidedHallucinations / convCount) * 100 * 100) / 100,
      });
    }
    if (vaAvoidedRepetitions !== undefined && convCount !== undefined && convCount > 0) {
      derived.push({
        date,
        metricName: 'virtual_agent_avoided_repetitions_percent',
        value: Math.round((vaAvoidedRepetitions / convCount) * 100 * 100) / 100,
      });
    }
    if (vaMaintainedConsistency !== undefined && convCount !== undefined && convCount > 0) {
      derived.push({
        date,
        metricName: 'virtual_agent_maintained_consistency_percent',
        value: Math.round((vaMaintainedConsistency / convCount) * 100 * 100) / 100,
      });
    }

    // Average handling time (seconds)
    const handlingTimeSum = metrics.get('handling_time_sum');
    const handlingTimeCount = metrics.get('handling_time_count');
    if (handlingTimeSum !== undefined && handlingTimeCount !== undefined && handlingTimeCount > 0) {
      derived.push({
        date,
        metricName: 'avg_handling_time_sec',
        value: Math.round((handlingTimeSum / handlingTimeCount) * 100) / 100,
      });
    }

    // Average agent response time (seconds)
    const responseTimeSum = metrics.get('response_time_sum');
    const responseTimeCount = metrics.get('response_time_count');
    if (responseTimeSum !== undefined && responseTimeCount !== undefined && responseTimeCount > 0) {
      derived.push({
        date,
        metricName: 'avg_response_time_sec',
        value: Math.round((responseTimeSum / responseTimeCount) * 100) / 100,
      });
    }

    // Average customer wait time (seconds)
    const customerWaitSum = metrics.get('customer_wait_time_sum');
    const customerWaitCount = metrics.get('customer_wait_time_count');
    if (customerWaitSum !== undefined && customerWaitCount !== undefined && customerWaitCount > 0) {
      derived.push({
        date,
        metricName: 'avg_customer_wait_time_sec',
        value: Math.round((customerWaitSum / customerWaitCount) * 100) / 100,
      });
    }

    // POC Analytics derived metrics
    const pocCsatSum = metrics.get('poc_csat_sum');
    const pocCsatCount = metrics.get('poc_csat_count');
    if (pocCsatSum !== undefined && pocCsatCount !== undefined && pocCsatCount > 0) {
      derived.push({
        date,
        metricName: 'poc_csat_avg',
        value: Math.round((pocCsatSum / pocCsatCount) * 100) / 100,
      });
    }

    // AI retention rate (percentage of conversations where AI resolved without human)
    const pocAiRetained = metrics.get('poc_ai_retained_count');
    const pocAiTotal = metrics.get('poc_ai_retained_total');
    if (pocAiRetained !== undefined && pocAiTotal !== undefined && pocAiTotal > 0) {
      derived.push({
        date,
        metricName: 'poc_ai_retention_rate_percent',
        value: Math.round((pocAiRetained / pocAiTotal) * 100 * 100) / 100,
      });
    }

    // Error rate (percentage of conversations with AI errors)
    const pocErrors = metrics.get('poc_errors_count');
    if (pocErrors !== undefined && pocAiTotal !== undefined && pocAiTotal > 0) {
      derived.push({
        date,
        metricName: 'poc_error_rate_percent',
        value: Math.round((pocErrors / pocAiTotal) * 100 * 100) / 100,
      });
    }

    // Asked for human rate
    const pocAskedHuman = metrics.get('poc_asked_for_human_count');
    if (pocAskedHuman !== undefined && pocAiTotal !== undefined && pocAiTotal > 0) {
      derived.push({
        date,
        metricName: 'poc_asked_for_human_rate_percent',
        value: Math.round((pocAskedHuman / pocAiTotal) * 100 * 100) / 100,
      });
    }

    // Back to IVR rate
    const pocBackToIvr = metrics.get('poc_back_to_ivr_count');
    if (pocBackToIvr !== undefined && pocAiTotal !== undefined && pocAiTotal > 0) {
      derived.push({
        date,
        metricName: 'poc_back_to_ivr_rate_percent',
        value: Math.round((pocBackToIvr / pocAiTotal) * 100 * 100) / 100,
      });
    }

    // Handoff reason rates (as % of all conversations)
    const handoffReasons = ['customer_request', 'lack_of_comprehension', 'lack_of_knowledge'];
    for (const reason of handoffReasons) {
      const count = metrics.get(`poc_handoff_${reason}`);
      if (count !== undefined && convCount !== undefined && convCount > 0) {
        derived.push({
          date,
          metricName: `poc_handoff_${reason}_rate_percent`,
          value: Math.round((count / convCount) * 100 * 100) / 100,
        });
      }
    }

    // General KPIs derived metrics (averages from sum/count)
    const kpiFields = [
      'kpi_precisao',
      'kpi_cobertura_conhecimento',
      'kpi_alucinacoes',
      'kpi_compreensao',
      'kpi_aderencia',
    ];
    for (const kpi of kpiFields) {
      const sum = metrics.get(`${kpi}_sum`);
      const count = metrics.get(`${kpi}_count`);
      if (sum !== undefined && count !== undefined && count > 0) {
        derived.push({
          date,
          metricName: `${kpi}_avg`,
          value: Math.round((sum / count) * 100) / 100,
        });
      }
    }

    // Desambiguador rate (percentage of conversations needing disambiguation)
    const desambiguadorCount = metrics.get('kpi_desambiguador_count');
    const desambiguadorTotal = metrics.get('kpi_desambiguador_total');
    if (desambiguadorCount !== undefined && desambiguadorTotal !== undefined && desambiguadorTotal > 0) {
      derived.push({
        date,
        metricName: 'kpi_desambiguador_rate_percent',
        value: Math.round((desambiguadorCount / desambiguadorTotal) * 100 * 100) / 100,
      });
    }

    // Human agent success rates (as percentages of transferred conversations)
    const haResolvedQuestions = metrics.get('human_agent_resolved_questions');
    const haWasCordial = metrics.get('human_agent_was_cordial');
    const haAvoidedRepetitions = metrics.get('human_agent_avoided_repetitions');
    const haResolvedProblem = metrics.get('human_agent_resolved_problem');
    const haClearClosing = metrics.get('human_agent_clear_closing');

    if (haResolvedQuestions !== undefined && transfers !== undefined && transfers > 0) {
      derived.push({
        date,
        metricName: 'human_agent_resolved_questions_percent',
        value: Math.round((haResolvedQuestions / transfers) * 100 * 100) / 100,
      });
    }
    if (haWasCordial !== undefined && transfers !== undefined && transfers > 0) {
      derived.push({
        date,
        metricName: 'human_agent_was_cordial_percent',
        value: Math.round((haWasCordial / transfers) * 100 * 100) / 100,
      });
    }
    if (haAvoidedRepetitions !== undefined && transfers !== undefined && transfers > 0) {
      derived.push({
        date,
        metricName: 'human_agent_avoided_repetitions_percent',
        value: Math.round((haAvoidedRepetitions / transfers) * 100 * 100) / 100,
      });
    }
    if (haResolvedProblem !== undefined && transfers !== undefined && transfers > 0) {
      derived.push({
        date,
        metricName: 'human_agent_resolved_problem_percent',
        value: Math.round((haResolvedProblem / transfers) * 100 * 100) / 100,
      });
    }
    if (haClearClosing !== undefined && transfers !== undefined && transfers > 0) {
      derived.push({
        date,
        metricName: 'human_agent_clear_closing_percent',
        value: Math.round((haClearClosing / transfers) * 100 * 100) / 100,
      });
    }
  }

  return derived;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0].replace(/-/g, '');
}
