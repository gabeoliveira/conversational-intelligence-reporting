// Mock dynamo incrementMetric
const mockIncrementMetric = jest.fn().mockResolvedValue(undefined);
jest.mock('../storage/dynamo', () => ({
  incrementMetric: mockIncrementMetric,
}));

// Mock @cirl/shared config loader
const mockGetOperatorConfig = jest.fn();
jest.mock('@cirl/shared', () => ({
  getOperatorConfig: mockGetOperatorConfig,
}));

import { aggregateFromConfig } from '../storage/aggregation-engine';
import type { OperatorConfig } from '@cirl/shared';

const analyticsConfig: OperatorConfig = {
  operatorName: 'TestOp',
  displayName: 'Test Operator',
  metrics: [
    {
      field: 'passed',
      type: 'boolean',
      metricPrefix: 'test_passed',
      displayName: 'Passed',
    },
    {
      field: 'score',
      type: 'integer',
      metricPrefix: 'test_score',
      displayName: 'Score',
      min: 1,
      max: 10,
      distribution: true,
    },
    {
      field: 'label',
      type: 'category',
      metricPrefix: 'test_label',
      displayName: 'Label',
    },
    {
      field: 'status',
      type: 'enum',
      metricPrefix: 'test_status',
      displayName: 'Status',
      values: ['NONE', 'ACTIVE', 'INACTIVE'],
      ignoreValues: ['NONE'],
    },
    {
      field: 'topics',
      type: 'category_array',
      metricPrefix: 'test_topic',
      displayName: 'Topic',
      categoryField: 'primary',
      subcategoryField: 'detail',
      subcategoryPrefix: 'test_subtopic',
    },
  ],
};

describe('aggregation-engine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('aggregateFromConfig', () => {
    it('returns false when no config exists for operator', async () => {
      mockGetOperatorConfig.mockReturnValue(undefined);
      const result = await aggregateFromConfig('tenant', '20260127', 'UnknownOp', {});
      expect(result).toBe(false);
      expect(mockIncrementMetric).not.toHaveBeenCalled();
    });

    it('returns true when config exists', async () => {
      mockGetOperatorConfig.mockReturnValue(analyticsConfig);
      const result = await aggregateFromConfig('tenant', '20260127', 'TestOp', { passed: true });
      expect(result).toBe(true);
    });
  });

  describe('boolean primitive', () => {
    beforeEach(() => {
      mockGetOperatorConfig.mockReturnValue(analyticsConfig);
    });

    it('increments count and total when true', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { passed: true });
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_passed_count', 1);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_passed_total', 1);
    });

    it('increments only total when false', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { passed: false });
      const countCall = mockIncrementMetric.mock.calls.find(
        (c: any[]) => c[2] === 'test_passed_count'
      );
      expect(countCall).toBeUndefined();
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_passed_total', 1);
    });

    it('skips when value is not boolean', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { passed: 'yes' });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_passed')
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe('integer primitive', () => {
    beforeEach(() => {
      mockGetOperatorConfig.mockReturnValue(analyticsConfig);
    });

    it('increments sum, count, and distribution', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { score: 7 });
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_score_sum', 7);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_score_count', 1);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_score_7', 1);
    });

    it('skips values below min', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { score: 0 });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_score')
      );
      expect(calls).toHaveLength(0);
    });

    it('skips values above max', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { score: 11 });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_score')
      );
      expect(calls).toHaveLength(0);
    });

    it('skips non-numbers', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { score: 'high' });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_score')
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe('category primitive', () => {
    beforeEach(() => {
      mockGetOperatorConfig.mockReturnValue(analyticsConfig);
    });

    it('increments normalized category count', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { label: 'Renda Fixa' });
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_label_renda_fixa', 1);
    });

    it('skips empty strings', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { label: '' });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_label')
      );
      expect(calls).toHaveLength(0);
    });

    it('skips non-strings', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { label: 42 });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_label')
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe('enum primitive', () => {
    beforeEach(() => {
      mockGetOperatorConfig.mockReturnValue(analyticsConfig);
    });

    it('increments value count and total', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { status: 'ACTIVE' });
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_status_active', 1);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_status_total', 1);
    });

    it('skips ignored values', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { status: 'NONE' });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_status')
      );
      expect(calls).toHaveLength(0);
    });

    it('skips non-strings', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { status: 123 });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_status')
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe('category_array primitive', () => {
    beforeEach(() => {
      mockGetOperatorConfig.mockReturnValue(analyticsConfig);
    });

    it('increments category and subcategory for each item', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', {
        topics: [
          { primary: 'RENDA FIXA', detail: 'RESGATE' },
          { primary: 'POUPANÇA', detail: 'RENTABILIDADE' },
        ],
      });
      // Primary topics
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_topic_renda_fixa', 1);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_topic_poupança', 1);
      // Subtopics
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_subtopic_renda_fixa_-_resgate', 1);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_subtopic_poupança_-_rentabilidade', 1);
    });

    it('skips items without category field', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', {
        topics: [{ detail: 'RESGATE' }],
      });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_topic') || c[2].startsWith('test_subtopic')
      );
      expect(calls).toHaveLength(0);
    });

    it('handles items without subcategory', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', {
        topics: [{ primary: 'RENDA FIXA' }],
      });
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_topic_renda_fixa', 1);
      // No subtopic call
      const subtopicCalls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_subtopic')
      );
      expect(subtopicCalls).toHaveLength(0);
    });

    it('skips non-arrays', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { topics: 'not an array' });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_topic')
      );
      expect(calls).toHaveLength(0);
    });

    it('handles empty array', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', { topics: [] });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_topic')
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe('multiple metrics in one call', () => {
    it('processes all metrics from config', async () => {
      mockGetOperatorConfig.mockReturnValue(analyticsConfig);
      await aggregateFromConfig('t', '20260127', 'TestOp', {
        passed: true,
        score: 8,
        label: 'Important',
        status: 'ACTIVE',
        topics: [{ primary: 'TEST', detail: 'DETAIL' }],
      });

      // Boolean
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_passed_count', 1);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_passed_total', 1);
      // Integer
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_score_sum', 8);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_score_count', 1);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_score_8', 1);
      // Category
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_label_important', 1);
      // Enum
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_status_active', 1);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_status_total', 1);
      // Category array
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_topic_test', 1);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_subtopic_test_-_detail', 1);
    });
  });
});
