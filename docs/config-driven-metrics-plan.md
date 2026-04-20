# Config-Driven Operator Metrics — Implementation Plan

## Overview

CIRL currently requires custom TypeScript code for every new operator's metrics. This plan replaces all hardcoded aggregation, derived metrics, display names, and conversation enrichment with a single config-driven system.

## What We're Replacing

| Current (hardcoded) | Location | Problem |
|---|---|---|
| `if (operatorName === 'Analytics') { ... }` blocks | `processor/dynamo.ts` | New operator = new code |
| `derivedMetricDependencies` map | `api/metrics.ts` | Every derived metric manually mapped |
| `friendlyMetricName` display names | `api/metrics.ts` | Hardcoded Portuguese strings |
| `operator-fields.json` | `config/` | Separate config for conversation enrichment |

## What We're Building

### 1. Config Schema

Defines what a metric configuration looks like. One config per operator.

```json
{
  "operatorName": "Analytics",
  "operatorSid": "LY32ba2958162b4e1ea33b59ea433fdf8f",
  "displayName": "Analise da IA",
  "metrics": [
    {
      "field": "ai_retained",
      "type": "boolean",
      "metricPrefix": "poc_ai_retained",
      "displayName": "Retencao da IA",
      "surfaceInList": false
    },
    {
      "field": "handoff_reason",
      "type": "enum",
      "metricPrefix": "poc_handoff",
      "displayName": "Transbordo",
      "values": ["NONE", "CUSTOMER_REQUEST", "LACK_OF_COMPREHENSION", "LACK_OF_KNOWLEDGE"],
      "valueDisplayNames": {
        "CUSTOMER_REQUEST": "Solicitacao do Cliente",
        "LACK_OF_COMPREHENSION": "Falta de Compreensao",
        "LACK_OF_KNOWLEDGE": "Falta de Conhecimento"
      },
      "ignoreValues": ["NONE"],
      "surfaceInList": true
    },
    {
      "field": "inferred_csat",
      "type": "integer",
      "metricPrefix": "poc_csat",
      "displayName": "CSAT",
      "min": 1,
      "max": 5,
      "distribution": true,
      "surfaceInList": true
    },
    {
      "field": "topics",
      "type": "category_array",
      "metricPrefix": "poc_topic",
      "displayName": "Topico",
      "categoryField": "primary_topic",
      "subcategoryField": "subtopic",
      "subcategoryPrefix": "poc_subtopic",
      "surfaceInList": false
    },
    {
      "field": "errors",
      "type": "boolean",
      "metricPrefix": "poc_errors",
      "displayName": "Erros da IA",
      "surfaceInList": false
    },
    {
      "field": "back_to_ivr",
      "type": "boolean",
      "metricPrefix": "poc_back_to_ivr",
      "displayName": "Retorno a URA",
      "surfaceInList": false
    }
  ]
}
```

### 2. Primitive Types

Four primitives cover all current and foreseeable use cases:

| Type | What it stores | Derived metric | Display pattern |
|---|---|---|---|
| **boolean** | `{prefix}_count` (when true), `{prefix}_total` (always) | `{prefix}_rate_percent` = count / total x 100 | "{displayName} (%)" |
| **integer/number** | `{prefix}_sum`, `{prefix}_count` | `{prefix}_avg` = sum / count | "{displayName} Medio" |
| **category** | `{prefix}_{value}` per distinct value | None (raw counts) | Title-cased value |
| **enum** | `{prefix}_{value}` per value, `{prefix}_total` | `{prefix}_{value}_rate_percent` = count / denominator x 100 | From `valueDisplayNames` map |

Plus a composite for multi-topic scenarios:

| Type | What it stores | Notes |
|---|---|---|
| **category_array** | `{prefix}_{category}` + `{subcategoryPrefix}_{category_-_subcategory}` per item | Loops over array, counts each item independently |

Optional modifiers:

- `distribution: true` (for integers) — also stores `{prefix}_{value}` per bucket (e.g., CSAT 1 through 5)
- `ignoreValues: ["NONE"]` (for enums) — doesn't count specified values
- `min` / `max` (for integers) — sanity check, discards out-of-range values
- `surfaceInList: true` — includes this field in conversations list enrichment

### 3. Implementation Pieces

| # | Piece | What it does | Depends on | Status |
|---|---|---|---|---|
| 1 | **Config schema** | TypeScript interfaces for the config shape | Nothing | **Done** |
| 2 | **Config storage** | S3-based loading with in-memory cache | #1 | **Done** |
| 3 | **Aggregation engine** | Generic processor that reads config and writes metrics by primitive type | #1, #2 | **Done** |
| 4 | **API derived metrics** | Auto-generates dependency map + computes derived values from config | #1, #2 | Pending |
| 5 | **API display names** | Returns `displayName` from config instead of hardcoded map | #1, #2 | Pending |
| 6 | **Conversation enrichment** | Reads `surfaceInList` from config for list view fields | #1, #2 | Pending |
| 7 | **Config management API** | CRUD endpoints for managing configs (optional for MVP) | #1, #2 | Deferred |

Items 1-3 are complete. Items 4-6 are next (Phase 3). Item 7 is deferred — configs are managed via file + redeploy.

### 4. Storage Decision

**Decided: S3.**

Config files (`config/operator-metrics.json`, `config/operator-fields.json`) are deployed to S3 (`s3://{raw-bucket}/config/`) at deploy time via CDK `BucketDeployment`. Lambdas read them on cold start and cache in memory.

| Option | Pros | Cons | Status |
|---|---|---|---|
| **S3** | No size limits. Already deployed (raw bucket). Runtime updates via `aws s3 cp`. Config-as-code in repo. | One S3 read per cold start (~100ms, cached). | **Implemented** |
| **DynamoDB** | Per-tenant configs. Transactional updates. | Extra infrastructure. Overkill for a config file. | Not needed |
| **Environment variable** | Simple. | 4KB limit — exceeded with 2 operators. | **Rejected** |

**How it works:**
1. CDK deploys `config/` directory to `s3://{raw-bucket}/config/` (excludes schemas and demo-data)
2. Lambdas receive `CONFIG_BUCKET` and `CONFIG_PREFIX` env vars
3. On cold start, `ensureConfigLoaded()` reads `operator-metrics.json` from S3
4. Config is cached in Lambda memory — no S3 reads on warm invocations
5. To update at runtime without redeploy: `aws s3 cp config/operator-metrics.json s3://{bucket}/config/`

**The loader is storage-agnostic:** `initializeConfig(jsonString)` accepts JSON from any source. The S3 fetcher is a separate module. If a future use case requires DynamoDB, only the fetcher changes.

### 5. How the Aggregation Engine Works

Today (hardcoded):

```typescript
if (operatorName === 'Analytics') {
  const aiRetained = payload.ai_retained;
  if (typeof aiRetained === 'boolean') {
    await incrementMetric(tenantId, date, 'poc_ai_retained_count', aiRetained ? 1 : 0);
    await incrementMetric(tenantId, date, 'poc_ai_retained_total', 1);
  }
  // ... 50 more lines per operator
}
```

After (config-driven):

```typescript
const config = await loadConfig(operatorName);
for (const metric of config.metrics) {
  const value = extractField(payload, metric.field);
  await aggregateByType(metric, value, tenantId, date);
}
```

Where `aggregateByType` dispatches to primitive handlers:

```typescript
async function aggregateByType(metric, value, tenantId, date) {
  switch (metric.type) {
    case 'boolean':
      if (typeof value === 'boolean') {
        if (value) await incrementMetric(tenantId, date, `${metric.metricPrefix}_count`, 1);
        await incrementMetric(tenantId, date, `${metric.metricPrefix}_total`, 1);
      }
      break;

    case 'integer':
      if (typeof value === 'number'
          && (!metric.min || value >= metric.min)
          && (!metric.max || value <= metric.max)) {
        await incrementMetric(tenantId, date, `${metric.metricPrefix}_sum`, value);
        await incrementMetric(tenantId, date, `${metric.metricPrefix}_count`, 1);
        if (metric.distribution) {
          await incrementMetric(tenantId, date, `${metric.metricPrefix}_${value}`, 1);
        }
      }
      break;

    case 'category':
      if (typeof value === 'string') {
        const normalized = value.toLowerCase().replace(/\s+/g, '_');
        await incrementMetric(tenantId, date, `${metric.metricPrefix}_${normalized}`, 1);
      }
      break;

    case 'enum':
      if (typeof value === 'string' && !metric.ignoreValues?.includes(value)) {
        const normalized = value.toLowerCase().replace(/\s+/g, '_');
        await incrementMetric(tenantId, date, `${metric.metricPrefix}_${normalized}`, 1);
        await incrementMetric(tenantId, date, `${metric.metricPrefix}_total`, 1);
      }
      break;

    case 'category_array':
      if (Array.isArray(value)) {
        for (const item of value) {
          const category = item[metric.categoryField] as string;
          const subcategory = item[metric.subcategoryField] as string;
          if (category) {
            const normCat = category.toLowerCase().replace(/\s+/g, '_');
            await incrementMetric(tenantId, date, `${metric.metricPrefix}_${normCat}`, 1);
            if (subcategory && metric.subcategoryPrefix) {
              const normCombined = `${category} - ${subcategory}`.toLowerCase().replace(/\s+/g, '_');
              await incrementMetric(tenantId, date, `${metric.subcategoryPrefix}_${normCombined}`, 1);
            }
          }
        }
      }
      break;
  }
}
```

### 6. How the API Auto-Derives Metrics

Today, every derived metric is manually mapped:

```typescript
const derivedMetricDependencies = {
  'poc_csat_avg': ['poc_csat_sum', 'poc_csat_count'],
  'poc_handoff_customer_request_rate_percent': ['poc_handoff_customer_request', 'conversation_count'],
  // ... 30+ manual entries
};
```

After, the API reads the config and generates the map automatically:

```typescript
function buildDerivedMetrics(configs: OperatorConfig[]): DerivedMetricMap {
  const map = {};
  for (const config of configs) {
    for (const metric of config.metrics) {
      switch (metric.type) {
        case 'boolean':
          map[`${metric.metricPrefix}_rate_percent`] = [
            `${metric.metricPrefix}_count`,
            `${metric.metricPrefix}_total`
          ];
          break;

        case 'integer':
          map[`${metric.metricPrefix}_avg`] = [
            `${metric.metricPrefix}_sum`,
            `${metric.metricPrefix}_count`
          ];
          break;

        case 'enum':
          for (const value of metric.values.filter(v => !metric.ignoreValues?.includes(v))) {
            const normalized = value.toLowerCase().replace(/\s+/g, '_');
            map[`${metric.metricPrefix}_${normalized}_rate_percent`] = [
              `${metric.metricPrefix}_${normalized}`,
              'conversation_count'
            ];
          }
          break;
      }
    }
  }
  return map;
}
```

Display names work the same way — generated from config, not hardcoded:

```typescript
function buildDisplayNames(configs: OperatorConfig[]): Record<string, string> {
  const names = {};
  for (const config of configs) {
    for (const metric of config.metrics) {
      switch (metric.type) {
        case 'boolean':
          names[`${metric.metricPrefix}_rate_percent`] = `${metric.displayName} (%)`;
          break;
        case 'integer':
          names[`${metric.metricPrefix}_avg`] = `${metric.displayName} Medio`;
          break;
        case 'enum':
          for (const [value, display] of Object.entries(metric.valueDisplayNames || {})) {
            const normalized = value.toLowerCase().replace(/\s+/g, '_');
            names[`${metric.metricPrefix}_${normalized}`] = `${metric.displayName}: ${display}`;
            names[`${metric.metricPrefix}_${normalized}_rate_percent`] = `${metric.displayName}: ${display} (%)`;
          }
          break;
      }
    }
  }
  return names;
}
```

### 7. Migration Path

The config-driven system coexists with hardcoded blocks during migration:

1. ~~Build config schema and loader~~ — **Done** (`packages/shared/src/operator-config.ts`, `config-loader.ts`, `s3-config.ts`)
2. ~~Create configs for existing operators~~ — **Done** (`config/operator-metrics.json` with Analytics + General KPIs)
3. ~~Deploy config to S3~~ — **Done** (CDK `BucketDeployment` to `s3://{bucket}/config/`)
4. ~~Build the generic aggregation engine~~ — **Done** (`services/processor/src/storage/aggregation-engine.ts`)
5. ~~Wire into processor handler with fallback to hardcoded~~ — **Done** (config-driven first, hardcoded fallback)
6. ~~Verify parity between config-driven and hardcoded output~~ — **Done** (deployed to dev, verified metrics match)
7. Build API auto-derived metrics and auto-display names from config
8. Remove hardcoded aggregation blocks
9. Migrate `operator-fields.json` into `operator-metrics.json` (`surfaceInList` flag)

### 8. What This Unlocks

- **New operator in minutes**: drop a config entry, redeploy, done
- **No TypeScript knowledge needed**: config is JSON
- **Consistent behavior**: all operators follow the same patterns
- **Auto-display names**: no manual translation per metric
- **Auto-derived metrics**: `&metric=` filter works for all derived metrics automatically
- **Auto-conversation enrichment**: `surfaceInList` flag replaces separate config file
- **Foundation for operator field indexing**: config declares which fields to index

### 9. What This Does NOT Cover (Separate Roadmap Items)

These remain independent work items:

- **API Gateway authentication** — API key / Cognito support
- **Hourly aggregation granularity** — dual-write to DAY + HOUR keys
- **Duplicate transcript deduplication** — call SID marker at ingestion
- **Operator field indexing** — denormalized lookup records for drill-down queries
