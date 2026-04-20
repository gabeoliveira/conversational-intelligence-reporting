# Indexed Conversations — Implementation Plan

## Overview

CIRL currently supports listing conversations with basic filters (date, agent, queue, customer) via DynamoDB GSIs, and enriching the list with operator result fields via `surfaceInList`. However, there's no way to query "all conversations where operator field X = Y" without scanning all conversations and filtering client-side.

This plan adds **denormalized index records** written at ingestion time, enabling O(1) lookups by any `surfaceInList` field — for example, "show me all conversations where handoff_reason = LACK_OF_KNOWLEDGE."

## The Problem

Current drill-down flow:
1. Grafana fetches all conversations (`limit=500`)
2. Conversations are enriched with operator fields (`surfaceInList`)
3. Grafana filters client-side using transformations

This breaks at scale:
- 500 limit means you miss conversations beyond the first page
- Enrichment makes one DynamoDB query per conversation (500 queries per request)
- Client-side filtering is slow and can't paginate

## The Solution

Write index records at ingestion time for every `surfaceInList` field. The API queries these records directly when a filter is provided.

### Index Record Structure

```
PK: TENANT#{tenantId}#IDX#{fieldName}#{fieldValue}
SK: TS#{timestamp}#CONV#{conversationId}
```

Example: a conversation with `handoff_reason = LACK_OF_KNOWLEDGE`:

```
PK: TENANT#poc-inter#IDX#handoff_reason#LACK_OF_KNOWLEDGE
SK: TS#20260416143000#CONV#GT438b8b2d5780a463e0272e131449e3b0
```

### Query Flow

```
GET /tenants/{id}/conversations?handoff_reason=LACK_OF_KNOWLEDGE
```

1. API detects `handoff_reason` is a `surfaceInList` field
2. Queries DynamoDB with PK = `TENANT#poc-inter#IDX#handoff_reason#LACK_OF_KNOWLEDGE`
3. Returns matching conversations sorted by time, paginated
4. Each index record points to the conversation — fetch full details if needed

## Implementation Pieces

| # | Piece | What it does | Depends on | Effort |
|---|---|---|---|---|
| 1 | **Index writer** | Writes index records in the aggregation engine for `surfaceInList` fields | Config system | Medium |
| 2 | **API query path** | Detects operator field filters, queries index PK instead of main table | #1 | Medium |
| 3 | **Conversation resolver** | Fetches full conversation details from index results | #2 | Small |
| 4 | **Tests** | Index writer + API query path + end-to-end | #1, #2, #3 | Medium |

## Detailed Design

### 1. Index Writer

Lives in the aggregation engine (`aggregation-engine.ts`). After processing metrics for a `surfaceInList` field, also writes an index record.

```typescript
// In aggregateByType, after processing the metric:
if (metric.surfaceInList && value !== undefined && value !== null) {
  const normalizedValue = String(value).toLowerCase().replace(/\s+/g, '_');
  await writeIndexRecord(tenantId, metric.field, normalizedValue, conversationId, date);
}
```

Index record structure:

```typescript
async function writeIndexRecord(
  tenantId: string,
  fieldName: string,
  fieldValue: string,
  conversationId: string,
  timestamp: string
): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${tenantId}#IDX#${fieldName}#${fieldValue}`,
      SK: `TS#${timestamp}#CONV#${conversationId}`,
      tenantId,
      conversationId,
      fieldName,
      fieldValue,
      entityType: 'INDEX',
      // TTL optional — index records can be permanent or expire after N days
    },
  }));
}
```

**Write volume**: One PutCommand per `surfaceInList` field per operator result. With 2 surfaced fields (handoff_reason, inferred_csat) and ~20 operators per conversation, that's 2 extra writes per conversation (only the Analytics operator has surfaceInList fields). At 20K calls/month = 40K extra writes = ~$0.05/month.

### 2. API Query Path

In `conversations.ts`, detect when a query parameter matches a `surfaceInList` field name.

```typescript
export async function listConversations(tenantId, params) {
  await ensureConfigLoaded();
  const surfaceFields = getListSurfaceFields();
  const allSurfaceFieldNames = Object.values(surfaceFields).flat();

  // Check if any query param is a surfaceInList field
  const indexFilter = findIndexFilter(params, allSurfaceFieldNames);

  if (indexFilter) {
    // Query the index instead of the main table
    return queryByIndex(tenantId, indexFilter, params);
  }

  // ... existing list logic
}
```

```typescript
function findIndexFilter(
  params: Record<string, string | undefined>,
  surfaceFieldNames: string[]
): { fieldName: string; fieldValue: string } | null {
  for (const field of surfaceFieldNames) {
    if (params[field]) {
      return { fieldName: field, fieldValue: params[field]! };
    }
  }
  return null;
}
```

```typescript
async function queryByIndex(
  tenantId: string,
  filter: { fieldName: string; fieldValue: string },
  params: ListConversationsParams
): Promise<{ items: unknown[]; nextToken?: string }> {
  const normalizedValue = filter.fieldValue.toLowerCase().replace(/\s+/g, '_');
  const pk = `TENANT#${tenantId}#IDX#${filter.fieldName}#${normalizedValue}`;

  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': pk },
    ScanIndexForward: false, // Most recent first
    Limit: parseInt(params.limit || '50', 10),
    // Pagination via nextToken
  }));

  // Each index record has conversationId — fetch full conversation details
  const conversationIds = (result.Items || []).map(item => item.conversationId as string);
  const conversations = await fetchConversationDetails(tenantId, conversationIds);

  return { items: conversations, nextToken: /* from LastEvaluatedKey */ };
}
```

### 3. Conversation Resolver

Fetches full conversation details for a list of conversation IDs. Uses BatchGetItem for efficiency.

```typescript
async function fetchConversationDetails(
  tenantId: string,
  conversationIds: string[]
): Promise<Array<Record<string, unknown>>> {
  // For each conversationId, we need to find its full record
  // The conversation PK is TENANT#{tenantId}#CONV, SK is TS#...#CONV#{id}
  // We don't have the timestamp, so we query by conversationId attribute

  const results = await Promise.all(
    conversationIds.map(async (convId) => {
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk',
        FilterExpression: 'conversationId = :convId',
        ExpressionAttributeValues: {
          ':pk': `TENANT#${tenantId}#CONV`,
          ':convId': convId,
        },
        Limit: 1,
      }));
      return result.Items?.[0] || null;
    })
  );

  return results.filter(Boolean).map(item => {
    const payload = item!.payload ? JSON.parse(item!.payload as string) : {};
    return {
      conversationId: item!.conversationId,
      tenantId: item!.tenantId,
      customerKey: payload.customerKey,
      channel: payload.channel,
      agentId: payload.agentId,
      startedAt: item!.startedAt,
      operatorCount: payload.operatorCount,
    };
  });
}
```

**Performance note**: The conversation resolver does one query per conversation ID. For 50 results, that's 50 queries. This is acceptable for drill-down (user is looking at specific conversations), but not for bulk listing. The `limit` parameter caps this naturally.

**Optimization for later**: Store conversation summary data directly on the index record to avoid the resolver step entirely. This denormalizes more but eliminates the N+1 query pattern.

## What Changes

| Component | Change | Impact |
|---|---|---|
| `aggregation-engine.ts` | Writes index records for `surfaceInList` fields | +1 DynamoDB write per surfaced field per conversation |
| `conversations.ts` | Detects index filters, queries index PK, resolves conversations | New query path, existing path unchanged |
| `operator-config.ts` | No changes — `surfaceInList` already exists | None |
| DynamoDB table | New PK pattern `TENANT#...#IDX#...` | No schema changes (single-table design) |
| API contract | New query parameters on `/conversations` | Backward compatible — new params, existing ones unchanged |

## What This Does NOT Change

- Metrics aggregation — unchanged
- Derived metrics — unchanged
- Display names — unchanged
- Grafana dashboard — enhanced (can filter conversations table by operator fields)
- Existing conversation list queries (by date, agent, queue, customer) — unchanged
- Analytics modes (none/simple/lakehouse) — unchanged

## API Usage

```bash
# All conversations with handoff due to lack of knowledge
GET /tenants/{id}/conversations?handoff_reason=LACK_OF_KNOWLEDGE

# All conversations with CSAT score of 1
GET /tenants/{id}/conversations?inferred_csat=1

# Combined with existing filters
GET /tenants/{id}/conversations?handoff_reason=LACK_OF_KNOWLEDGE&from=2026-04-16&to=2026-04-17

# Paginated
GET /tenants/{id}/conversations?handoff_reason=LACK_OF_KNOWLEDGE&limit=50&nextToken=...
```

## Retroactive Data

Index records are written at ingestion time. Existing conversations will not have index records.

Options:
1. **Accept it** — filtering only works for new conversations. Old conversations appear in the unfiltered list as before.
2. **Backfill script** — read existing operator results from DynamoDB, write index records retroactively. Similar to `backfill-aggregates.ts`.

**Recommendation for MVP**: Accept it. The value of indexed drill-down is for ongoing monitoring, not historical analysis. If a customer needs historical drill-down, add a backfill script later.

## Cost Impact

| Scale | Extra writes/month | Extra cost/month | DynamoDB storage |
|---|---|---|---|
| 20K conversations, 2 surfaced fields | 40K | ~$0.05 | ~20MB |
| 200K conversations, 2 surfaced fields | 400K | ~$0.50 | ~200MB |
| 800K conversations, 5 surfaced fields | 4M | ~$5.00 | ~2GB |

Negligible at all scales.

## Testing Plan

### Unit Tests
- Index writer: writes correct PK/SK, normalizes values, handles missing/null values
- API query path: detects surfaceInList params, queries correct PK, paginates
- Conversation resolver: fetches details, handles missing conversations
- Integration with config: only indexes fields marked `surfaceInList`

### Integration Tests (deployed environment)
1. Deploy to dev
2. Trigger a call with known operator results
3. Verify index records in DynamoDB: `aws dynamodb query --key-condition-expression "PK = :pk" --expression-attribute-values '{":pk":{"S":"TENANT#dev#IDX#handoff_reason#lack_of_knowledge"}}'`
4. Query the API: `curl /tenants/dev/conversations?handoff_reason=LACK_OF_KNOWLEDGE`
5. Verify matching conversations returned

## Migration Path

1. ~~Add index writer to aggregation engine~~ — **Done**
2. ~~Add API query path with conversation resolver~~ — **Done**
3. ~~Write tests~~ — **Done** (3 new tests for index writes)
4. ~~Deploy to dev, verify with real calls~~ — **Done**
5. Deploy to POC, verify with customer data (new conversations only)
6. (Optional) Backfill script for historical data
