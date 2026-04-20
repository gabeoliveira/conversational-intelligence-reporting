import {
  loadOperatorMetricsConfig,
  initializeConfig,
  getOperatorConfig,
  getAllOperatorConfigs,
  getListSurfaceFields,
  resetConfigCache,
} from '../config-loader';
import type { OperatorMetricsConfig } from '../operator-config';
import * as fs from 'fs';
import * as path from 'path';

const sampleConfig: OperatorMetricsConfig = {
  version: '1.0',
  operators: [
    {
      operatorName: 'TestOperator',
      operatorSid: 'LY123',
      displayName: 'Test',
      metrics: [
        {
          field: 'score',
          type: 'integer',
          metricPrefix: 'test_score',
          displayName: 'Score',
          min: 0,
          max: 10,
          surfaceInList: true,
        },
        {
          field: 'passed',
          type: 'boolean',
          metricPrefix: 'test_passed',
          displayName: 'Passed',
          surfaceInList: false,
        },
        {
          field: 'category',
          type: 'enum',
          metricPrefix: 'test_cat',
          displayName: 'Category',
          values: ['A', 'B', 'C'],
          valueDisplayNames: { 'A': 'Alpha', 'B': 'Beta', 'C': 'Charlie' },
          ignoreValues: ['C'],
          surfaceInList: true,
        },
      ],
    },
    {
      operatorName: 'SecondOperator',
      displayName: 'Second',
      metrics: [
        {
          field: 'topic',
          type: 'category',
          metricPrefix: 'second_topic',
          displayName: 'Topic',
        },
      ],
    },
  ],
};

describe('config-loader', () => {
  beforeEach(() => {
    resetConfigCache();
    delete process.env.OPERATOR_METRICS_CONFIG;
  });

  describe('initializeConfig', () => {
    it('parses valid JSON and caches it', () => {
      const config = initializeConfig(JSON.stringify(sampleConfig));
      expect(config).not.toBeNull();
      expect(config!.version).toBe('1.0');
      // Subsequent loadOperatorMetricsConfig should return cached
      expect(loadOperatorMetricsConfig()).toBe(config);
    });

    it('returns null for invalid JSON', () => {
      expect(initializeConfig('not json{')).toBeNull();
    });

    it('returns null for config without operators array', () => {
      expect(initializeConfig(JSON.stringify({ version: '1.0' }))).toBeNull();
    });
  });

  describe('loadOperatorMetricsConfig', () => {
    it('returns null when no config initialized and no env var', () => {
      expect(loadOperatorMetricsConfig()).toBeNull();
    });

    it('parses config from env var', () => {
      process.env.OPERATOR_METRICS_CONFIG = JSON.stringify(sampleConfig);
      const config = loadOperatorMetricsConfig();
      expect(config).not.toBeNull();
      expect(config!.version).toBe('1.0');
      expect(config!.operators).toHaveLength(2);
    });

    it('returns cached config on subsequent calls', () => {
      process.env.OPERATOR_METRICS_CONFIG = JSON.stringify(sampleConfig);
      const first = loadOperatorMetricsConfig();
      const second = loadOperatorMetricsConfig();
      expect(first).toBe(second); // Same reference
    });

    it('returns null for invalid JSON', () => {
      process.env.OPERATOR_METRICS_CONFIG = 'not json{';
      expect(loadOperatorMetricsConfig()).toBeNull();
    });

    it('returns null for config without operators array', () => {
      process.env.OPERATOR_METRICS_CONFIG = JSON.stringify({ version: '1.0' });
      expect(loadOperatorMetricsConfig()).toBeNull();
    });
  });

  describe('getOperatorConfig', () => {
    beforeEach(() => {
      process.env.OPERATOR_METRICS_CONFIG = JSON.stringify(sampleConfig);
    });

    it('returns config by operator name', () => {
      const config = getOperatorConfig('TestOperator');
      expect(config).toBeDefined();
      expect(config!.displayName).toBe('Test');
      expect(config!.metrics).toHaveLength(3);
    });

    it('returns config by operator SID', () => {
      const config = getOperatorConfig('LY123');
      expect(config).toBeDefined();
      expect(config!.operatorName).toBe('TestOperator');
    });

    it('returns undefined for unknown operator', () => {
      expect(getOperatorConfig('UnknownOperator')).toBeUndefined();
    });

    it('returns undefined when no config loaded', () => {
      resetConfigCache();
      delete process.env.OPERATOR_METRICS_CONFIG;
      expect(getOperatorConfig('TestOperator')).toBeUndefined();
    });
  });

  describe('getAllOperatorConfigs', () => {
    it('returns all operators', () => {
      process.env.OPERATOR_METRICS_CONFIG = JSON.stringify(sampleConfig);
      const all = getAllOperatorConfigs();
      expect(all).toHaveLength(2);
      expect(all[0].operatorName).toBe('TestOperator');
      expect(all[1].operatorName).toBe('SecondOperator');
    });

    it('returns empty array when no config', () => {
      expect(getAllOperatorConfigs()).toEqual([]);
    });
  });

  describe('getListSurfaceFields', () => {
    it('returns fields with surfaceInList = true grouped by operator', () => {
      process.env.OPERATOR_METRICS_CONFIG = JSON.stringify(sampleConfig);
      const fields = getListSurfaceFields();
      expect(fields).toEqual({
        'TestOperator': ['score', 'category'],
      });
      // SecondOperator has no surfaceInList fields
      expect(fields['SecondOperator']).toBeUndefined();
    });

    it('returns empty object when no config', () => {
      expect(getListSurfaceFields()).toEqual({});
    });
  });

  describe('real config file', () => {
    it('validates the actual operator-metrics.json file', () => {
      const configPath = path.join(__dirname, '..', '..', '..', '..', 'config', 'operator-metrics.json');
      const configJson = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configJson) as OperatorMetricsConfig;

      expect(config.version).toBe('1.0');
      expect(config.operators.length).toBeGreaterThanOrEqual(2);

      // Analytics operator
      const analytics = config.operators.find(o => o.operatorName === 'Analytics');
      expect(analytics).toBeDefined();
      expect(analytics!.metrics.length).toBeGreaterThanOrEqual(6);

      // Check all metrics have required fields
      for (const op of config.operators) {
        for (const metric of op.metrics) {
          expect(metric.field).toBeDefined();
          expect(metric.type).toBeDefined();
          expect(metric.metricPrefix).toBeDefined();
          expect(metric.displayName).toBeDefined();
          expect(['boolean', 'integer', 'number', 'category', 'enum', 'category_array']).toContain(metric.type);
        }
      }

      // Enum metrics have values
      for (const op of config.operators) {
        for (const metric of op.metrics) {
          if (metric.type === 'enum') {
            expect((metric as any).values).toBeDefined();
            expect((metric as any).values.length).toBeGreaterThan(0);
          }
        }
      }

      // category_array has categoryField
      for (const op of config.operators) {
        for (const metric of op.metrics) {
          if (metric.type === 'category_array') {
            expect((metric as any).categoryField).toBeDefined();
          }
        }
      }
    });
  });
});
