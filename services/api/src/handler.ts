import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { listConversations, getConversation } from './handlers/conversations';
import { getMetrics } from './handlers/metrics';
import { listSchemas, getSchema } from './handlers/schemas';
import { listViews, createView } from './handlers/views';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Tenant-Id,X-Twilio-Signature',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const { httpMethod, resource, pathParameters, queryStringParameters, body } = event;
  const requestId = event.requestContext.requestId;

  // Handle CORS preflight requests
  if (httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: '',
    };
  }

  // TODO: Add auth validation here
  // const authResult = await validateAuth(event);
  // if (!authResult.valid) return unauthorized(requestId);

  try {
    const tenantId = pathParameters?.tenantId;
    if (!tenantId) {
      return response(400, { error: 'Missing tenantId' }, requestId);
    }

    // Route to appropriate handler
    const path = resource;

    // GET /tenants/{tenantId}/conversations
    if (path === '/tenants/{tenantId}/conversations' && httpMethod === 'GET') {
      const result = await listConversations(tenantId, queryStringParameters || {});
      return response(200, result, requestId);
    }

    // GET /tenants/{tenantId}/conversations/{conversationId}
    if (path === '/tenants/{tenantId}/conversations/{conversationId}' && httpMethod === 'GET') {
      const conversationId = pathParameters?.conversationId;
      if (!conversationId) {
        return response(400, { error: 'Missing conversationId' }, requestId);
      }
      const result = await getConversation(tenantId, conversationId);
      if (!result) {
        return response(404, { error: 'Conversation not found' }, requestId);
      }
      return response(200, result, requestId);
    }

    // GET /tenants/{tenantId}/metrics
    if (path === '/tenants/{tenantId}/metrics' && httpMethod === 'GET') {
      const result = await getMetrics(tenantId, queryStringParameters || {});
      return response(200, result, requestId);
    }

    // GET /tenants/{tenantId}/schemas
    if (path === '/tenants/{tenantId}/schemas' && httpMethod === 'GET') {
      const result = await listSchemas(tenantId);
      return response(200, result, requestId);
    }

    // GET /tenants/{tenantId}/schemas/{operatorName}/versions/{version}
    if (path === '/tenants/{tenantId}/schemas/{operatorName}/versions/{version}' && httpMethod === 'GET') {
      const operatorName = pathParameters?.operatorName;
      const version = pathParameters?.version;
      if (!operatorName || !version) {
        return response(400, { error: 'Missing operatorName or version' }, requestId);
      }
      const result = await getSchema(tenantId, operatorName, version);
      if (!result) {
        return response(404, { error: 'Schema not found' }, requestId);
      }
      return response(200, result, requestId);
    }

    // GET /tenants/{tenantId}/views
    if (path === '/tenants/{tenantId}/views' && httpMethod === 'GET') {
      const result = await listViews(tenantId);
      return response(200, result, requestId);
    }

    // POST /tenants/{tenantId}/views
    if (path === '/tenants/{tenantId}/views' && httpMethod === 'POST') {
      // TODO: Check admin role
      if (!body) {
        return response(400, { error: 'Missing request body' }, requestId);
      }
      const viewConfig = JSON.parse(body);
      const result = await createView(tenantId, viewConfig);
      return response(201, result, requestId);
    }

    return response(404, { error: 'Not found' }, requestId);

  } catch (error) {
    console.error('API error:', error);
    return response(500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, requestId);
  }
}

function response(
  statusCode: number,
  body: any,
  requestId: string
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...body,
      requestId,
    }),
  };
}
