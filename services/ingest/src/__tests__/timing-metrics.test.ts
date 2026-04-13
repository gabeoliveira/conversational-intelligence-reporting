import { computeTimingMetrics, TranscriptSentence } from '../twilio-client';

// Use real-world channels: 1 = agent (speaks first), 2 = customer
const AGENT = 1;
const CUSTOMER = 2;

function sentence(overrides: Partial<TranscriptSentence> & Pick<TranscriptSentence, 'startTime' | 'endTime' | 'mediaChannel'>): TranscriptSentence {
  return {
    index: 0,
    text: 'test',
    confidence: 0.95,
    ...overrides,
  };
}

describe('computeTimingMetrics', () => {
  it('returns null for empty sentences', () => {
    expect(computeTimingMetrics([])).toBeNull();
  });

  it('computes handling time from first to last sentence', () => {
    const sentences: TranscriptSentence[] = [
      sentence({ startTime: 0, endTime: 5, mediaChannel: AGENT }),
      sentence({ startTime: 6, endTime: 12, mediaChannel: CUSTOMER }),
      sentence({ startTime: 13, endTime: 20, mediaChannel: AGENT }),
    ];
    const result = computeTimingMetrics(sentences)!;
    expect(result.handlingTimeSec).toBe(20);
  });

  it('handles a single sentence', () => {
    const sentences: TranscriptSentence[] = [
      sentence({ startTime: 5, endTime: 10, mediaChannel: AGENT }),
    ];
    const result = computeTimingMetrics(sentences)!;
    expect(result.handlingTimeSec).toBe(5);
    expect(result.avgResponseTimeSec).toBe(0);
    expect(result.avgCustomerWaitTimeSec).toBe(0);
    expect(result.sentenceCount).toBe(1);
    expect(result.agentSentenceCount).toBe(1);
    expect(result.customerSentenceCount).toBe(0);
  });

  it('computes agent response time (customer → agent gap)', () => {
    const sentences: TranscriptSentence[] = [
      sentence({ startTime: 0, endTime: 3, mediaChannel: AGENT }),    // agent speaks first (sets channel detection)
      sentence({ startTime: 4, endTime: 8, mediaChannel: CUSTOMER }), // customer ends at 8
      sentence({ startTime: 11, endTime: 15, mediaChannel: AGENT }),   // agent starts at 11 → gap = 3
    ];
    const result = computeTimingMetrics(sentences)!;
    expect(result.avgResponseTimeSec).toBe(3);
  });

  it('computes customer wait time (agent → customer gap)', () => {
    const sentences: TranscriptSentence[] = [
      sentence({ startTime: 0, endTime: 5, mediaChannel: AGENT }),    // agent ends at 5
      sentence({ startTime: 7, endTime: 12, mediaChannel: CUSTOMER }), // customer starts at 7 → gap = 2
    ];
    const result = computeTimingMetrics(sentences)!;
    expect(result.avgCustomerWaitTimeSec).toBe(2);
  });

  it('averages multiple response times correctly', () => {
    const sentences: TranscriptSentence[] = [
      sentence({ startTime: 0, endTime: 5, mediaChannel: AGENT }),    // agent
      sentence({ startTime: 7, endTime: 12, mediaChannel: CUSTOMER }), // customer, wait = 2
      sentence({ startTime: 14, endTime: 18, mediaChannel: AGENT }),   // agent, response = 2
      sentence({ startTime: 22, endTime: 28, mediaChannel: CUSTOMER }), // customer, wait = 4
    ];
    const result = computeTimingMetrics(sentences)!;
    // Customer wait times: 2, 4 → avg = 3
    expect(result.avgCustomerWaitTimeSec).toBe(3);
    // Agent response times: 2 → avg = 2
    expect(result.avgResponseTimeSec).toBe(2);
  });

  it('ignores overlapping sentences (negative gaps)', () => {
    const sentences: TranscriptSentence[] = [
      sentence({ startTime: 0, endTime: 10, mediaChannel: AGENT }),
      sentence({ startTime: 8, endTime: 15, mediaChannel: CUSTOMER }), // overlap: 8 - 10 = -2
    ];
    const result = computeTimingMetrics(sentences)!;
    expect(result.avgCustomerWaitTimeSec).toBe(0);
  });

  it('handles monologue (all same channel)', () => {
    const sentences: TranscriptSentence[] = [
      sentence({ startTime: 0, endTime: 5, mediaChannel: AGENT }),
      sentence({ startTime: 6, endTime: 10, mediaChannel: AGENT }),
      sentence({ startTime: 11, endTime: 15, mediaChannel: AGENT }),
    ];
    const result = computeTimingMetrics(sentences)!;
    expect(result.handlingTimeSec).toBe(15);
    expect(result.avgResponseTimeSec).toBe(0);
    expect(result.avgCustomerWaitTimeSec).toBe(0);
    expect(result.agentSentenceCount).toBe(3);
    expect(result.customerSentenceCount).toBe(0);
  });

  it('counts sentences by channel correctly', () => {
    const sentences: TranscriptSentence[] = [
      sentence({ startTime: 0, endTime: 3, mediaChannel: AGENT }),
      sentence({ startTime: 4, endTime: 7, mediaChannel: CUSTOMER }),
      sentence({ startTime: 8, endTime: 11, mediaChannel: AGENT }),
      sentence({ startTime: 12, endTime: 15, mediaChannel: CUSTOMER }),
      sentence({ startTime: 16, endTime: 19, mediaChannel: AGENT }),
    ];
    const result = computeTimingMetrics(sentences)!;
    expect(result.sentenceCount).toBe(5);
    expect(result.agentSentenceCount).toBe(3);
    expect(result.customerSentenceCount).toBe(2);
  });

  it('rounds values to 2 decimal places', () => {
    const sentences: TranscriptSentence[] = [
      sentence({ startTime: 0, endTime: 3.333, mediaChannel: AGENT }),
      sentence({ startTime: 5.777, endTime: 9.111, mediaChannel: CUSTOMER }),
    ];
    const result = computeTimingMetrics(sentences)!;
    expect(result.handlingTimeSec).toBe(9.11);
    // customer wait: 5.777 - 3.333 = 2.444 → 2.44
    expect(result.avgCustomerWaitTimeSec).toBe(2.44);
  });

  it('handles zero-length gaps (immediate response)', () => {
    const sentences: TranscriptSentence[] = [
      sentence({ startTime: 0, endTime: 5, mediaChannel: AGENT }),
      sentence({ startTime: 5, endTime: 10, mediaChannel: CUSTOMER }), // gap = 0
    ];
    const result = computeTimingMetrics(sentences)!;
    expect(result.avgCustomerWaitTimeSec).toBe(0);
  });

  it('auto-detects channel roles from real Twilio data (channels 1 and 2)', () => {
    // Real-world: channel 1 = bot/agent (speaks first), channel 2 = customer
    const sentences: TranscriptSentence[] = [
      sentence({ startTime: 0.74, endTime: 14.49, mediaChannel: 1 }),  // agent greeting
      sentence({ startTime: 14.11, endTime: 17.42, mediaChannel: 2 }), // customer question
      sentence({ startTime: 19.92, endTime: 30.84, mediaChannel: 1 }), // agent response
    ];
    const result = computeTimingMetrics(sentences)!;
    expect(result.agentSentenceCount).toBe(2);
    expect(result.customerSentenceCount).toBe(1);
    // Agent response time: 19.92 - 17.42 = 2.5
    expect(result.avgResponseTimeSec).toBe(2.5);
  });
});
