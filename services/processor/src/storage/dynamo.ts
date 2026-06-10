import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { writeIndexRecord } from './index-writer';

// Comma-separated enrichment field names that get an inverse index record at
// writeConversation time, making them filterable via ?<field>=<value> on the
// conversations API. Empty by default — opt-in per deployment via CDK.
const ENRICHMENT_FILTERABLE_FIELDS = (process.env.CIRL_ENRICHMENT_FILTERABLE_FIELDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

export function formatDate(date: Date = new Date()): string {
  return date.toISOString().split('T')[0].replace(/-/g, '');
}

/**
 * Look up an enrichment record by correlation key (callSid or conversationSid)
 * and return its `fields` map. Returns null if the feature flag is off, the
 * key is missing, no record exists, or any read error occurs — enrichment is
 * always best-effort and never blocks the main write path.
 *
 * See docs/enrichment.md for the design rationale.
 */
async function fetchEnrichmentFields(
  tenantId: string,
  callSid: string | null,
  conversationSid: string | null
): Promise<Record<string, unknown> | null> {
  if (process.env.CIRL_ENRICHMENT_ENABLED !== 'true') return null;
  const correlationKey = callSid || conversationSid;
  if (!correlationKey) return null;
  const correlationType = callSid ? 'CALL' : 'CONV';

  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `TENANT#${tenantId}#ENRICHMENT#${correlationType}#${correlationKey}`,
        SK: 'META',
      },
      ProjectionExpression: '#f',
      ExpressionAttributeNames: { '#f': 'fields' },
    }));
    const fields = result.Item?.fields;
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      return fields as Record<string, unknown>;
    }
    return null;
  } catch (err) {
    console.warn('Enrichment lookup failed (non-fatal)', err);
    return null;
  }
}

/**
 * Strip a SIP/tel URI down to just the user portion (typically an E.164
 * number) so downstream logic doesn't have to think about the wrapper format.
 * "sip:+553122980059@54.82.188.43" → "+553122980059"; bare E.164 unchanged.
 */
function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone || typeof phone !== 'string') return null;
  return phone.replace(/^(?:sip|sips|tel):/i, '').split(/[@;?]/)[0];
}

/**
 * Return just the last 4 digits of a phone number for support-lookup
 * filtering. Operates after normalizePhone so SIP URIs work, and strips
 * non-digit characters so any country/area-code formatting variation
 * collapses to a stable suffix.
 */
function phoneLast4(phone: string | null | undefined): string | null {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const digits = normalized.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Mask a phone number, keeping the country/area-code prefix and the last 4
 * digits visible. E.g. "+5511976932682" → "+5511****2682".
 *
 * SIP/tel URIs are normalized to the bare number first, so calls arriving as
 * "sip:+553122980059@54.82.188.43" get masked as "+5531****0059" rather than
 * exposing the SIP host or losing the country code to the URI prefix.
 *
 * Short or unrecognized inputs are returned without masking — there's nothing
 * meaningful to hide when only a handful of digits are present.
 *
 * Phone numbers are PII; the raw value is still available inside the spine's
 * channel.participants[] payload for support tooling that genuinely needs it.
 */
function maskPhone(phone: string | null | undefined): string | null {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  if (normalized.length <= 9) return normalized;
  return `${normalized.slice(0, 5)}${'*'.repeat(normalized.length - 9)}${normalized.slice(-4)}`;
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

  // Promote upstream channel SIDs to top-level fields so support tooling can
  // jump from a CIRL conversation to the underlying Twilio resource (Call,
  // Conversation, Recording) without parsing nested JSON.
  const channelObj =
    typeof metadata.channel === 'object' && metadata.channel !== null
      ? (metadata.channel as Record<string, unknown>)
      : null;
  const mediaProps =
    (channelObj?.media_properties as Record<string, unknown> | undefined) ?? {};
  const refSids =
    (mediaProps.reference_sids as Record<string, string> | undefined) ?? {};
  const participants =
    (channelObj?.participants as Array<Record<string, unknown>> | undefined) ?? [];
  const customerRaw = participants.find(
    p => p.role === 'Customer'
  )?.media_participant_id as string | undefined;

  // Best-effort write-time enrichment merge. If a producer (Studio, customer
  // backend, dispatcher, etc.) already POSTed enrichment for this call's
  // correlation key, fold it into the spine now so consumers see it on the
  // first read. Late-arriving enrichment is picked up by the API at read time
  // instead — see docs/enrichment.md.
  const callSid = refSids.call_sid ?? null;
  const conversationSid = refSids.conversation_sid ?? null;
  const enrichmentFields = await fetchEnrichmentFields(tenantId, callSid, conversationSid);

  const customerPhoneLast4 = phoneLast4(customerRaw);

  // Build payload with entity-specific attributes (spine + payload pattern)
  const payload: Record<string, unknown> = {
    ...existingPayload,
    customerKey: metadata.customerKey || null,
    channel: metadata.channel || 'unknown',
    sourceType: (mediaProps.source as string | undefined) ?? null,
    sourceSid: (mediaProps.source_sid as string | undefined) ?? null,
    callSid,
    conversationSid,
    referenceSids: refSids,
    // Masked customer phone for safe surfacing in dashboards/BI. The raw value
    // is still nested under channel.participants[] for tooling that needs it.
    customerPhone: maskPhone(customerRaw),
    // Just the last 4 digits — exposes a filterable handle for support
    // lookups ("find the customer whose number ends in 2682") without
    // surfacing the full phone in query strings.
    customerPhoneLast4,
    agentId: metadata.agentId || null,
    teamId: metadata.teamId || null,
    queueId: metadata.queueId || null,
    operatorCount: (existingPayload.operatorCount as number || 0) + 1,
  };
  if (enrichmentFields) {
    payload.enrichment = enrichmentFields;
  } else if (existingPayload.enrichment) {
    // Preserve previously-merged enrichment if a later lookup happens to fail.
    payload.enrichment = existingPayload.enrichment;
  }

  // Write inverse index records that make spine-level fields filterable on
  // the conversations API. Same PK pattern as the operator-config indexes;
  // best-effort so a failed index write doesn't kill the spine update.
  try {
    if (customerPhoneLast4) {
      await writeIndexRecord(tenantId, 'customer_phone_last4', customerPhoneLast4, conversationId, timestamp);
    }
    // For each enrichment field flagged as filterable, write an inverse
    // index record. The merged value comes from the spine payload (already
    // includes write-time enrichment merge results).
    const enrichmentForIndex = (payload.enrichment as Record<string, unknown> | null | undefined) ?? null;
    if (enrichmentForIndex) {
      for (const fieldName of ENRICHMENT_FILTERABLE_FIELDS) {
        const value = enrichmentForIndex[fieldName];
        if (value !== null && value !== undefined && value !== '') {
          await writeIndexRecord(tenantId, fieldName, String(value), conversationId, timestamp);
        }
      }
    }
  } catch (err) {
    console.warn('Index write failed (non-fatal)', err);
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
  const { tenantId, conversationId, operatorName, receivedAt } = params;
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

  // Operator-specific aggregates are now handled by the config-driven
  // aggregation engine (aggregation-engine.ts). The handler calls
  // aggregateFromConfig() before this function. If no config exists for
  // an operator, this function receives the full payload as a fallback —
  // but all known operators should have configs in operator-metrics.json.
}

/**
 * Conditional dedup marker for per-(operator, conversation, day) aggregation.
 * Returns true if this is the first time we see this triple (caller should
 * proceed to aggregate). Returns false if a marker already existed (caller
 * should skip aggregation — the conversation was already counted by an
 * earlier webhook fire).
 *
 * Used by aggregateFromConfig when an operator declares dedupBy: "conversation"
 * — typically v3 operators wired to a rule that fires per-message but whose
 * metric should still count one observation per conversation.
 */
export async function claimOperatorConversationSlot(
  tenantId: string,
  date: string,
  operatorName: string,
  conversationId: string
): Promise<boolean> {
  const markerKey = {
    PK: `TENANT#${tenantId}#OP_SEEN#${date}#${operatorName}`,
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
    return true;
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') return false;
    throw error;
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

export async function incrementMetric(
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
