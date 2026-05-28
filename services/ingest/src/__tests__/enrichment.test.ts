// Mock DynamoDB before imports
const mockDocSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDocSend })) },
  PutCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}));

process.env.TABLE_NAME = 'cirl-test';
process.env.CIRL_TENANT_ID = 'inter-mvp';

import { handleEnrichment } from '../enrichment';
import type { APIGatewayProxyEvent } from 'aws-lambda';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/enrichment',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/enrichment',
    requestContext: { requestId: 'test-req', stage: 'v1' } as any,
    ...overrides,
  };
}

describe('enrichment handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CIRL_ENRICHMENT_ENABLED = 'true';
  });

  describe('feature flag', () => {
    it('returns 404 when CIRL_ENRICHMENT_ENABLED is not "true"', async () => {
      process.env.CIRL_ENRICHMENT_ENABLED = 'false';
      const result = await handleEnrichment(makeEvent({
        body: JSON.stringify({ callSid: 'CA1', fields: { x: 1 } }),
      }), 'req-1');
      expect(result.statusCode).toBe(404);
      expect(mockDocSend).not.toHaveBeenCalled();
    });

    it('returns 404 when env var is unset', async () => {
      delete process.env.CIRL_ENRICHMENT_ENABLED;
      const result = await handleEnrichment(makeEvent({
        body: JSON.stringify({ callSid: 'CA1', fields: { x: 1 } }),
      }), 'req-1');
      expect(result.statusCode).toBe(404);
    });
  });

  describe('tenant resolution', () => {
    it('uses CIRL_TENANT_ID env var by default', async () => {
      await handleEnrichment(makeEvent({
        body: JSON.stringify({ callSid: 'CA-env', fields: { x: 1 } }),
      }), 'req-1');
      const item = mockDocSend.mock.calls[0][0].input.Item;
      expect(item.PK).toBe('TENANT#inter-mvp#ENRICHMENT#CALL#CA-env');
      expect(item.tenantId).toBe('inter-mvp');
    });

    it('lets X-Tenant-Id header override the env-var tenant (for testing)', async () => {
      await handleEnrichment(makeEvent({
        headers: { 'X-Tenant-Id': 'other-tenant' },
        body: JSON.stringify({ callSid: 'CA-hdr', fields: { x: 1 } }),
      }), 'req-1');
      const item = mockDocSend.mock.calls[0][0].input.Item;
      expect(item.PK).toBe('TENANT#other-tenant#ENRICHMENT#CALL#CA-hdr');
      expect(item.tenantId).toBe('other-tenant');
    });
  });

  describe('request validation', () => {
    it('returns 400 for missing body', async () => {
      const result = await handleEnrichment(makeEvent({ body: null }), 'req-1');
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('body');
    });

    it('returns 400 for invalid JSON', async () => {
      const result = await handleEnrichment(makeEvent({ body: 'not{json' }), 'req-1');
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('JSON');
    });

    it('returns 400 when neither callSid nor conversationSid provided', async () => {
      const result = await handleEnrichment(makeEvent({
        body: JSON.stringify({ fields: { x: 1 } }),
      }), 'req-1');
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('correlation key');
    });

    it('returns 400 when fields is not an object', async () => {
      const result = await handleEnrichment(makeEvent({
        body: JSON.stringify({ callSid: 'CA1', fields: 'oops' }),
      }), 'req-1');
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('fields');
    });

    it('returns 400 when fields is an array', async () => {
      const result = await handleEnrichment(makeEvent({
        body: JSON.stringify({ callSid: 'CA1', fields: [1, 2, 3] }),
      }), 'req-1');
      expect(result.statusCode).toBe(400);
    });
  });

  describe('happy paths', () => {
    it('writes enrichment record for callSid', async () => {
      const result = await handleEnrichment(makeEvent({
        body: JSON.stringify({
          callSid: 'CA64efd5154e2de818b6edd9d5136df049',
          fields: { interaction_id: 'genesys-12345', agent_skill: 'support-l2' },
          source: 'studio',
        }),
      }), 'req-1');

      expect(result.statusCode).toBe(202);
      expect(mockDocSend).toHaveBeenCalledTimes(1);

      const item = mockDocSend.mock.calls[0][0].input.Item;
      expect(item.PK).toBe('TENANT#inter-mvp#ENRICHMENT#CALL#CA64efd5154e2de818b6edd9d5136df049');
      expect(item.SK).toBe('META');
      expect(item.entityType).toBe('ENRICHMENT');
      expect(item.correlationType).toBe('CALL');
      expect(item.correlationKey).toBe('CA64efd5154e2de818b6edd9d5136df049');
      expect(item.callSid).toBe('CA64efd5154e2de818b6edd9d5136df049');
      expect(item.conversationSid).toBeNull();
      expect(item.fields).toEqual({ interaction_id: 'genesys-12345', agent_skill: 'support-l2' });
      expect(item.source).toBe('studio');
      expect(typeof item.receivedAt).toBe('string');
      expect(typeof item.ttl).toBe('number');
    });

    it('writes enrichment record for conversationSid when callSid is absent', async () => {
      const result = await handleEnrichment(makeEvent({
        body: JSON.stringify({
          conversationSid: 'CH123abc',
          fields: { crm_ticket: 'T-9999' },
        }),
      }), 'req-1');

      expect(result.statusCode).toBe(202);
      const item = mockDocSend.mock.calls[0][0].input.Item;
      expect(item.PK).toBe('TENANT#inter-mvp#ENRICHMENT#CONV#CH123abc');
      expect(item.correlationType).toBe('CONV');
      expect(item.correlationKey).toBe('CH123abc');
      expect(item.callSid).toBeNull();
      expect(item.conversationSid).toBe('CH123abc');
    });

    it('prefers callSid when both correlation keys provided', async () => {
      await handleEnrichment(makeEvent({
        body: JSON.stringify({
          callSid: 'CA111',
          conversationSid: 'CH222',
          fields: { x: 1 },
        }),
      }), 'req-1');

      const item = mockDocSend.mock.calls[0][0].input.Item;
      expect(item.correlationType).toBe('CALL');
      expect(item.correlationKey).toBe('CA111');
      // Both still preserved as separate columns:
      expect(item.callSid).toBe('CA111');
      expect(item.conversationSid).toBe('CH222');
    });

    it('defaults source to "unknown" when omitted', async () => {
      await handleEnrichment(makeEvent({
        body: JSON.stringify({ callSid: 'CA1', fields: { x: 1 } }),
      }), 'req-1');
      const item = mockDocSend.mock.calls[0][0].input.Item;
      expect(item.source).toBe('unknown');
    });

    it('sets ttl ~90 days in the future', async () => {
      const before = Math.floor(Date.now() / 1000);
      await handleEnrichment(makeEvent({
        body: JSON.stringify({ callSid: 'CA1', fields: { x: 1 } }),
      }), 'req-1');
      const after = Math.floor(Date.now() / 1000);

      const ttl = mockDocSend.mock.calls[0][0].input.Item.ttl;
      expect(ttl).toBeGreaterThanOrEqual(before + 90 * 86400);
      expect(ttl).toBeLessThanOrEqual(after + 90 * 86400);
    });
  });
});
