const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockSend })),
  },
  QueryCommand: jest.fn().mockImplementation((input: any) => ({ input })),
  PutCommand: jest.fn().mockImplementation((input: any) => ({ input })),
  GetCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}));

jest.mock('@cirl/shared', () => ({
  ensureConfigLoaded: jest.fn().mockResolvedValue(undefined),
  buildDerivedMetricDependencies: jest.fn().mockReturnValue({}),
  configFriendlyMetricName: jest.fn().mockImplementation((name: string) => name),
  computeConfigDerivedMetrics: jest.fn().mockReturnValue([]),
  getListSurfaceFields: jest.fn().mockReturnValue({}),
}));

process.env.TABLE_NAME = 'cirl-test';
process.env.RAW_BUCKET_NAME = 'cirl-raw-test';

import { handler } from '../handler';
import type { APIGatewayProxyEvent } from 'aws-lambda';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/tenants/test-tenant/conversations',
    pathParameters: { tenantId: 'test-tenant' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/tenants/{tenantId}/conversations',
    requestContext: {
      requestId: 'test-request-id',
      stage: 'v1',
    } as any,
    ...overrides,
  };
}

describe('API handler routing', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ Items: [] });
  });

  it('routes GET /tenants/{id}/conversations', async () => {
    const result = await handler(makeEvent({
      path: '/tenants/test-tenant/conversations',
      resource: '/tenants/{tenantId}/conversations',
      pathParameters: { tenantId: 'test-tenant' },
    }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body).toHaveProperty('items');
  });

  it('routes GET /tenants/{id}/conversations/{convId}', async () => {
    // First query: find conversation
    mockSend.mockResolvedValueOnce({
      Items: [{
        PK: 'TENANT#test-tenant#CONV',
        SK: 'TS#20260127100000#CONV#C1',
        conversationId: 'C1',
        tenantId: 'test-tenant',
        entityType: 'CONVERSATION',
        payload: JSON.stringify({ customerKey: 'cust1' }),
      }],
    });
    // Second query: operator results
    mockSend.mockResolvedValueOnce({ Items: [] });

    const result = await handler(makeEvent({
      path: '/tenants/test-tenant/conversations/C1',
      resource: '/tenants/{tenantId}/conversations/{conversationId}',
      pathParameters: { tenantId: 'test-tenant', conversationId: 'C1' },
    }));
    expect(result.statusCode).toBe(200);
  });

  it('routes GET /tenants/{id}/metrics', async () => {
    const result = await handler(makeEvent({
      path: '/tenants/test-tenant/metrics',
      resource: '/tenants/{tenantId}/metrics',
      pathParameters: { tenantId: 'test-tenant' },
    }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body).toHaveProperty('metrics');
    expect(body).toHaveProperty('period');
  });

  it('returns 400 when tenantId is missing', async () => {
    const result = await handler(makeEvent({
      pathParameters: null,
    }));
    expect(result.statusCode).toBe(400);
  });

  it('returns CORS headers', async () => {
    const result = await handler(makeEvent());
    expect(result.headers).toHaveProperty('Access-Control-Allow-Origin');
  });

  it('handles OPTIONS preflight', async () => {
    const result = await handler(makeEvent({
      httpMethod: 'OPTIONS',
      path: '/tenants/test-tenant/conversations',
    }));
    expect(result.statusCode).toBe(200);
    expect(result.headers).toHaveProperty('Access-Control-Allow-Methods');
  });
});
