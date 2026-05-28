// Mock the DynamoDB client + DocumentClient at the @aws-sdk layer so we can
// inspect what writeConversation actually sends.
const mockDocSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDocSend })) },
  PutCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'Put', input })),
  UpdateCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'Update', input })),
  GetCommand: jest.fn().mockImplementation((input: any) => ({ __type: 'Get', input })),
}));

// Mock the shared index-writer module so we can assert on the high-level
// "wrote an index for fieldName" intent without re-asserting the PK format
// (that's covered in aggregation-engine.test.ts).
const mockWriteIndexRecord = jest.fn().mockResolvedValue(undefined);
jest.mock('../storage/index-writer', () => ({
  writeIndexRecord: mockWriteIndexRecord,
  INDEX_TTL_DAYS: 180,
}));

process.env.TABLE_NAME = 'cirl-test';
process.env.CIRL_ENRICHMENT_ENABLED = 'true';
process.env.CIRL_ENRICHMENT_FILTERABLE_FIELDS = 'interaction_id,crm_ticket';

import { writeConversation } from '../storage/dynamo';

function getConversationPutPayload() {
  // The UpdateCommand for the spine carries the JSON-stringified payload in
  // ExpressionAttributeValues[':payload']. Find the most recent such call.
  const updateCalls = mockDocSend.mock.calls.filter((c: any[]) => c[0]?.__type === 'Update');
  if (!updateCalls.length) return null;
  const latest = updateCalls[updateCalls.length - 1][0];
  const raw = latest.input?.ExpressionAttributeValues?.[':payload'];
  return raw ? JSON.parse(raw) : null;
}

describe('writeConversation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // GetCommand for enrichment lookup returns no item by default
    mockDocSend.mockResolvedValue({});
  });

  describe('customerPhoneLast4 extraction', () => {
    it('extracts last 4 digits from an E.164 phone', async () => {
      await writeConversation({
        tenantId: 't1',
        conversationId: 'C1',
        receivedAt: '2026-05-26T10:00:00Z',
        metadata: {
          channel: {
            participants: [
              { role: 'Customer', media_participant_id: '+5511976932682' },
            ],
          },
        },
      });
      const payload = getConversationPutPayload();
      expect(payload).toBeTruthy();
      expect(payload.customerPhoneLast4).toBe('2682');
      expect(payload.customerPhone).toBe('+5511*****2682');
    });

    it('strips SIP URI before extracting last 4', async () => {
      await writeConversation({
        tenantId: 't1',
        conversationId: 'C2',
        receivedAt: '2026-05-26T10:00:00Z',
        metadata: {
          channel: {
            participants: [
              { role: 'Customer', media_participant_id: 'sip:+553122980059@54.82.188.43' },
            ],
          },
        },
      });
      const payload = getConversationPutPayload();
      expect(payload.customerPhoneLast4).toBe('0059');
    });

    it('returns null when phone is missing', async () => {
      await writeConversation({
        tenantId: 't1',
        conversationId: 'C3',
        receivedAt: '2026-05-26T10:00:00Z',
        metadata: { channel: { participants: [] } },
      });
      const payload = getConversationPutPayload();
      expect(payload.customerPhoneLast4).toBeNull();
    });

    it('returns null for phones too short to mask', async () => {
      await writeConversation({
        tenantId: 't1',
        conversationId: 'C4',
        receivedAt: '2026-05-26T10:00:00Z',
        metadata: {
          channel: { participants: [{ role: 'Customer', media_participant_id: '123' }] },
        },
      });
      const payload = getConversationPutPayload();
      expect(payload.customerPhoneLast4).toBeNull();
    });
  });

  describe('customer_phone_last4 index write', () => {
    it('writes an index record for the last 4 digits', async () => {
      await writeConversation({
        tenantId: 't1',
        conversationId: 'C5',
        receivedAt: '2026-05-26T10:00:00Z',
        metadata: {
          channel: {
            participants: [{ role: 'Customer', media_participant_id: '+5511976932682' }],
          },
        },
      });

      const calls = mockWriteIndexRecord.mock.calls.filter(
        (c) => c[1] === 'customer_phone_last4'
      );
      expect(calls).toHaveLength(1);
      // (tenantId, fieldName, fieldValue, conversationId, timestamp)
      expect(calls[0][0]).toBe('t1');
      expect(calls[0][2]).toBe('2682');
      expect(calls[0][3]).toBe('C5');
    });

    it('does not write the phone index when phone is absent', async () => {
      await writeConversation({
        tenantId: 't1',
        conversationId: 'C6',
        receivedAt: '2026-05-26T10:00:00Z',
        metadata: { channel: { participants: [] } },
      });
      const calls = mockWriteIndexRecord.mock.calls.filter(
        (c) => c[1] === 'customer_phone_last4'
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe('enrichment filterable fields index writes', () => {
    it('writes an index for each configured filterable field present in enrichment', async () => {
      // Mock the enrichment GetCommand to return a record with both
      // configured fields plus an unconfigured extra (which must NOT be indexed).
      mockDocSend.mockImplementation((cmd: any) => {
        if (cmd?.__type === 'Get') {
          return Promise.resolve({
            Item: {
              fields: {
                interaction_id: 'genesys-12345',
                crm_ticket: 'T-789',
                not_filterable: 'should-not-index',
              },
            },
          });
        }
        return Promise.resolve({});
      });

      await writeConversation({
        tenantId: 't1',
        conversationId: 'C7',
        receivedAt: '2026-05-26T10:00:00Z',
        metadata: {
          channel: {
            media_properties: { reference_sids: { call_sid: 'CA-xyz' } },
            participants: [],
          },
        },
      });

      // Indexed fields by name
      const indexedNames = mockWriteIndexRecord.mock.calls.map((c) => c[1]);
      expect(indexedNames).toContain('interaction_id');
      expect(indexedNames).toContain('crm_ticket');
      expect(indexedNames).not.toContain('not_filterable');

      // Verify values made it through
      const interactionCall = mockWriteIndexRecord.mock.calls.find(
        (c) => c[1] === 'interaction_id'
      );
      expect(interactionCall![2]).toBe('genesys-12345');
      expect(interactionCall![3]).toBe('C7');
    });

    it('skips enrichment indexes when no enrichment exists for the call', async () => {
      // Default mock returns no Item for Get
      await writeConversation({
        tenantId: 't1',
        conversationId: 'C8',
        receivedAt: '2026-05-26T10:00:00Z',
        metadata: {
          channel: {
            media_properties: { reference_sids: { call_sid: 'CA-no-enrichment' } },
            participants: [],
          },
        },
      });

      const indexedNames = mockWriteIndexRecord.mock.calls.map((c) => c[1]);
      expect(indexedNames).not.toContain('interaction_id');
      expect(indexedNames).not.toContain('crm_ticket');
    });

    it('skips index for an empty-string enrichment value', async () => {
      mockDocSend.mockImplementation((cmd: any) => {
        if (cmd?.__type === 'Get') {
          return Promise.resolve({
            Item: { fields: { interaction_id: '', crm_ticket: 'T-1' } },
          });
        }
        return Promise.resolve({});
      });

      await writeConversation({
        tenantId: 't1',
        conversationId: 'C9',
        receivedAt: '2026-05-26T10:00:00Z',
        metadata: {
          channel: {
            media_properties: { reference_sids: { call_sid: 'CA-empty' } },
            participants: [],
          },
        },
      });

      const indexedNames = mockWriteIndexRecord.mock.calls.map((c) => c[1]);
      expect(indexedNames).not.toContain('interaction_id');
      expect(indexedNames).toContain('crm_ticket');
    });
  });
});
