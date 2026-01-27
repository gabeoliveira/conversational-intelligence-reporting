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

  // Filter by specific metric if provided
  let filterExpression: string | undefined;
  if (metric) {
    filterExpression = 'metricName = :metricName';
    expressionValues[':metricName'] = metric;
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: keyCondition,
      FilterExpression: filterExpression,
      ExpressionAttributeValues: expressionValues,
    })
  );

  const metrics: MetricValue[] = (result.Items || []).map(item => ({
    date: item.date,
    metricName: item.metricName,
    value: item.value,
  }));

  // Compute derived metrics (e.g., sentiment average)
  const computedMetrics = computeDerivedMetrics(metrics);

  return {
    metrics: [...metrics, ...computedMetrics],
    period: {
      from: from.toISOString().split('T')[0],
      to: to.toISOString().split('T')[0],
    },
  };
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
