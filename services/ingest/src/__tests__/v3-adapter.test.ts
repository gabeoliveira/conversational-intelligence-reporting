import { V3Adapter, isV3RuleExecutionWebhook } from '../adapters/v3-adapter';
import type { AdapterContext } from '../adapters/adapter';

// Real BTG webhook shape captured from a sandbox account, lightly reformatted.
// Kept verbatim so regressions are caught against the live shape. Account SID
// + Memora profileId scrubbed to safe placeholders.
const realBtgPayload = {
  accountId: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  conversationId: 'conv_conversation_01ktmfgjf2e1794ees96m6fvgv',
  intelligenceConfiguration: {
    id: 'intelligence_configuration_01kgfnfefce7praqac1ab9cew2',
    displayName: 'Conversas',
    version: 18,
    ruleId: 'intelligence_configurationrule_01ktmfd8x2fp3tq0b17ravev1w',
  },
  operatorResults: [
    {
      id: 'intelligence_operatorresult_01ktmfgvbwe7fst3mkwcdxtc84',
      operator: {
        id: 'intelligence_operator_01ktmfak4dfnq86rfd043r9t6v',
        displayName: 'CEP Lookup Enrichment',
        version: 1,
        parameters: {},
      },
      outputFormat: 'JSON',
      result: {
        lookups: [],
        summary: {
          error_lookups: 0,
          invalid_ceps: 0,
          not_found_ceps: 0,
          successful_lookups: 0,
          total_lookups: 0,
        },
      },
      dateCreated: '2026-06-08T20:41:53.788355855Z',
      referenceIds: ['CHd5d8a0ae79894c8bb6a90460dbcc255b'],
      executionDetails: {
        trigger: { on: 'COMMUNICATION', timestamp: '2026-06-08T20:41:52.387426051Z' },
        communications: {
          first: 'conv_communication_01ktmfgjepete95acbvb44dj5m',
          last: 'conv_communication_01ktmfgsrneh0a8kmgpstd9a53',
        },
        channels: ['WHATSAPP'],
        participants: [
          { id: 'conv_participant_01ktmfgss1eevs991g9j189as2', profileId: null, type: 'UNKNOWN' },
          { id: 'conv_participant_01ktmfgkbbfpza4bthxrhmvw51', profileId: null, type: 'AI_AGENT' },
          {
            id: 'conv_participant_01ktmfgjf2es6vd494d6dfrdz2',
            profileId: 'mem_profile_xxxxxxxxxxxxxxxxxxxxxxxxxx',
            type: 'CUSTOMER',
          },
        ],
        resolvedContext: { memory: null, knowledge: null },
      },
      metadata: {
        system: {
          latencyMs: 896,
          resolvedModel: 'gpt-5.4-mini',
          inputCharacters: 3582,
          outputCharacters: 121,
          inputTruncated: false,
        },
      },
    },
  ],
};

const ctx: AdapterContext = {
  tenantId: 'btg-mvp',
  requestId: 'req-123',
  receivedAt: '2026-06-08T20:41:55.000Z',
  headers: {},
};

describe('V3Adapter', () => {
  const adapter = new V3Adapter();

  describe('isV3RuleExecutionWebhook', () => {
    it('returns true for valid v3 payload', () => {
      expect(isV3RuleExecutionWebhook(realBtgPayload as any)).toBe(true);
    });

    it('returns false for v2-style payload', () => {
      expect(isV3RuleExecutionWebhook({
        transcript_sid: 'GT123',
        event_type: 'voice_intelligence_transcript_available',
      })).toBe(false);
    });

    it('returns false for empty object', () => {
      expect(isV3RuleExecutionWebhook({})).toBe(false);
    });

    it('returns false when operatorResults is missing', () => {
      const { operatorResults, ...rest } = realBtgPayload as any;
      expect(isV3RuleExecutionWebhook(rest)).toBe(false);
    });
  });

  describe('normalize', () => {
    it('produces one NormalizedResult per operator in the payload', async () => {
      const results = await adapter.normalize(realBtgPayload as any, ctx);
      expect(results).toHaveLength(1);
    });

    it('maps the v3 conversationId verbatim (opaque conv_conversation_*)', async () => {
      const [result] = await adapter.normalize(realBtgPayload as any, ctx);
      expect(result.conversationId).toBe('conv_conversation_01ktmfgjf2e1794ees96m6fvgv');
    });

    it('uses operator.displayName as operatorName', async () => {
      const [result] = await adapter.normalize(realBtgPayload as any, ctx);
      expect(result.operatorName).toBe('CEP Lookup Enrichment');
    });

    it('prefixes the operator.version integer to form schemaVersion', async () => {
      const [result] = await adapter.normalize(realBtgPayload as any, ctx);
      expect(result.schemaVersion).toBe('v1');
    });

    it('extracts the rule trigger', async () => {
      const [result] = await adapter.normalize(realBtgPayload as any, ctx);
      expect(result.trigger).toBe('COMMUNICATION');
    });

    it('uses dateCreated as the timestamp', async () => {
      const [result] = await adapter.normalize(realBtgPayload as any, ctx);
      expect(result.timestamp).toBe('2026-06-08T20:41:53.788355855Z');
    });

    it('passes the JSON result payload through verbatim under .data', async () => {
      const [result] = await adapter.normalize(realBtgPayload as any, ctx);
      expect(result.s3Payload.data).toEqual({
        lookups: [],
        summary: {
          error_lookups: 0,
          invalid_ceps: 0,
          not_found_ceps: 0,
          successful_lookups: 0,
          total_lookups: 0,
        },
      });
    });

    it('captures the CH* Conversations SID in referenceSids.conversationSid', async () => {
      const [result] = await adapter.normalize(realBtgPayload as any, ctx);
      expect(result.s3Payload.metadata?.referenceSids).toEqual({
        conversationSid: 'CHd5d8a0ae79894c8bb6a90460dbcc255b',
      });
    });

    it('uses CUSTOMER participant profileId as customerKey', async () => {
      const [result] = await adapter.normalize(realBtgPayload as any, ctx);
      expect(result.s3Payload.metadata?.customerKey).toBe(
        'mem_profile_xxxxxxxxxxxxxxxxxxxxxxxxxx'
      );
    });

    it('lowercases channels[0] for metadata.channel', async () => {
      const [result] = await adapter.normalize(realBtgPayload as any, ctx);
      expect(result.s3Payload.metadata?.channel).toBe('whatsapp');
    });

    it('preserves executionMetadata for downstream observability', async () => {
      const [result] = await adapter.normalize(realBtgPayload as any, ctx);
      expect(result.s3Payload.metadata?.executionMetadata).toEqual({
        latencyMs: 896,
        resolvedModel: 'gpt-5.4-mini',
        inputCharacters: 3582,
        outputCharacters: 121,
        inputTruncated: false,
      });
    });

    it('stamps ciVersion: v3 on both s3Payload and result', async () => {
      const [result] = await adapter.normalize(realBtgPayload as any, ctx);
      expect(result.ciVersion).toBe('v3');
      expect(result.s3Payload.ciVersion).toBe('v3');
    });

    it('attaches _meta with tenant/request info', async () => {
      const [result] = await adapter.normalize(realBtgPayload as any, ctx);
      expect(result.s3Payload._meta).toEqual({
        tenantId: 'btg-mvp',
        receivedAt: '2026-06-08T20:41:55.000Z',
        requestId: 'req-123',
      });
    });

    it('returns null trigger when payload has no executionDetails.trigger.on', async () => {
      const payload = JSON.parse(JSON.stringify(realBtgPayload));
      delete payload.operatorResults[0].executionDetails.trigger.on;
      const [result] = await adapter.normalize(payload, ctx);
      expect(result.trigger).toBeNull();
    });

    it('tolerates UNKNOWN participant type without throwing', async () => {
      // The real payload already contains an UNKNOWN participant; this
      // test guards against a future regression that would over-validate.
      await expect(adapter.normalize(realBtgPayload as any, ctx)).resolves.toBeDefined();
    });

    it('wraps TEXT outputFormat results as { text }', async () => {
      const payload = JSON.parse(JSON.stringify(realBtgPayload));
      payload.operatorResults[0].outputFormat = 'TEXT';
      payload.operatorResults[0].result = 'a quick summary';
      const [result] = await adapter.normalize(payload, ctx);
      expect(result.s3Payload.data).toEqual({ text: 'a quick summary' });
    });

    it('passes CLASSIFICATION results through as { label }', async () => {
      const payload = JSON.parse(JSON.stringify(realBtgPayload));
      payload.operatorResults[0].outputFormat = 'CLASSIFICATION';
      payload.operatorResults[0].result = { label: 'positive' };
      const [result] = await adapter.normalize(payload, ctx);
      expect(result.s3Payload.data).toEqual({ label: 'positive' });
    });

    it('returns an empty array when operatorResults is empty', async () => {
      const payload = { ...realBtgPayload, operatorResults: [] };
      const results = await adapter.normalize(payload as any, ctx);
      expect(results).toEqual([]);
    });

    it('throws when payload is missing required v3 keys', async () => {
      await expect(adapter.normalize({} as any, ctx)).rejects.toThrow(
        /v3 Rule Execution webhook/
      );
    });

    it('emits N results when a single webhook carries N operators', async () => {
      const payload = JSON.parse(JSON.stringify(realBtgPayload));
      payload.operatorResults.push({
        ...payload.operatorResults[0],
        id: 'intelligence_operatorresult_second',
        operator: {
          ...payload.operatorResults[0].operator,
          displayName: 'Sentiment',
          version: 2,
        },
        outputFormat: 'CLASSIFICATION',
        result: { label: 'positive' },
      });
      const results = await adapter.normalize(payload, ctx);
      expect(results.map((r) => r.operatorName)).toEqual(['CEP Lookup Enrichment', 'Sentiment']);
      expect(results[1].schemaVersion).toBe('v2');
    });
  });
});
