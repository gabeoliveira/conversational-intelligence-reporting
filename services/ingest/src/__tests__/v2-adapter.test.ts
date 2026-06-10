// Mock twilio-client BEFORE importing the adapter.
const mockFetchTranscript = jest.fn();
const mockFetchOperatorResults = jest.fn();
const mockFetchSentences = jest.fn();
const mockComputeTimingMetrics = jest.fn();
jest.mock('../twilio-client', () => ({
  fetchTranscript: mockFetchTranscript,
  fetchOperatorResults: mockFetchOperatorResults,
  fetchSentences: mockFetchSentences,
  computeTimingMetrics: mockComputeTimingMetrics,
}));

import { V2Adapter, isV2TwilioCIWebhook } from '../adapters/v2-adapter';
import { AdapterServerError } from '../adapters/adapter';
import type { AdapterContext } from '../adapters/adapter';

const ctx: AdapterContext = {
  tenantId: 'inter-mvp',
  requestId: 'req-456',
  receivedAt: '2026-06-08T20:00:00.000Z',
  headers: {},
};

const v2Webhook = {
  transcript_sid: 'GTabc123',
  event_type: 'voice_intelligence_transcript_available',
  customer_key: 'CUST-1',
  service_sid: 'GAxyz',
};

const mockTranscript = {
  sid: 'GTabc123',
  channel: { type: 'voice', media_properties: { call_sid: 'CA123' } },
  dateCreated: new Date('2026-06-08T19:55:00.000Z'),
};

const mockOperatorResults = [
  {
    name: 'Analytics',
    operator_sid: 'LY1',
    operator_type: 'extract',
    extract_results: { ai_retained: true },
  },
  {
    name: 'MVP - Inter - CSAT',
    operator_sid: 'LY2',
    operator_type: 'extract',
    extract_results: { actual_csat: 'YES' },
  },
];

describe('V2Adapter', () => {
  const adapter = new V2Adapter();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = 'token_test';
    mockFetchTranscript.mockResolvedValue(mockTranscript);
    mockFetchOperatorResults.mockResolvedValue(mockOperatorResults);
    mockFetchSentences.mockResolvedValue([]);
    mockComputeTimingMetrics.mockReturnValue(null);
  });

  describe('isV2TwilioCIWebhook', () => {
    it('returns true for valid v2 notification', () => {
      expect(isV2TwilioCIWebhook(v2Webhook as any)).toBe(true);
    });

    it('returns false when event_type does not match', () => {
      expect(isV2TwilioCIWebhook({
        ...v2Webhook,
        event_type: 'something_else',
      } as any)).toBe(false);
    });

    it('returns false for v3 payload shape', () => {
      expect(isV2TwilioCIWebhook({
        conversationId: 'conv_conversation_x',
        accountId: 'ACx',
        operatorResults: [],
        intelligenceConfiguration: {},
      } as any)).toBe(false);
    });
  });

  describe('normalize', () => {
    it('emits one NormalizedResult per operator result', async () => {
      const results = await adapter.normalize(v2Webhook as any, ctx);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.operatorName)).toEqual(['Analytics', 'MVP - Inter - CSAT']);
    });

    it('uses customer_key as conversationId when provided', async () => {
      const results = await adapter.normalize(v2Webhook as any, ctx);
      expect(results[0].conversationId).toBe('CUST-1');
    });

    it('falls back to transcript_sid as conversationId when customer_key is absent', async () => {
      const results = await adapter.normalize(
        { ...v2Webhook, customer_key: undefined } as any,
        ctx
      );
      expect(results[0].conversationId).toBe('GTabc123');
    });

    it('stamps ciVersion: v2 and null trigger', async () => {
      const [result] = await adapter.normalize(v2Webhook as any, ctx);
      expect(result.ciVersion).toBe('v2');
      expect(result.trigger).toBeNull();
      expect(result.s3Payload.ciVersion).toBe('v2');
    });

    it('uses transcript dateCreated as timestamp', async () => {
      const [result] = await adapter.normalize(v2Webhook as any, ctx);
      expect(result.timestamp).toBe('2026-06-08T19:55:00.000Z');
    });

    it('preserves legacy field placement: transcriptSid/operatorSid/operatorType at top level', async () => {
      const [result] = await adapter.normalize(v2Webhook as any, ctx);
      expect(result.s3Payload.transcriptSid).toBe('GTabc123');
      expect(result.s3Payload.operatorSid).toBe('LY1');
      expect(result.s3Payload.operatorType).toBe('extract');
    });

    it('places timingMetrics at top level (not nested in metadata)', async () => {
      mockComputeTimingMetrics.mockReturnValue({
        handlingTimeSec: 100,
        avgResponseTimeSec: 1.5,
        avgCustomerWaitTimeSec: 2.0,
        sentenceCount: 20,
        agentSentenceCount: 10,
        customerSentenceCount: 10,
      });
      const [result] = await adapter.normalize(v2Webhook as any, ctx);
      expect(result.s3Payload.timingMetrics).toBeDefined();
      expect((result.s3Payload.timingMetrics as any).handlingTimeSec).toBe(100);
    });

    it('omits timingMetrics when computeTimingMetrics returns null', async () => {
      const [result] = await adapter.normalize(v2Webhook as any, ctx);
      expect(result.s3Payload.timingMetrics).toBeUndefined();
    });

    it('passes the operator result through verbatim as data', async () => {
      const [result] = await adapter.normalize(v2Webhook as any, ctx);
      expect(result.s3Payload.data).toEqual(mockOperatorResults[0]);
    });

    it('throws AdapterServerError when TWILIO_ACCOUNT_SID is missing', async () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      await expect(adapter.normalize(v2Webhook as any, ctx)).rejects.toBeInstanceOf(AdapterServerError);
    });

    it('throws AdapterServerError when TWILIO_AUTH_TOKEN is missing', async () => {
      delete process.env.TWILIO_AUTH_TOKEN;
      await expect(adapter.normalize(v2Webhook as any, ctx)).rejects.toBeInstanceOf(AdapterServerError);
    });

    it('throws a plain Error when payload does not look like a v2 webhook', async () => {
      await expect(adapter.normalize({} as any, ctx)).rejects.toThrow(/v2 Twilio CI webhook/);
    });
  });
});
