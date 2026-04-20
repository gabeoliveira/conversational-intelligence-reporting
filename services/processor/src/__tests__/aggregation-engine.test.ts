// Mock dynamo incrementMetric
const mockIncrementMetric = jest.fn().mockResolvedValue(undefined);
jest.mock('../storage/dynamo', () => ({
  incrementMetric: mockIncrementMetric,
}));

// Mock DynamoDB for index writes
const mockDocSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockDocSend })),
  },
  PutCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}));

// Mock @cirl/shared config loader
const mockGetOperatorConfig = jest.fn();
jest.mock('@cirl/shared', () => ({
  getOperatorConfig: mockGetOperatorConfig,
}));

process.env.TABLE_NAME = 'cirl-test';

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
      const result = await aggregateFromConfig('tenant', '20260127', 'UnknownOp', 'C1', {});
      expect(result).toBe(false);
      expect(mockIncrementMetric).not.toHaveBeenCalled();
    });

    it('returns true when config exists', async () => {
      mockGetOperatorConfig.mockReturnValue(analyticsConfig);
      const result = await aggregateFromConfig('tenant', '20260127', 'TestOp', 'C1', { passed: true });
      expect(result).toBe(true);
    });
  });

  describe('boolean primitive', () => {
    beforeEach(() => {
      mockGetOperatorConfig.mockReturnValue(analyticsConfig);
    });

    it('increments count and total when true', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { passed: true });
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_passed_count', 1);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_passed_total', 1);
    });

    it('increments only total when false', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { passed: false });
      const countCall = mockIncrementMetric.mock.calls.find(
        (c: any[]) => c[2] === 'test_passed_count'
      );
      expect(countCall).toBeUndefined();
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_passed_total', 1);
    });

    it('skips when value is not boolean', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { passed: 'yes' });
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
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { score: 7 });
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_score_sum', 7);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_score_count', 1);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_score_7', 1);
    });

    it('skips values below min', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { score: 0 });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_score')
      );
      expect(calls).toHaveLength(0);
    });

    it('skips values above max', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { score: 11 });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_score')
      );
      expect(calls).toHaveLength(0);
    });

    it('skips non-numbers', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { score: 'high' });
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
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { label: 'Renda Fixa' });
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_label_renda_fixa', 1);
    });

    it('skips empty strings', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { label: '' });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_label')
      );
      expect(calls).toHaveLength(0);
    });

    it('skips non-strings', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { label: 42 });
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
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { status: 'ACTIVE' });
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_status_active', 1);
      expect(mockIncrementMetric).toHaveBeenCalledWith('t', '20260127', 'test_status_total', 1);
    });

    it('skips ignored values', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { status: 'NONE' });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_status')
      );
      expect(calls).toHaveLength(0);
    });

    it('skips non-strings', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { status: 123 });
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
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', {
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
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', {
        topics: [{ detail: 'RESGATE' }],
      });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_topic') || c[2].startsWith('test_subtopic')
      );
      expect(calls).toHaveLength(0);
    });

    it('handles items without subcategory', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', {
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
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { topics: 'not an array' });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_topic')
      );
      expect(calls).toHaveLength(0);
    });

    it('handles empty array', async () => {
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', { topics: [] });
      const calls = mockIncrementMetric.mock.calls.filter(
        (c: any[]) => c[2].startsWith('test_topic')
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe('multiple metrics in one call', () => {
    it('processes all metrics from config', async () => {
      mockGetOperatorConfig.mockReturnValue(analyticsConfig);
      await aggregateFromConfig('t', '20260127', 'TestOp', 'C1', {
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

  describe('index records', () => {
    it('writes index record for surfaceInList fields', async () => {
      const configWithSurface: OperatorConfig = {
        operatorName: 'IndexedOp',
        displayName: 'Indexed',
        metrics: [
          {
            field: 'status',
            type: 'enum',
            metricPrefix: 'idx_status',
            displayName: 'Status',
            values: ['ACTIVE', 'INACTIVE'],
            surfaceInList: true,
          },
          {
            field: 'score',
            type: 'integer',
            metricPrefix: 'idx_score',
            displayName: 'Score',
            surfaceInList: true,
          },
          {
            field: 'internal',
            type: 'boolean',
            metricPrefix: 'idx_internal',
            displayName: 'Internal',
            surfaceInList: false,
          },
        ],
      };
      mockGetOperatorConfig.mockReturnValue(configWithSurface);

      await aggregateFromConfig('t', '20260127', 'IndexedOp', 'GT123', {
        status: 'ACTIVE',
        score: 8,
        internal: true,
      });

      // Index records written for surfaceInList fields
      const putCalls = mockDocSend.mock.calls.filter(
        (c: any[]) => c[0].input?.Item?.entityType === 'INDEX'
      );
      expect(putCalls).toHaveLength(2); // status + score, not internal

      // Verify PK format for status
      const statusIndex = putCalls.find(
        (c: any[]) => c[0].input.Item.fieldName === 'status'
      );
      expect(statusIndex).toBeDefined();
      expect(statusIndex![0].input.Item.PK).toBe('TENANT#t#IDX#status#active');
      expect(statusIndex![0].input.Item.SK).toBe('TS#20260127#CONV#GT123');
      expect(statusIndex![0].input.Item.conversationId).toBe('GT123');

      // Verify PK format for score
      const scoreIndex = putCalls.find(
        (c: any[]) => c[0].input.Item.fieldName === 'score'
      );
      expect(scoreIndex).toBeDefined();
      expect(scoreIndex![0].input.Item.PK).toBe('TENANT#t#IDX#score#8');
    });

    it('does not write index for fields without surfaceInList', async () => {
      const configNoSurface: OperatorConfig = {
        operatorName: 'NoIndex',
        displayName: 'No Index',
        metrics: [
          {
            field: 'passed',
            type: 'boolean',
            metricPrefix: 'ni_passed',
            displayName: 'Passed',
            // surfaceInList not set (defaults to falsy)
          },
        ],
      };
      mockGetOperatorConfig.mockReturnValue(configNoSurface);

      await aggregateFromConfig('t', '20260127', 'NoIndex', 'GT456', { passed: true });

      const putCalls = mockDocSend.mock.calls.filter(
        (c: any[]) => c[0].input?.Item?.entityType === 'INDEX'
      );
      expect(putCalls).toHaveLength(0);
    });

    it('does not write index for null/undefined values', async () => {
      const configWithSurface: OperatorConfig = {
        operatorName: 'NullOp',
        displayName: 'Null',
        metrics: [
          {
            field: 'missing_field',
            type: 'category',
            metricPrefix: 'null_test',
            displayName: 'Missing',
            surfaceInList: true,
          },
        ],
      };
      mockGetOperatorConfig.mockReturnValue(configWithSurface);

      await aggregateFromConfig('t', '20260127', 'NullOp', 'GT789', {});

      const putCalls = mockDocSend.mock.calls.filter(
        (c: any[]) => c[0].input?.Item?.entityType === 'INDEX'
      );
      expect(putCalls).toHaveLength(0);
    });
  });
});
