// Mock all external dependencies before imports
jest.mock('../s3-writer', () => ({
  writeToS3: jest.fn().mockResolvedValue('s3://bucket/key.json'),
}));
jest.mock('../event-emitter', () => ({
  emitEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../validate-signature', () => ({
  validateTwilioSignature: jest.fn().mockReturnValue(true),
}));
jest.mock('../twilio-client', () => ({
  fetchTranscript: jest.fn().mockResolvedValue({
    sid: 'GT123',
    serviceSid: 'GA123',
    accountSid: 'AC123',
    channel: 'voice',
    dateCreated: new Date('2026-01-27T10:00:00Z'),
    status: 'completed',
  }),
  fetchOperatorResults: jest.fn().mockResolvedValue([
    { operator_sid: 'OP1', operator_type: 'json', name: 'test-operator', json_results: { score: 85 } },
  ]),
  fetchSentences: jest.fn().mockResolvedValue([
    { index: 0, text: 'Hello', startTime: 0, endTime: 3, mediaChannel: 0, confidence: 0.9 },
    { index: 1, text: 'Hi there', startTime: 4, endTime: 7, mediaChannel: 1, confidence: 0.95 },
  ]),
  computeTimingMetrics: jest.fn().mockReturnValue({
    handlingTimeSec: 7,
    avgResponseTimeSec: 1,
    avgCustomerWaitTimeSec: 0,
    sentenceCount: 2,
    agentSentenceCount: 1,
    customerSentenceCount: 1,
  }),
}));

process.env.TABLE_NAME = 'cirl-test';
process.env.RAW_BUCKET_NAME = 'cirl-raw-test';
process.env.EVENT_BUS_NAME = 'cirl-test';
process.env.CIRL_TENANT_ID = 'test-tenant';

import { handler } from '../handler';
import { writeToS3 } from '../s3-writer';
import { emitEvent } from '../event-emitter';
import { validateTwilioSignature } from '../validate-signature';
import { fetchOperatorResults, fetchSentences } from '../twilio-client';
import type { APIGatewayProxyEvent } from 'aws-lambda';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/webhook/ci',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '',
    requestContext: {
      requestId: 'test-request-id',
      stage: 'v1',
    } as any,
    ...overrides,
  };
}

describe('ingest handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('request validation', () => {
    it('returns 400 for missing body', async () => {
      const result = await handler(makeEvent({ body: null }));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('Missing request body');
    });

    it('returns 400 for invalid JSON', async () => {
      const result = await handler(makeEvent({ body: 'not json{' }));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('Invalid JSON');
    });
  });

  describe('signature validation', () => {
    it('returns 401 when signature validation fails', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'test-token';
      (validateTwilioSignature as jest.Mock).mockReturnValueOnce(false);

      const result = await handler(makeEvent({
        body: JSON.stringify({ conversationId: 'C1', operatorName: 'test' }),
        headers: { 'X-Twilio-Signature': 'bad-sig' },
      }));
      expect(result.statusCode).toBe(401);
    });

    it('skips validation when SKIP_SIGNATURE_VALIDATION is true', async () => {
      process.env.SKIP_SIGNATURE_VALIDATION = 'true';
      process.env.TWILIO_AUTH_TOKEN = 'test-token';

      const result = await handler(makeEvent({
        body: JSON.stringify({ conversationId: 'C1', operatorName: 'test', timestamp: 'now', data: {} }),
      }));
      expect(result.statusCode).toBe(202);
      expect(validateTwilioSignature).not.toHaveBeenCalled();

      delete process.env.SKIP_SIGNATURE_VALIDATION;
    });
  });

  describe('Twilio CI webhook', () => {
    beforeEach(() => {
      process.env.TWILIO_ACCOUNT_SID = 'AC123';
      process.env.TWILIO_AUTH_TOKEN = 'test-token';
      process.env.SKIP_SIGNATURE_VALIDATION = 'true';
    });

    afterEach(() => {
      delete process.env.SKIP_SIGNATURE_VALIDATION;
    });

    it('returns 202 and processes operator results', async () => {
      const result = await handler(makeEvent({
        body: JSON.stringify({
          account_sid: 'AC123',
          transcript_sid: 'GT123',
          event_type: 'voice_intelligence_transcript_available',
        }),
        headers: { 'X-Tenant-Id': 'test-tenant' },
      }));

      expect(result.statusCode).toBe(202);
      const body = JSON.parse(result.body);
      expect(body.transcriptSid).toBe('GT123');
      expect(body.operatorResults).toHaveLength(1);
    });

    it('fetches sentences alongside operator results', async () => {
      await handler(makeEvent({
        body: JSON.stringify({
          account_sid: 'AC123',
          transcript_sid: 'GT123',
          event_type: 'voice_intelligence_transcript_available',
        }),
      }));

      expect(fetchSentences).toHaveBeenCalledWith('GT123');
    });

    it('writes timing metrics to S3 payload', async () => {
      await handler(makeEvent({
        body: JSON.stringify({
          account_sid: 'AC123',
          transcript_sid: 'GT123',
          event_type: 'voice_intelligence_transcript_available',
        }),
      }));

      const s3Call = (writeToS3 as jest.Mock).mock.calls[0];
      const s3Payload = s3Call[1];
      expect(s3Payload.timingMetrics).toBeDefined();
      expect(s3Payload.timingMetrics.handlingTimeSec).toBe(7);
    });

    it('includes timing metrics in EventBridge event metadata', async () => {
      await handler(makeEvent({
        body: JSON.stringify({
          account_sid: 'AC123',
          transcript_sid: 'GT123',
          event_type: 'voice_intelligence_transcript_available',
        }),
      }));

      const eventCall = (emitEvent as jest.Mock).mock.calls[0][0];
      expect(eventCall.metadata.timingMetrics).toBeDefined();
      expect(eventCall.metadata.timingMetrics.avgResponseTimeSec).toBe(1);
    });

    it('returns 500 when Twilio creds are missing', async () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;

      const result = await handler(makeEvent({
        body: JSON.stringify({
          account_sid: 'AC123',
          transcript_sid: 'GT123',
          event_type: 'voice_intelligence_transcript_available',
        }),
      }));

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toContain('Twilio credentials');
    });
  });

  describe('legacy webhook', () => {
    beforeEach(() => {
      process.env.SKIP_SIGNATURE_VALIDATION = 'true';
    });

    afterEach(() => {
      delete process.env.SKIP_SIGNATURE_VALIDATION;
    });

    it('returns 202 for valid payload', async () => {
      const result = await handler(makeEvent({
        body: JSON.stringify({
          conversationId: 'C1',
          operatorName: 'test-op',
          timestamp: '2026-01-27T10:00:00Z',
          data: { score: 42 },
        }),
      }));

      expect(result.statusCode).toBe(202);
      expect(writeToS3).toHaveBeenCalled();
      expect(emitEvent).toHaveBeenCalled();
    });

    it('returns 400 for missing conversationId', async () => {
      const result = await handler(makeEvent({
        body: JSON.stringify({
          operatorName: 'test-op',
          timestamp: 'now',
          data: {},
        }),
      }));
      expect(result.statusCode).toBe(400);
    });

    it('returns 400 for missing operatorName', async () => {
      const result = await handler(makeEvent({
        body: JSON.stringify({
          conversationId: 'C1',
          timestamp: 'now',
          data: {},
        }),
      }));
      expect(result.statusCode).toBe(400);
    });

    it('uses X-Tenant-Id header for tenant', async () => {
      await handler(makeEvent({
        body: JSON.stringify({
          conversationId: 'C1',
          operatorName: 'test-op',
          timestamp: 'now',
          data: {},
        }),
        headers: { 'X-Tenant-Id': 'custom-tenant' },
      }));

      const eventCall = (emitEvent as jest.Mock).mock.calls[0][0];
      expect(eventCall.tenantId).toBe('custom-tenant');
    });
  });
});
