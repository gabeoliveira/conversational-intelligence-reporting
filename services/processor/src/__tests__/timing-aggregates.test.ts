// Must define mock before jest.mock factory runs
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockSend })),
  },
  PutCommand: jest.fn().mockImplementation((input: any) => ({ constructor: { name: 'PutCommand' }, input })),
  UpdateCommand: jest.fn().mockImplementation((input: any) => ({ constructor: { name: 'UpdateCommand' }, input })),
  GetCommand: jest.fn().mockImplementation((input: any) => ({ constructor: { name: 'GetCommand' }, input })),
}));

process.env.TABLE_NAME = 'cirl-test';

import { updateTimingAggregates } from '../storage/dynamo';

describe('updateTimingAggregates', () => {
  beforeEach(() => {
    mockSend.mockReset();
    // Default: Get returns no existing item, Update succeeds
    mockSend.mockImplementation((cmd: any) => {
      if (cmd.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });
  });

  it('increments handling time sum and count', async () => {
    await updateTimingAggregates({
      tenantId: 'test-tenant',
      timingMetrics: {
        handlingTimeSec: 120.5,
        avgResponseTimeSec: 3.2,
        avgCustomerWaitTimeSec: 1.5,
        sentenceCount: 20,
        agentSentenceCount: 8,
        customerSentenceCount: 12,
      },
      receivedAt: '2026-01-27T10:00:00Z',
    });

    const updateCalls = mockSend.mock.calls.filter(
      (call: any[]) => call[0].constructor.name === 'UpdateCommand'
    );

    const metricNames = updateCalls.map(
      (call: any[]) => call[0].input.ExpressionAttributeValues[':metricName']
    );
    expect(metricNames).toContain('handling_time_sum');
    expect(metricNames).toContain('handling_time_count');
    expect(metricNames).toContain('response_time_sum');
    expect(metricNames).toContain('response_time_count');
    expect(metricNames).toContain('sentence_count_total');

    // Check handling_time_sum value
    const sumCall = updateCalls.find(
      (call: any[]) => call[0].input.ExpressionAttributeValues[':metricName'] === 'handling_time_sum'
    );
    const payload = JSON.parse(sumCall![0].input.ExpressionAttributeValues[':payload']);
    expect(payload.value).toBe(120.5);
  });

  it('skips metrics with zero values', async () => {
    await updateTimingAggregates({
      tenantId: 'test-tenant',
      timingMetrics: {
        handlingTimeSec: 60,
        avgResponseTimeSec: 0,
        avgCustomerWaitTimeSec: 0,
        sentenceCount: 5,
        agentSentenceCount: 2,
        customerSentenceCount: 3,
      },
      receivedAt: '2026-01-27T10:00:00Z',
    });

    const updateCalls = mockSend.mock.calls.filter(
      (call: any[]) => call[0].constructor.name === 'UpdateCommand'
    );
    const metricNames = updateCalls.map(
      (call: any[]) => call[0].input.ExpressionAttributeValues[':metricName']
    );

    expect(metricNames).toContain('handling_time_sum');
    expect(metricNames).not.toContain('response_time_sum');
    expect(metricNames).not.toContain('customer_wait_time_sum');
    expect(metricNames).toContain('sentence_count_total');
  });

  it('adds to existing metric values', async () => {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd.constructor.name === 'GetCommand' &&
          cmd.input.Key.SK.includes('handling_time_sum')) {
        return Promise.resolve({
          Item: { payload: JSON.stringify({ value: 100 }) },
        });
      }
      return Promise.resolve({ Item: undefined });
    });

    await updateTimingAggregates({
      tenantId: 'test-tenant',
      timingMetrics: {
        handlingTimeSec: 50,
        avgResponseTimeSec: 0,
        avgCustomerWaitTimeSec: 0,
        sentenceCount: 0,
        agentSentenceCount: 0,
        customerSentenceCount: 0,
      },
      receivedAt: '2026-01-27T10:00:00Z',
    });

    const updateCalls = mockSend.mock.calls.filter(
      (call: any[]) => call[0].constructor.name === 'UpdateCommand'
    );
    const sumCall = updateCalls.find(
      (call: any[]) => call[0].input.ExpressionAttributeValues[':metricName'] === 'handling_time_sum'
    );
    const payload = JSON.parse(sumCall![0].input.ExpressionAttributeValues[':payload']);
    expect(payload.value).toBe(150); // 100 + 50
  });

  it('uses correct date format', async () => {
    await updateTimingAggregates({
      tenantId: 'test-tenant',
      timingMetrics: { handlingTimeSec: 10, avgResponseTimeSec: 0, avgCustomerWaitTimeSec: 0, sentenceCount: 0, agentSentenceCount: 0, customerSentenceCount: 0 },
      receivedAt: '2026-03-15T14:30:00Z',
    });

    const updateCalls = mockSend.mock.calls.filter(
      (call: any[]) => call[0].constructor.name === 'UpdateCommand'
    );
    expect(updateCalls[0][0].input.ExpressionAttributeValues[':date']).toBe('20260315');
  });
});
