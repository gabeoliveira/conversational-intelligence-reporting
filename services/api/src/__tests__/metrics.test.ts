const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockSend })),
  },
  QueryCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}));

process.env.TABLE_NAME = 'cirl-test';

import { getMetrics } from '../handlers/metrics';

function makeMetricItem(date: string, metricName: string, value: number) {
  return {
    date,
    metricName,
    entityType: 'AGGREGATE',
    tenantId: 'test',
    payload: JSON.stringify({ value }),
  };
}

describe('getMetrics', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('returns empty metrics when no data exists', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    const result = await getMetrics('test', {});
    expect(result.metrics).toEqual([]);
  });

  it('returns raw metrics from DynamoDB', async () => {
    mockSend.mockResolvedValue({
      Items: [makeMetricItem('20260127', 'conversation_count', 42)],
    });
    const result = await getMetrics('test', {});
    expect(result.metrics).toContainEqual({
      date: '2026-01-27T00:00:00Z',
      metricName: 'conversation_count',
      value: 42,
    });
  });

  it('computes sentiment_avg from sum/count', async () => {
    mockSend.mockResolvedValue({
      Items: [
        makeMetricItem('20260127', 'sentiment_score_sum', 750),
        makeMetricItem('20260127', 'sentiment_score_count', 10),
      ],
    });
    const result = await getMetrics('test', {});
    const avg = result.metrics.find((m) => m.metricName === 'sentiment_avg');
    expect(avg).toBeDefined();
    expect(avg!.value).toBe(75);
  });

  it('computes avg_handling_time_sec from sum/count', async () => {
    mockSend.mockResolvedValue({
      Items: [
        makeMetricItem('20260127', 'handling_time_sum', 600),
        makeMetricItem('20260127', 'handling_time_count', 5),
      ],
    });
    const result = await getMetrics('test', {});
    const avg = result.metrics.find((m) => m.metricName === 'avg_handling_time_sec');
    expect(avg).toBeDefined();
    expect(avg!.value).toBe(120);
  });

  it('computes avg_response_time_sec from sum/count', async () => {
    mockSend.mockResolvedValue({
      Items: [
        makeMetricItem('20260127', 'response_time_sum', 30),
        makeMetricItem('20260127', 'response_time_count', 10),
      ],
    });
    const result = await getMetrics('test', {});
    const avg = result.metrics.find((m) => m.metricName === 'avg_response_time_sec');
    expect(avg).toBeDefined();
    expect(avg!.value).toBe(3);
  });

  it('computes avg_customer_wait_time_sec from sum/count', async () => {
    mockSend.mockResolvedValue({
      Items: [
        makeMetricItem('20260127', 'customer_wait_time_sum', 20),
        makeMetricItem('20260127', 'customer_wait_time_count', 8),
      ],
    });
    const result = await getMetrics('test', {});
    const avg = result.metrics.find((m) => m.metricName === 'avg_customer_wait_time_sec');
    expect(avg).toBeDefined();
    expect(avg!.value).toBe(2.5);
  });

  it('computes transfer_rate_percent', async () => {
    mockSend.mockResolvedValue({
      Items: [
        makeMetricItem('20260127', 'human_agent_transfers', 3),
        makeMetricItem('20260127', 'conversation_count', 10),
      ],
    });
    const result = await getMetrics('test', {});
    const rate = result.metrics.find((m) => m.metricName === 'transfer_rate_percent');
    expect(rate).toBeDefined();
    expect(rate!.value).toBe(30);
  });

  it('does not compute derived metrics when count is zero', async () => {
    mockSend.mockResolvedValue({
      Items: [
        makeMetricItem('20260127', 'handling_time_sum', 600),
        makeMetricItem('20260127', 'handling_time_count', 0),
      ],
    });
    const result = await getMetrics('test', {});
    const avg = result.metrics.find((m) => m.metricName === 'avg_handling_time_sec');
    expect(avg).toBeUndefined();
  });

  it('groups derived metrics by date', async () => {
    mockSend.mockResolvedValue({
      Items: [
        makeMetricItem('20260127', 'handling_time_sum', 200),
        makeMetricItem('20260127', 'handling_time_count', 2),
        makeMetricItem('20260128', 'handling_time_sum', 300),
        makeMetricItem('20260128', 'handling_time_count', 3),
      ],
    });
    const result = await getMetrics('test', {});
    const avgs = result.metrics.filter((m) => m.metricName === 'avg_handling_time_sec');
    expect(avgs).toHaveLength(2);
    expect(avgs.find((m) => m.date === '2026-01-27T00:00:00Z')!.value).toBe(100);
    expect(avgs.find((m) => m.date === '2026-01-28T00:00:00Z')!.value).toBe(100);
  });

  it('returns correct period with default dates', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    const result = await getMetrics('test', {});
    const from = new Date(result.period.from);
    const to = new Date(result.period.to);
    const diffDays = Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(30);
  });

  it('returns correct period with custom dates', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    const result = await getMetrics('test', { from: '2026-01-01', to: '2026-01-31' });
    expect(result.period.from).toBe('2026-01-01');
    expect(result.period.to).toBe('2026-01-31');
  });
});
