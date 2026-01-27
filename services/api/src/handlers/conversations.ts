import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

interface ListConversationsParams {
  from?: string;
  to?: string;
  agentId?: string;
  queueId?: string;
  customerKey?: string;
  limit?: string;
  nextToken?: string;
}

export async function listConversations(
  tenantId: string,
  params: ListConversationsParams
): Promise<{ items: unknown[]; nextToken?: string }> {
  const { from, to, agentId, queueId, customerKey, limit = '50', nextToken } = params;
  const pageLimit = Math.min(parseInt(limit, 10) || 50, 100);

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
    const toTs = to ? formatTimestamp(new Date(to)) : '99999999999999';

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

  const items = (result.Items || []).map(item => ({
    conversationId: item.conversationId,
    tenantId: item.tenantId,
    customerKey: item.customerKey,
    channel: item.channel,
    agentId: item.agentId,
    teamId: item.teamId,
    queueId: item.queueId,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    summary: item.summary,
    operatorCount: item.operatorCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));

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

  const operators = (operatorResult.Items || []).map(item => ({
    operatorName: item.operatorName,
    schemaVersion: item.schemaVersion,
    displayFields: item.displayFields,
    enrichedPayload: item.enrichedPayload,
    enrichedAt: item.enrichedAt,
    enrichmentError: item.enrichmentError,
    receivedAt: item.receivedAt,
    s3Uri: item.s3Uri,
  }));

  return {
    conversation: {
      conversationId: conversation.conversationId,
      tenantId: conversation.tenantId,
      customerKey: conversation.customerKey,
      channel: conversation.channel,
      agentId: conversation.agentId,
      teamId: conversation.teamId,
      queueId: conversation.queueId,
      startedAt: conversation.startedAt,
      endedAt: conversation.endedAt,
      summary: conversation.summary,
      operatorCount: conversation.operatorCount,
    },
    operators,
  };
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '').split('.')[0];
}
