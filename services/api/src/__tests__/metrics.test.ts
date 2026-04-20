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

// Mock @cirl/shared — provide config-driven functions
jest.mock('@cirl/shared', () => ({
  ensureConfigLoaded: jest.fn().mockResolvedValue(undefined),
  buildDerivedMetricDependencies: jest.fn().mockReturnValue({
    'poc_csat_avg': ['poc_csat_sum', 'poc_csat_count'],
    'poc_ai_retained_rate_percent': ['poc_ai_retained_count', 'poc_ai_retained_total'],
  }),
  configFriendlyMetricName: jest.fn().mockImplementation((name: string) => {
    // Simulate config-driven display names for topics/CSAT
    if (name.startsWith('poc_subtopic_')) {
      const val = name.replace('poc_subtopic_', '').replace(/_/g, ' ').replace(/\s+-\s+/g, ' - ');
      return val.replace(/(^|\s)\S/g, (c: string) => c.toUpperCase()).trim();
    }
    if (name.startsWith('poc_topic_')) {
      const val = name.replace('poc_topic_', '').replace(/_/g, ' ');
      return val.replace(/(^|\s)\S/g, (c: string) => c.toUpperCase()).trim();
    }
    if (/^poc_csat_[1-5]$/.test(name)) {
      return `CSAT ${name.charAt(name.length - 1)}`;
    }
    const configNames: Record<string, string> = {
      'conversation_count': 'Conversas',
      'sentiment_avg': 'Sentimento Média',
      'poc_csat_avg': 'CSAT Média',
    };
    return configNames[name] || name;
  }),
  computeConfigDerivedMetrics: jest.fn().mockImplementation(
    (date: string, metricsMap: Map<string, number>) => {
      const derived: Array<{ date: string; metricName: string; value: number }> = [];
      // Simulate config-driven: poc_csat_avg
      const csatSum = metricsMap.get('poc_csat_sum');
      const csatCount = metricsMap.get('poc_csat_count');
      if (csatSum !== undefined && csatCount !== undefined && csatCount > 0) {
        derived.push({ date, metricName: 'poc_csat_avg', value: Math.round((csatSum / csatCount) * 100) / 100 });
      }
      return derived;
    }
  ),
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

  it('returns metrics with both metricName and displayName', async () => {
    mockSend.mockResolvedValue({
      Items: [makeMetricItem('20260127', 'conversation_count', 42)],
    });
    const result = await getMetrics('test', {});
    expect(result.metrics[0]).toEqual({
      date: '2026-01-27T00:00:00Z',
      metricName: 'conversation_count',
      displayName: 'Conversas',
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
    expect((avg as any).displayName).toBe('Sentimento Média');
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

  it('groups derived metrics by date and includes period aggregate', async () => {
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
    // 2 per-day + 1 period aggregate
    expect(avgs).toHaveLength(3);
    expect(avgs.find((m) => m.date === '2026-01-27T00:00:00Z')!.value).toBe(100);
    expect(avgs.find((m) => m.date === '2026-01-28T00:00:00Z')!.value).toBe(100);
    // Period: (200+300) / (2+3) = 100
    expect(avgs.find((m) => m.date === 'period')!.value).toBe(100);
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

  it('applies friendly displayName to topic metrics', async () => {
    mockSend.mockResolvedValue({
      Items: [makeMetricItem('20260127', 'poc_topic_atendimento', 5)],
    });
    const result = await getMetrics('test', {});
    const topic = result.metrics.find((m) => m.metricName === 'poc_topic_atendimento');
    expect(topic).toBeDefined();
    expect((topic as any).displayName).toBe('Atendimento');
  });

  it('applies friendly displayName to CSAT distribution', async () => {
    mockSend.mockResolvedValue({
      Items: [makeMetricItem('20260127', 'poc_csat_4', 10)],
    });
    const result = await getMetrics('test', {});
    const csat = result.metrics.find((m) => m.metricName === 'poc_csat_4');
    expect(csat).toBeDefined();
    expect((csat as any).displayName).toBe('CSAT 4');
  });
});
