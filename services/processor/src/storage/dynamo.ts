import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

// Key generation utilities
const keys = {
  conversationPK: (tenantId: string) => `TENANT#${tenantId}#CONV`,
  conversationSK: (timestamp: string, conversationId: string) =>
    `TS#${timestamp}#CONV#${conversationId}`,
  operatorPK: (tenantId: string, conversationId: string) =>
    `TENANT#${tenantId}#CONV#${conversationId}`,
  operatorSK: (operatorName: string, version: string, timestamp: string) =>
    `OP#${operatorName}#V#${version}#TS#${timestamp}`,
  aggregatePK: (tenantId: string) => `TENANT#${tenantId}#AGG#DAY`,
  aggregateSK: (date: string, metricName: string) => `DAY#${date}#METRIC#${metricName}`,
};

const gsiKeys = {
  gsi1PK: (tenantId: string, agentId: string) => `TENANT#${tenantId}#AGENT#${agentId}`,
  gsi1SK: (timestamp: string, conversationId: string) => `TS#${timestamp}#CONV#${conversationId}`,
  gsi2PK: (tenantId: string, queueId: string) => `TENANT#${tenantId}#QUEUE#${queueId}`,
  gsi2SK: (timestamp: string) => `TS#${timestamp}`,
  gsi3PK: (tenantId: string, customerKey: string) => `TENANT#${tenantId}#CK#${customerKey}`,
  gsi3SK: (timestamp: string) => `TS#${timestamp}`,
};

function formatTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '').split('.')[0];
}

function formatDate(date: Date = new Date()): string {
  return date.toISOString().split('T')[0].replace(/-/g, '');
}

interface WriteConversationParams {
  tenantId: string;
  conversationId: string;
  metadata: Record<string, unknown>;
  receivedAt: string;
}

export async function writeConversation(params: WriteConversationParams): Promise<void> {
  const { tenantId, conversationId, metadata, receivedAt } = params;
  const timestamp = formatTimestamp(new Date(receivedAt));
  const now = new Date().toISOString();

  // Build GSI keys if metadata contains the relevant fields
  const gsiAttributes: Record<string, string> = {};

  if (metadata.agentId) {
    gsiAttributes.GSI1PK = gsiKeys.gsi1PK(tenantId, metadata.agentId as string);
    gsiAttributes.GSI1SK = gsiKeys.gsi1SK(timestamp, conversationId);
  }

  if (metadata.queueId) {
    gsiAttributes.GSI2PK = gsiKeys.gsi2PK(tenantId, metadata.queueId as string);
    gsiAttributes.GSI2SK = gsiKeys.gsi2SK(timestamp);
  }

  if (metadata.customerKey) {
    gsiAttributes.GSI3PK = gsiKeys.gsi3PK(tenantId, metadata.customerKey as string);
    gsiAttributes.GSI3SK = gsiKeys.gsi3SK(timestamp);
  }

  // First, get existing payload to preserve data across updates
  let existingPayload: Record<string, unknown> = {};
  try {
    const existing = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: keys.conversationPK(tenantId),
          SK: keys.conversationSK(timestamp, conversationId),
        },
        ProjectionExpression: 'payload',
      })
    );
    if (existing.Item?.payload) {
      existingPayload = JSON.parse(existing.Item.payload as string);
    }
  } catch (error) {
    // Item doesn't exist yet, that's fine
  }

  // Build payload with entity-specific attributes (spine + payload pattern)
  const payload = {
    ...existingPayload,
    customerKey: metadata.customerKey || null,
    channel: metadata.channel || 'unknown',
    agentId: metadata.agentId || null,
    teamId: metadata.teamId || null,
    queueId: metadata.queueId || null,
    operatorCount: (existingPayload.operatorCount as number || 0) + 1,
  };

  // Use UpdateCommand to create or update conversation header
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: keys.conversationPK(tenantId),
        SK: keys.conversationSK(timestamp, conversationId),
      },
      UpdateExpression: `
        SET conversationId = :conversationId,
            tenantId = :tenantId,
            startedAt = if_not_exists(startedAt, :receivedAt),
            updatedAt = :now,
            createdAt = if_not_exists(createdAt, :now),
            entityType = :entityType,
            payload = :payload
            ${Object.keys(gsiAttributes).length > 0 ? ', ' + Object.keys(gsiAttributes).map(k => `${k} = :${k}`).join(', ') : ''}
      `,
      ExpressionAttributeValues: {
        ':conversationId': conversationId,
        ':tenantId': tenantId,
        ':receivedAt': receivedAt,
        ':now': now,
        ':entityType': 'CONVERSATION',
        ':payload': JSON.stringify(payload),
        ...Object.fromEntries(Object.entries(gsiAttributes).map(([k, v]) => [`:${k}`, v])),
      },
    })
  );
}

interface WriteOperatorResultParams {
  tenantId: string;
  conversationId: string;
  operatorName: string;
  schemaVersion: string;
  s3Uri: string;
  displayFields: Record<string, unknown>;
  enrichedPayload: Record<string, unknown>;
  enrichedAt?: string;
  enrichmentError?: string;
  receivedAt: string;
}

export async function writeOperatorResult(params: WriteOperatorResultParams): Promise<void> {
  const {
    tenantId,
    conversationId,
    operatorName,
    schemaVersion,
    s3Uri,
    displayFields,
    enrichedPayload,
    enrichedAt,
    enrichmentError,
    receivedAt,
  } = params;

  const timestamp = formatTimestamp(new Date(receivedAt));

  // Build payload with entity-specific attributes (spine + payload pattern)
  const payload = {
    s3Uri,
    displayFields,
    enrichedPayload,
    enrichedAt,
    enrichmentError,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: keys.operatorPK(tenantId, conversationId),
        SK: keys.operatorSK(operatorName, schemaVersion, timestamp),
        conversationId,
        tenantId,
        operatorName,
        schemaVersion,
        receivedAt,
        entityType: 'OPERATOR_RESULT',
        payload: JSON.stringify(payload),
      },
    })
  );
}

interface UpdateAggregatesParams {
  tenantId: string;
  conversationId: string;
  operatorName: string;
  payload: Record<string, unknown>;
  receivedAt: string;
}

export async function updateAggregates(params: UpdateAggregatesParams): Promise<void> {
  const { tenantId, conversationId, operatorName, payload, receivedAt } = params;
  const date = formatDate(new Date(receivedAt));

  // Always increment operator-specific count
  await incrementMetric(tenantId, date, `operator_${operatorName}_count`, 1);

  // Increment conversation_count only once per conversation per day.
  // Use a conditional put — if the marker already exists, skip the increment.
  const markerKey = {
    PK: `TENANT#${tenantId}#CONV_SEEN#${date}`,
    SK: `CONV#${conversationId}`,
  };
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { ...markerKey, ttl: Math.floor(Date.now() / 1000) + 86400 * 7 },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    // Marker didn't exist → first operator for this conversation today
    await incrementMetric(tenantId, date, 'conversation_count', 1);
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      // Marker already exists → conversation already counted today, skip
    } else {
      throw error;
    }
  }

  // Operator-specific aggregates
  if (operatorName === 'sentiment' || payload.overall_sentiment || payload.sentiment_score) {
    // Sentiment aggregates
    const sentiment = payload.overall_sentiment as string;
    if (sentiment) {
      await incrementMetric(tenantId, date, `sentiment_${sentiment}`, 1);
    }

    const score = payload.sentiment_score as number;
    if (typeof score === 'number') {
      await incrementMetric(tenantId, date, 'sentiment_score_sum', score);
      await incrementMetric(tenantId, date, 'sentiment_score_count', 1);
    }
  }

  // PII detection metrics
  if (operatorName === 'pii-detect' || operatorName === 'pii-extract') {
    const entities = payload.entities || payload.pii_entities;
    if (Array.isArray(entities)) {
      await incrementMetric(tenantId, date, 'pii_entities_detected', entities.length);
      await incrementMetric(tenantId, date, 'pii_conversations_with_entities', 1);
    }
  }

  // Conversation summary metrics
  if (operatorName === 'conversation-summary' || operatorName === 'summary') {
    const summary = payload.summary || payload.text || payload.text_generation_results;
    if (summary && typeof summary === 'string') {
      const wordCount = summary.split(/\s+/).length;
      await incrementMetric(tenantId, date, 'summary_word_count_sum', wordCount);
      await incrementMetric(tenantId, date, 'summary_word_count_count', 1);
    }
  }

  // Classification metrics (conversation-classify, utterance-classify)
  if (operatorName.includes('classify') || payload.predicted_label || payload.label_probabilities) {
    const label = payload.predicted_label as string;
    if (label) {
      await incrementMetric(tenantId, date, `classification_${label}`, 1);
    }

    const probability = payload.predicted_probability as number;
    if (typeof probability === 'number') {
      await incrementMetric(tenantId, date, 'classification_confidence_sum', probability);
      await incrementMetric(tenantId, date, 'classification_confidence_count', 1);
    }
  }

  // Consolidated conversation-intelligence operator (supports multiple operator name variations)
  if (operatorName === 'conversation-intelligence' || operatorName === '[CIRL] Conversation Summary') {
    // Sentiment metrics from nested structure
    const sentiment = payload.sentiment as Record<string, unknown>;
    if (sentiment) {
      const overall = sentiment.overall as string;
      if (overall) {
        await incrementMetric(tenantId, date, `sentiment_${overall}`, 1);
      }

      const score = sentiment.score as number;
      if (typeof score === 'number') {
        await incrementMetric(tenantId, date, 'sentiment_score_sum', score);
        await incrementMetric(tenantId, date, 'sentiment_score_count', 1);
      }
    }

    // Summary metrics from nested structure
    const summary = payload.summary as Record<string, unknown>;
    if (summary) {
      const text = (summary.text || summary.paragraph) as string;
      if (text && typeof text === 'string') {
        const wordCount = text.split(/\s+/).length;
        await incrementMetric(tenantId, date, 'summary_word_count_sum', wordCount);
        await incrementMetric(tenantId, date, 'summary_word_count_count', 1);
      }
    }

    // Classification metrics from nested structure (renamed from intent)
    const classification = (payload.classification || payload.intent) as Record<string, unknown>;
    if (classification) {
      const resolutionStatus = classification.resolution_status as string;
      if (resolutionStatus) {
        await incrementMetric(tenantId, date, `resolution_${resolutionStatus}`, 1);
      }

      const primaryIntent = classification.primary_intent || classification.primary as string;
      if (primaryIntent) {
        await incrementMetric(tenantId, date, `intent_${primaryIntent}`, 1);
      }

      const primaryConfidence = (classification.primary_confidence || classification.primary_confidence) as number;
      if (typeof primaryConfidence === 'number') {
        await incrementMetric(tenantId, date, 'intent_confidence_sum', primaryConfidence);
        await incrementMetric(tenantId, date, 'intent_confidence_count', 1);
      }
    }

    // Quality metrics from nested structure
    const quality = payload.quality as Record<string, unknown>;
    if (quality) {
      // Virtual agent quality metrics
      const virtualAgent = quality.virtual_agent as Record<string, unknown>;
      if (virtualAgent) {
        const qualityScore = virtualAgent.quality_score as number;
        if (typeof qualityScore === 'number') {
          await incrementMetric(tenantId, date, 'virtual_agent_quality_sum', qualityScore);
          await incrementMetric(tenantId, date, 'virtual_agent_quality_count', 1);
        }

        // Track boolean success metrics
        if (virtualAgent.resolved_questions === true) {
          await incrementMetric(tenantId, date, 'virtual_agent_resolved_questions', 1);
        }
        if (virtualAgent.avoided_hallucinations === true) {
          await incrementMetric(tenantId, date, 'virtual_agent_avoided_hallucinations', 1);
        }
        if (virtualAgent.avoided_repetitions === true) {
          await incrementMetric(tenantId, date, 'virtual_agent_avoided_repetitions', 1);
        }
        if (virtualAgent.resolved_without_human === true) {
          await incrementMetric(tenantId, date, 'virtual_agent_resolved_without_human', 1);
        }
        if (virtualAgent.maintained_consistency === true) {
          await incrementMetric(tenantId, date, 'virtual_agent_maintained_consistency', 1);
        }
      }

      // Human agent quality metrics (only if transferred)
      const humanAgent = quality.human_agent as Record<string, unknown>;
      if (humanAgent) {
        const wasTransferred = humanAgent.was_transferred as boolean;
        if (wasTransferred === true) {
          await incrementMetric(tenantId, date, 'human_agent_transfers', 1);

          const qualityScore = humanAgent.quality_score as number;
          if (typeof qualityScore === 'number') {
            await incrementMetric(tenantId, date, 'human_agent_quality_sum', qualityScore);
            await incrementMetric(tenantId, date, 'human_agent_quality_count', 1);
          }

          // Track boolean success metrics
          if (humanAgent.resolved_questions === true) {
            await incrementMetric(tenantId, date, 'human_agent_resolved_questions', 1);
          }
          if (humanAgent.was_cordial === true) {
            await incrementMetric(tenantId, date, 'human_agent_was_cordial', 1);
          }
          if (humanAgent.avoided_repetitions === true) {
            await incrementMetric(tenantId, date, 'human_agent_avoided_repetitions', 1);
          }
          if (humanAgent.resolved_problem === true) {
            await incrementMetric(tenantId, date, 'human_agent_resolved_problem', 1);
          }
          if (humanAgent.clear_closing === true) {
            await incrementMetric(tenantId, date, 'human_agent_clear_closing', 1);
          }
        }
      }
    }
  }

  // POC Analytics operator (FriendlyName: "Analytics" in Twilio)
  if (operatorName === 'Analytics') {
    // AI retention: whether AI solved without human transfer
    const aiRetained = payload.ai_retained;
    if (typeof aiRetained === 'boolean') {
      await incrementMetric(tenantId, date, 'poc_ai_retained_count', aiRetained ? 1 : 0);
      await incrementMetric(tenantId, date, 'poc_ai_not_retained_count', aiRetained ? 0 : 1);
      await incrementMetric(tenantId, date, 'poc_ai_retained_total', 1);
    }

    // Topic tracking
    const topic = payload.topic as string;
    if (topic && typeof topic === 'string') {
      await incrementMetric(tenantId, date, `poc_topic_${topic.toLowerCase()}`, 1);
    }

    // Back to IVR
    const backToIvr = payload.back_to_ivr;
    if (typeof backToIvr === 'boolean' && backToIvr) {
      await incrementMetric(tenantId, date, 'poc_back_to_ivr_count', 1);
    }

    // Asked for human
    const askedForHuman = payload.asked_for_human;
    if (typeof askedForHuman === 'boolean' && askedForHuman) {
      await incrementMetric(tenantId, date, 'poc_asked_for_human_count', 1);
    }

    // Inferred CSAT (1-5 scale)
    const inferredCsat = payload.inferred_csat as number;
    if (typeof inferredCsat === 'number' && inferredCsat >= 1 && inferredCsat <= 5) {
      await incrementMetric(tenantId, date, 'poc_csat_sum', inferredCsat);
      await incrementMetric(tenantId, date, 'poc_csat_count', 1);
      // Track distribution
      await incrementMetric(tenantId, date, `poc_csat_${inferredCsat}`, 1);
    }

    // AI errors (hallucinations, misconceptions, misunderstandings)
    const errors = payload.errors;
    if (typeof errors === 'boolean' && errors) {
      await incrementMetric(tenantId, date, 'poc_errors_count', 1);
    }
  }

  // General KPIs operator (FriendlyName: "MVP - Inter - General KPIs")
  // Tracks integer scores (0-10 or similar) for AI quality dimensions.
  // NOTE: Matching by friendly name is fragile — if renamed in Twilio Console,
  // aggregation silently stops. For production, consider matching by operator SID
  // or using a config mapping (e.g., env var or DynamoDB config table).
  if (operatorName === 'MVP - Inter - General KPIs') {
    const intMetrics: Array<{ field: string; metric: string }> = [
      { field: 'precisao', metric: 'kpi_precisao' },
      { field: 'cobertura_conhecimento', metric: 'kpi_cobertura_conhecimento' },
      { field: 'alucinacoes', metric: 'kpi_alucinacoes' },
      { field: 'compreensao', metric: 'kpi_compreensao' },
      { field: 'aderencia', metric: 'kpi_aderencia' },
    ];

    for (const { field, metric } of intMetrics) {
      const value = payload[field] as number;
      if (typeof value === 'number') {
        await incrementMetric(tenantId, date, `${metric}_sum`, value);
        await incrementMetric(tenantId, date, `${metric}_count`, 1);
      }
    }

    // Desambiguador (boolean) — track how often disambiguation was needed
    const desambiguador = payload.desambiguador;
    if (typeof desambiguador === 'boolean' && desambiguador) {
      await incrementMetric(tenantId, date, 'kpi_desambiguador_count', 1);
    }
    if (typeof desambiguador === 'boolean') {
      await incrementMetric(tenantId, date, 'kpi_desambiguador_total', 1);
    }
  }
}

/**
 * Aggregate timing metrics from transcript sentences.
 * These are computed by the ingest Lambda from Twilio sentence data and passed
 * through EventBridge metadata. We track sums and counts for averaging in the API.
 *
 * Metrics produced:
 *   handling_time_sum / handling_time_count  → avg_handling_time_sec
 *   response_time_sum / response_time_count  → avg_response_time_sec
 *   customer_wait_time_sum / customer_wait_time_count → avg_customer_wait_time_sec
 */
interface UpdateTimingAggregatesParams {
  tenantId: string;
  timingMetrics: Record<string, number>;
  receivedAt: string;
}

export async function updateTimingAggregates(params: UpdateTimingAggregatesParams): Promise<void> {
  const { tenantId, timingMetrics, receivedAt } = params;
  const date = formatDate(new Date(receivedAt));

  const {
    handlingTimeSec,
    avgResponseTimeSec,
    avgCustomerWaitTimeSec,
    sentenceCount,
    agentSentenceCount,
    customerSentenceCount,
  } = timingMetrics;

  // Handling time (total conversation duration)
  if (typeof handlingTimeSec === 'number' && handlingTimeSec > 0) {
    await incrementMetric(tenantId, date, 'handling_time_sum', handlingTimeSec);
    await incrementMetric(tenantId, date, 'handling_time_count', 1);
  }

  // Agent response time (time from customer utterance end → agent response start)
  if (typeof avgResponseTimeSec === 'number' && avgResponseTimeSec > 0) {
    await incrementMetric(tenantId, date, 'response_time_sum', avgResponseTimeSec);
    await incrementMetric(tenantId, date, 'response_time_count', 1);
  }

  // Customer wait time (time from agent utterance end → customer response start)
  if (typeof avgCustomerWaitTimeSec === 'number' && avgCustomerWaitTimeSec > 0) {
    await incrementMetric(tenantId, date, 'customer_wait_time_sum', avgCustomerWaitTimeSec);
    await incrementMetric(tenantId, date, 'customer_wait_time_count', 1);
  }

  // Sentence counts
  if (typeof sentenceCount === 'number') {
    await incrementMetric(tenantId, date, 'sentence_count_total', sentenceCount);
  }
  if (typeof agentSentenceCount === 'number') {
    await incrementMetric(tenantId, date, 'agent_sentence_count', agentSentenceCount);
  }
  if (typeof customerSentenceCount === 'number') {
    await incrementMetric(tenantId, date, 'customer_sentence_count', customerSentenceCount);
  }
}

async function incrementMetric(
  tenantId: string,
  date: string,
  metricName: string,
  increment: number
): Promise<void> {
  // First, get existing payload to preserve data
  let currentValue = 0;
  try {
    const existing = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: keys.aggregatePK(tenantId),
          SK: keys.aggregateSK(date, metricName),
        },
        ProjectionExpression: 'payload',
      })
    );
    if (existing.Item?.payload) {
      const existingPayload = JSON.parse(existing.Item.payload as string);
      currentValue = existingPayload.value || 0;
    }
  } catch (error) {
    // Item doesn't exist yet, that's fine
  }

  // Build payload with the new value (spine + payload pattern)
  const payload = {
    value: currentValue + increment,
  };

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: keys.aggregatePK(tenantId),
        SK: keys.aggregateSK(date, metricName),
      },
      UpdateExpression: 'SET entityType = :entityType, metricName = :metricName, #date = :date, tenantId = :tenantId, payload = :payload',
      ExpressionAttributeNames: {
        '#date': 'date',
      },
      ExpressionAttributeValues: {
        ':entityType': 'AGGREGATE',
        ':metricName': metricName,
        ':date': date,
        ':tenantId': tenantId,
        ':payload': JSON.stringify(payload),
      },
    })
  );
}
