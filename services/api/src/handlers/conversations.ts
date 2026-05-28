import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  QueryCommandInput,
  BatchGetCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ensureConfigLoaded,
  getListSurfaceFields,
  getFilterableFieldNames,
  getCategoryArrayPairs,
} from '@cirl/shared';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

// Filterable spine fields that aren't driven by operator-metrics.json. Anything
// here is recognized as a query-string filter on /conversations and resolves
// to an O(1) lookup against the corresponding index record written by the
// processor.
const BUILTIN_FILTERABLE_FIELDS = ['customer_phone_last4'];

// Enrichment fields opted in via CIRL_ENRICHMENT_FILTERABLE_FIELDS env var
// (comma-separated). Processor writes inverse indexes for these at
// writeConversation time. See docs/enrichment.md.
const ENRICHMENT_FILTERABLE_FIELDS = (process.env.CIRL_ENRICHMENT_FILTERABLE_FIELDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function allFilterableFieldNames(): string[] {
  return [
    ...getFilterableFieldNames(),
    ...BUILTIN_FILTERABLE_FIELDS,
    ...ENRICHMENT_FILTERABLE_FIELDS,
  ];
}

interface ListConversationsParams {
  from?: string;
  to?: string;
  agentId?: string;
  queueId?: string;
  customerKey?: string;
  limit?: string;
  nextToken?: string;
  [key: string]: string | undefined; // Allow arbitrary query params for index filters
}

export async function listConversations(
  tenantId: string,
  params: ListConversationsParams
): Promise<{ items: unknown[]; nextToken?: string }> {
  // Load config and check for indexed field filters
  await ensureConfigLoaded();
  const indexFilter = findIndexFilter(
    params,
    allFilterableFieldNames(),
    getCategoryArrayPairs()
  );

  if (indexFilter) {
    return queryByIndex(tenantId, indexFilter, params);
  }
  const { from, to, agentId, queueId, customerKey, limit = '50', nextToken } = params;
  const pageLimit = Math.min(parseInt(limit, 10) || 50, 500);

  let queryParams: QueryCommandInput;

  // Determine which index to use based on filters
  if (agentId) {
    // Use GSI1 (by agent)
    queryParams = {
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}#AGENT#${agentId}`,
      },
      ScanIndexForward: false, // Most recent first
      Limit: pageLimit,
    };
  } else if (queueId) {
    // Use GSI2 (by queue)
    queryParams = {
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}#QUEUE#${queueId}`,
      },
      ScanIndexForward: false,
      Limit: pageLimit,
    };
  } else if (customerKey) {
    // Use GSI3 (by customerKey)
    queryParams = {
      TableName: TABLE_NAME,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}#CK#${customerKey}`,
      },
      ScanIndexForward: false,
      Limit: pageLimit,
    };
  } else {
    // Use main table
    queryParams = {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}#CONV`,
      },
      ScanIndexForward: false,
      Limit: pageLimit,
    };
  }

  // Add date range filter if provided
  if (from || to) {
    const fromTs = from ? formatTimestamp(new Date(from)) : '00000000000000';
    // Set toTs to end of day (23:59:59) to include the full day
    const toTs = to ? formatTimestamp(new Date(to)).slice(0, 8) + '235959' : '99999999999999';

    if (queryParams.KeyConditionExpression?.includes('GSI')) {
      // For GSIs, add SK condition
      const skAttr = agentId ? 'GSI1SK' : queueId ? 'GSI2SK' : 'GSI3SK';
      queryParams.KeyConditionExpression += ` AND ${skAttr} BETWEEN :fromTs AND :toTs`;
    } else {
      queryParams.KeyConditionExpression += ' AND SK BETWEEN :fromTs AND :toTs';
    }
    queryParams.ExpressionAttributeValues![':fromTs'] = `TS#${fromTs}`;
    queryParams.ExpressionAttributeValues![':toTs'] = `TS#${toTs}#CONV#zzzzzzzz`;
  }

  // Add pagination token
  if (nextToken) {
    try {
      queryParams.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString());
    } catch {
      // Invalid token, ignore
    }
  }

  const result = await docClient.send(new QueryCommand(queryParams));

  const baseItems = (result.Items || []).map(item => {
    // Parse payload to access entity-specific fields (spine + payload pattern)
    const payload = item.payload ? JSON.parse(item.payload as string) : {};

    return {
      conversationId: item.conversationId as string,
      tenantId: item.tenantId as string,
      customerKey: payload.customerKey,
      customerPhone: payload.customerPhone ?? null,
      customerPhoneLast4: payload.customerPhoneLast4 ?? null,
      channel: payload.channel,
      sourceType: payload.sourceType ?? null,
      sourceSid: payload.sourceSid ?? null,
      callSid: payload.callSid ?? null,
      conversationSid: payload.conversationSid ?? null,
      referenceSids: payload.referenceSids ?? {},
      enrichment: payload.enrichment ?? null,
      agentId: payload.agentId,
      teamId: payload.teamId,
      queueId: payload.queueId,
      startedAt: item.startedAt,
      operatorCount: payload.operatorCount,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });

  // Enrich with operator fields from config (surfaceInList flag)
  // ensureConfigLoaded already called at top of function
  const fieldsConfig = getListSurfaceFields();
  const hasOperatorFields = Object.keys(fieldsConfig).length > 0;
  const enrichedItems = hasOperatorFields
    ? await enrichWithOperatorFields(tenantId, baseItems, fieldsConfig)
    : baseItems;

  // Late-arrival enrichment merge — no-op when feature flag is off.
  const items = await mergeEnrichment(tenantId, enrichedItems);

  const response: { items: unknown[]; nextToken?: string } = { items };

  if (result.LastEvaluatedKey) {
    response.nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
  }

  return response;
}

export async function getConversation(
  tenantId: string,
  conversationId: string
): Promise<{ conversation: unknown; operators: unknown[] } | null> {
  // Query for conversation header using the conversationId attribute
  // Note: Limit is applied BEFORE FilterExpression in DynamoDB, so we don't use Limit here
  const headerResult = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: 'conversationId = :convId',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}#CONV`,
        ':convId': conversationId,
      },
    })
  );

  if (!headerResult.Items || headerResult.Items.length === 0) {
    return null;
  }

  const conversation = headerResult.Items[0];

  // Get operator results for this conversation
  const operatorResult = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}#CONV#${conversationId}`,
        ':skPrefix': 'OP#',
      },
    })
  );

  const operators = (operatorResult.Items || []).map(item => {
    // Parse payload to access entity-specific fields (spine + payload pattern)
    const payload = item.payload ? JSON.parse(item.payload as string) : {};

    return {
      operatorName: item.operatorName,
      schemaVersion: item.schemaVersion,
      displayFields: payload.displayFields,
      enrichedPayload: payload.enrichedPayload,
      enrichedAt: payload.enrichedAt,
      enrichmentError: payload.enrichmentError,
      receivedAt: item.receivedAt,
      s3Uri: payload.s3Uri,
    };
  });

  // Parse conversation payload
  const conversationPayload = conversation.payload ? JSON.parse(conversation.payload as string) : {};

  const conversationRow: Record<string, unknown> = {
    conversationId: conversation.conversationId,
    tenantId: conversation.tenantId,
    customerKey: conversationPayload.customerKey,
    customerPhone: conversationPayload.customerPhone ?? null,
    customerPhoneLast4: conversationPayload.customerPhoneLast4 ?? null,
    channel: conversationPayload.channel,
    sourceType: conversationPayload.sourceType ?? null,
    sourceSid: conversationPayload.sourceSid ?? null,
    callSid: conversationPayload.callSid ?? null,
    conversationSid: conversationPayload.conversationSid ?? null,
    referenceSids: conversationPayload.referenceSids ?? {},
    enrichment: conversationPayload.enrichment ?? null,
    agentId: conversationPayload.agentId,
    teamId: conversationPayload.teamId,
    queueId: conversationPayload.queueId,
    startedAt: conversation.startedAt,
    operatorCount: conversationPayload.operatorCount,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };

  // Late-arrival enrichment merge for the single-record path.
  const [merged] = await mergeEnrichment(conversation.tenantId as string, [conversationRow]);

  return {
    conversation: merged,
    operators,
  };
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '').split('.')[0];
}

/**
 * Late-arrival enrichment merge for conversation responses.
 *
 * Even when write-time merge runs in the processor, an enrichment record can
 * arrive *after* the spine has been written (Studio retries, slow upstream
 * systems, manual backfill). The API does a second-pass BatchGet on enrichment
 * records keyed by each row's callSid/conversationSid and merges the result
 * into the response. See docs/enrichment.md.
 *
 * No-ops when the feature flag is off so deployments that don't use enrichment
 * pay zero overhead.
 */
async function mergeEnrichment(
  tenantId: string,
  conversations: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  if (process.env.CIRL_ENRICHMENT_ENABLED !== 'true') return conversations;
  if (conversations.length === 0) return conversations;

  // Build the BatchGet key set. We dedupe so a callSid (or conversationSid)
  // appearing on multiple rows only counts as one DDB key.
  const keySet = new Set<string>();
  const keyToCorrelation: Array<{ pk: string; correlationKey: string; type: 'CALL' | 'CONV' }> = [];
  for (const conv of conversations) {
    const callSid = conv.callSid as string | null | undefined;
    const conversationSid = conv.conversationSid as string | null | undefined;
    if (callSid) {
      const pk = `TENANT#${tenantId}#ENRICHMENT#CALL#${callSid}`;
      if (!keySet.has(pk)) {
        keySet.add(pk);
        keyToCorrelation.push({ pk, correlationKey: callSid, type: 'CALL' });
      }
    } else if (conversationSid) {
      const pk = `TENANT#${tenantId}#ENRICHMENT#CONV#${conversationSid}`;
      if (!keySet.has(pk)) {
        keySet.add(pk);
        keyToCorrelation.push({ pk, correlationKey: conversationSid, type: 'CONV' });
      }
    }
  }
  if (keyToCorrelation.length === 0) return conversations;

  // BatchGetItem caps at 100 keys per call. Chunk to be safe for limit=500
  // pages where we might exceed that.
  const fieldsByCorrelation = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < keyToCorrelation.length; i += 100) {
    const chunk = keyToCorrelation.slice(i, i + 100);
    try {
      const result = await docClient.send(new BatchGetCommand({
        RequestItems: {
          [TABLE_NAME]: {
            Keys: chunk.map(c => ({ PK: c.pk, SK: 'META' })),
            ProjectionExpression: 'correlationKey, correlationType, #f',
            ExpressionAttributeNames: { '#f': 'fields' },
          },
        },
      }));
      const items = result.Responses?.[TABLE_NAME] ?? [];
      for (const item of items) {
        const key = `${item.correlationType as string}#${item.correlationKey as string}`;
        const fields = item.fields;
        if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
          fieldsByCorrelation.set(key, fields as Record<string, unknown>);
        }
      }
    } catch (err) {
      // Best-effort: if enrichment lookup fails, return rows unenriched. We
      // don't want a transient DDB hiccup to fail the entire conversations
      // query.
      console.warn('Enrichment BatchGet failed (non-fatal)', err);
      return conversations;
    }
  }

  return conversations.map(conv => {
    const callSid = conv.callSid as string | null | undefined;
    const conversationSid = conv.conversationSid as string | null | undefined;
    const lookupKey = callSid
      ? `CALL#${callSid}`
      : conversationSid
        ? `CONV#${conversationSid}`
        : null;
    const liveFields = lookupKey ? fieldsByCorrelation.get(lookupKey) : undefined;
    // Prefer the latest enrichment from DDB over whatever the spine cached at
    // write time — the API result should always reflect the most recent POST.
    if (liveFields) {
      return { ...conv, enrichment: liveFields };
    }
    return conv;
  });
}

/**
 * Enrich conversation list items with operator result fields.
 * For each conversation, queries its operator results and extracts
 * the fields defined in operatorFieldsConfig.
 *
 * Uses Promise.all for parallel queries — safe at <500 conversations.
 */
async function enrichWithOperatorFields(
  tenantId: string,
  conversations: Array<Record<string, unknown>>,
  fieldsConfig: Record<string, string[]>
): Promise<Array<Record<string, unknown>>> {
  return Promise.all(
    conversations.map(async (conv) => {
      const conversationId = conv.conversationId as string;
      if (!conversationId) return conv;

      try {
        // Query operator results for this conversation
        const opResult = await docClient.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
            ExpressionAttributeValues: {
              ':pk': `TENANT#${tenantId}#CONV#${conversationId}`,
              ':skPrefix': 'OP#',
            },
          })
        );

        // Extract configured fields from matching operators
        const operatorInsights: Record<string, unknown> = {};
        for (const item of opResult.Items || []) {
          const operatorName = item.operatorName as string;
          const configuredFields = fieldsConfig[operatorName];
          if (!configuredFields) continue;

          const payloadStr = item.payload as string;
          if (!payloadStr) continue;

          try {
            const payload = JSON.parse(payloadStr);
            const enriched = payload.enrichedPayload || {};

            for (const field of configuredFields) {
              if (enriched[field] !== undefined) {
                operatorInsights[field] = enriched[field];
              }
            }
          } catch {
            // Invalid payload JSON — skip
          }
        }

        return { ...conv, ...operatorInsights };
      } catch {
        // Query failed — return conversation without enrichment
        return conv;
      }
    })
  );
}

/**
 * Check if any query parameter matches a surfaceInList field.
 * For category_array pairs, both primary + sub keys must be present;
 * the resolved filter then targets the combined index.
 * Returns the first match, or null if none.
 */
function findIndexFilter(
  params: Record<string, string | undefined>,
  surfaceFieldNames: string[],
  pairs: Array<{ primaryKey: string; subKey: string }>
): { fieldName: string; fieldValue: string } | null {
  // Paired filters take precedence — narrower index, fewer post-filter results.
  for (const pair of pairs) {
    const primaryVal = params[pair.primaryKey];
    const subVal = params[pair.subKey];
    if (primaryVal && subVal) {
      return {
        fieldName: pair.subKey,
        fieldValue: `${primaryVal}__${subVal}`,
      };
    }
  }
  for (const field of surfaceFieldNames) {
    if (params[field]) {
      return { fieldName: field, fieldValue: params[field]! };
    }
  }
  return null;
}

/**
 * Query conversations by indexed operator field value.
 * Uses the denormalized index records written at ingestion time.
 */
async function queryByIndex(
  tenantId: string,
  filter: { fieldName: string; fieldValue: string },
  params: ListConversationsParams
): Promise<{ items: unknown[]; nextToken?: string }> {
  const normalizedValue = filter.fieldValue.toLowerCase().replace(/\s+/g, '_');
  const pk = `TENANT#${tenantId}#IDX#${filter.fieldName}#${normalizedValue}`;
  const pageLimit = Math.min(parseInt(params.limit || '50', 10) || 50, 500);

  const queryParams: QueryCommandInput = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': pk,
    },
    ScanIndexForward: false, // Most recent first
    Limit: pageLimit,
  };

  // Date range filter on the index SK
  if (params.from || params.to) {
    const fromTs = params.from ? formatTimestamp(new Date(params.from)) : '00000000000000';
    const toTs = params.to ? formatTimestamp(new Date(params.to)).slice(0, 8) + '235959' : '99999999999999';
    queryParams.KeyConditionExpression += ' AND SK BETWEEN :fromSk AND :toSk';
    queryParams.ExpressionAttributeValues![':fromSk'] = `TS#${fromTs}`;
    queryParams.ExpressionAttributeValues![':toSk'] = `TS#${toTs}#CONV#zzzzzzzz`;
  }

  // Pagination
  if (params.nextToken) {
    try {
      queryParams.ExclusiveStartKey = JSON.parse(Buffer.from(params.nextToken, 'base64').toString());
    } catch {
      // Invalid token, ignore
    }
  }

  const result = await docClient.send(new QueryCommand(queryParams));

  // Each index record carries the same SK as the conversation spine
  // (TS#<timestamp>#CONV#<convId>). Use it directly to GetItem the spine
  // rather than scanning the whole #CONV partition with a FilterExpression,
  // which fails silently when the partition exceeds DynamoDB's 1MB per-page
  // Query limit (the FilterExpression runs after the page is fetched, so the
  // target conversation can fall past the cutoff and never be seen).
  const indexItems = result.Items || [];
  const conversations = await fetchConversationsBySpineSKs(tenantId, indexItems);

  const response: { items: unknown[]; nextToken?: string } = { items: conversations };

  if (result.LastEvaluatedKey) {
    response.nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
  }

  return response;
}

/**
 * Fetch conversation spines using the SK from index records.
 *
 * Index records and spine records share the same SK format
 * (TS#<timestamp>#CONV#<convId>), so we can issue precise GetItem calls
 * instead of scanning the whole #CONV partition with a FilterExpression
 * (which fails silently past DynamoDB's 1MB per-page Query limit).
 *
 * Runs enrichWithOperatorFields and mergeEnrichment on the result so the
 * response shape matches the regular list path.
 */
async function fetchConversationsBySpineSKs(
  tenantId: string,
  indexItems: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  if (indexItems.length === 0) return [];

  const fieldsConfig = getListSurfaceFields();
  const hasOperatorFields = Object.keys(fieldsConfig).length > 0;
  const spinePK = `TENANT#${tenantId}#CONV`;

  const results = await Promise.all(
    indexItems.map(async (idx) => {
      const spineSK = idx.SK as string | undefined;
      if (!spineSK) return null;
      try {
        const result = await docClient.send(
          new GetCommand({
            TableName: TABLE_NAME,
            Key: { PK: spinePK, SK: spineSK },
          })
        );
        if (!result.Item) return null;
        const item = result.Item;
        const payload = item.payload ? JSON.parse(item.payload as string) : {};
        return {
          conversationId: item.conversationId as string,
          tenantId: item.tenantId as string,
          customerKey: payload.customerKey,
          customerPhone: payload.customerPhone ?? null,
          customerPhoneLast4: payload.customerPhoneLast4 ?? null,
          channel: payload.channel,
          sourceType: payload.sourceType ?? null,
          sourceSid: payload.sourceSid ?? null,
          callSid: payload.callSid ?? null,
          conversationSid: payload.conversationSid ?? null,
          referenceSids: payload.referenceSids ?? {},
          enrichment: payload.enrichment ?? null,
          agentId: payload.agentId,
          teamId: payload.teamId,
          queueId: payload.queueId,
          startedAt: item.startedAt,
          operatorCount: payload.operatorCount,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        };
      } catch {
        return null;
      }
    })
  );

  const conversations = results.filter(Boolean) as Array<Record<string, unknown>>;

  const operatorEnriched = hasOperatorFields && conversations.length > 0
    ? await enrichWithOperatorFields(tenantId, conversations, fieldsConfig)
    : conversations;

  return mergeEnrichment(tenantId, operatorEnriched);
}

/**
 * Fetch full conversation details for a list of conversation IDs.
 * Each conversation is queried individually (N queries, capped by page limit).
 * Results are enriched with operator fields if config is set.
 */
async function fetchConversationsByIds(
  tenantId: string,
  conversationIds: string[]
): Promise<Array<Record<string, unknown>>> {
  if (conversationIds.length === 0) return [];

  const fieldsConfig = getListSurfaceFields();
  const hasOperatorFields = Object.keys(fieldsConfig).length > 0;

  const results = await Promise.all(
    conversationIds.map(async (convId) => {
      try {
        // Note: no Limit here — DynamoDB applies Limit before FilterExpression,
        // so Limit: 1 would scan 1 item and likely miss the match.
        const result = await docClient.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'PK = :pk',
            FilterExpression: 'conversationId = :convId',
            ExpressionAttributeValues: {
              ':pk': `TENANT#${tenantId}#CONV`,
              ':convId': convId,
            },
          })
        );

        if (!result.Items || result.Items.length === 0) return null;

        const item = result.Items[0];
        const payload = item.payload ? JSON.parse(item.payload as string) : {};

        return {
          conversationId: item.conversationId as string,
          tenantId: item.tenantId as string,
          customerKey: payload.customerKey,
          customerPhone: payload.customerPhone ?? null,
          customerPhoneLast4: payload.customerPhoneLast4 ?? null,
          channel: payload.channel,
          sourceType: payload.sourceType ?? null,
          sourceSid: payload.sourceSid ?? null,
          callSid: payload.callSid ?? null,
          conversationSid: payload.conversationSid ?? null,
          referenceSids: payload.referenceSids ?? {},
          enrichment: payload.enrichment ?? null,
          agentId: payload.agentId,
          teamId: payload.teamId,
          queueId: payload.queueId,
          startedAt: item.startedAt,
          operatorCount: payload.operatorCount,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        };
      } catch {
        return null;
      }
    })
  );

  const conversations = results.filter(Boolean) as Array<Record<string, unknown>>;

  // Enrich with operator fields if configured
  const operatorEnriched = hasOperatorFields && conversations.length > 0
    ? await enrichWithOperatorFields(tenantId, conversations, fieldsConfig)
    : conversations;

  // Late-arrival enrichment merge.
  return mergeEnrichment(tenantId, operatorEnriched);
}
