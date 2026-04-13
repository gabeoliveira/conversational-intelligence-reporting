// Mock storage and enrichment modules
jest.mock('../storage/s3', () => ({
  getPayloadFromS3: jest.fn().mockResolvedValue({
    conversationId: 'C1',
    operatorName: 'test-operator',
    operatorType: 'json',
    data: {
      name: 'test-operator',
      json_results: { score: 85, category: 'billing' },
    },
  }),
}));

const mockWriteConversation = jest.fn().mockResolvedValue(undefined);
const mockWriteOperatorResult = jest.fn().mockResolvedValue(undefined);
const mockUpdateAggregates = jest.fn().mockResolvedValue(undefined);
const mockUpdateTimingAggregates = jest.fn().mockResolvedValue(undefined);

jest.mock('../storage/dynamo', () => ({
  writeConversation: mockWriteConversation,
  writeOperatorResult: mockWriteOperatorResult,
  updateAggregates: mockUpdateAggregates,
  updateTimingAggregates: mockUpdateTimingAggregates,
}));

jest.mock('../schema/validate', () => ({
  validatePayload: jest.fn().mockResolvedValue({ valid: true }),
}));

jest.mock('../enrich/enrich', () => ({
  enrich: jest.fn().mockImplementation((ctx: any) => Promise.resolve({
    enrichedPayload: ctx.rawPayload,
  })),
}));

process.env.TABLE_NAME = 'cirl-test';
process.env.RAW_BUCKET_NAME = 'cirl-raw-test';

import { handler } from '../handler';
import { validatePayload } from '../schema/validate';
import { enrich } from '../enrich/enrich';
import type { EventBridgeEvent } from 'aws-lambda';

function makeEvent(overrides: Partial<any> = {}): EventBridgeEvent<'PayloadReceived', any> {
  return {
    version: '0',
    id: 'test-id',
    source: 'cirl.ingest',
    account: '123456789',
    time: '2026-01-27T10:00:00Z',
    region: 'us-east-1',
    resources: [],
    'detail-type': 'PayloadReceived',
    detail: {
      tenantId: 'test-tenant',
      conversationId: 'C1',
      operatorName: 'test-operator',
      schemaVersion: 'v1',
      s3Uri: 's3://bucket/key.json',
      receivedAt: '2026-01-27T10:00:00Z',
      metadata: {},
      ...overrides,
    },
  };
}

describe('processor handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('processes an event end-to-end', async () => {
    await handler(makeEvent());

    expect(mockWriteConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'test-tenant',
        conversationId: 'C1',
      })
    );
    expect(mockWriteOperatorResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'test-tenant',
        conversationId: 'C1',
        operatorName: 'test-operator',
      })
    );
    expect(mockUpdateAggregates).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'test-tenant',
        conversationId: 'C1',
        operatorName: 'test-operator',
      })
    );
  });

  it('calls updateTimingAggregates when timingMetrics are in metadata', async () => {
    const timingMetrics = {
      handlingTimeSec: 60,
      avgResponseTimeSec: 3,
      avgCustomerWaitTimeSec: 2,
      sentenceCount: 10,
      agentSentenceCount: 4,
      customerSentenceCount: 6,
    };

    await handler(makeEvent({ metadata: { timingMetrics } }));

    expect(mockUpdateTimingAggregates).toHaveBeenCalledWith({
      tenantId: 'test-tenant',
      timingMetrics,
      receivedAt: '2026-01-27T10:00:00Z',
    });
  });

  it('does NOT call updateTimingAggregates when no timingMetrics', async () => {
    await handler(makeEvent({ metadata: {} }));
    expect(mockUpdateTimingAggregates).not.toHaveBeenCalled();
  });

  it('does NOT call updateTimingAggregates when metadata is undefined', async () => {
    await handler(makeEvent({ metadata: undefined }));
    expect(mockUpdateTimingAggregates).not.toHaveBeenCalled();
  });

  it('continues processing when schema validation fails', async () => {
    (validatePayload as jest.Mock).mockResolvedValueOnce({
      valid: false,
      errors: ['missing required field'],
    });

    await handler(makeEvent());

    // Should still write to DynamoDB despite validation failure
    expect(mockWriteConversation).toHaveBeenCalled();
    expect(mockWriteOperatorResult).toHaveBeenCalled();
    expect(mockUpdateAggregates).toHaveBeenCalled();
  });

  it('writes enrichmentError when enrichment fails', async () => {
    (enrich as jest.Mock).mockRejectedValueOnce(new Error('CRM lookup failed'));

    await handler(makeEvent());

    expect(mockWriteOperatorResult).toHaveBeenCalledWith(
      expect.objectContaining({
        enrichmentError: 'CRM lookup failed',
      })
    );
    // Should still complete processing
    expect(mockUpdateAggregates).toHaveBeenCalled();
  });

  it('rethrows on storage errors (for Lambda retry)', async () => {
    mockWriteConversation.mockRejectedValueOnce(new Error('DynamoDB throttle'));

    await expect(handler(makeEvent())).rejects.toThrow('DynamoDB throttle');
  });
});
