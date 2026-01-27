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
            customerKey = :customerKey,
            channel = :channel,
            agentId = :agentId,
            teamId = :teamId,
            queueId = :queueId,
            startedAt = if_not_exists(startedAt, :receivedAt),
            updatedAt = :now,
            createdAt = if_not_exists(createdAt, :now),
            operatorCount = if_not_exists(operatorCount, :zero) + :one,
            entityType = :entityType
            ${Object.keys(gsiAttributes).length > 0 ? ', ' + Object.keys(gsiAttributes).map(k => `${k} = :${k}`).join(', ') : ''}
      `,
      ExpressionAttributeValues: {
        ':conversationId': conversationId,
        ':tenantId': tenantId,
        ':customerKey': metadata.customerKey || null,
        ':channel': metadata.channel || 'unknown',
        ':agentId': metadata.agentId || null,
        ':teamId': metadata.teamId || null,
        ':queueId': metadata.queueId || null,
        ':receivedAt': receivedAt,
        ':now': now,
        ':zero': 0,
        ':one': 1,
        ':entityType': 'CONVERSATION',
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
        s3Uri,
        displayFields,
        enrichedPayload,
        enrichedAt,
        enrichmentError,
        receivedAt,
        entityType: 'OPERATOR_RESULT',
      },
    })
  );
}

interface UpdateAggregatesParams {
  tenantId: string;
  operatorName: string;
  payload: Record<string, unknown>;
  receivedAt: string;
}

export async function updateAggregates(params: UpdateAggregatesParams): Promise<void> {
  const { tenantId, operatorName, payload, receivedAt } = params;
  const date = formatDate(new Date(receivedAt));

  // Always increment conversation count and operator-specific count
  await incrementMetric(tenantId, date, 'conversation_count', 1);
  await incrementMetric(tenantId, date, `operator_${operatorName}_count`, 1);

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
}

async function incrementMetric(
  tenantId: string,
  date: string,
  metricName: string,
  increment: number
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: keys.aggregatePK(tenantId),
        SK: keys.aggregateSK(date, metricName),
      },
      UpdateExpression: 'SET #value = if_not_exists(#value, :zero) + :increment, entityType = :entityType, metricName = :metricName, #date = :date, tenantId = :tenantId',
      ExpressionAttributeNames: {
        '#value': 'value',
        '#date': 'date',
      },
      ExpressionAttributeValues: {
        ':zero': 0,
        ':increment': increment,
        ':entityType': 'AGGREGATE',
        ':metricName': metricName,
        ':date': date,
        ':tenantId': tenantId,
      },
    })
  );
}
