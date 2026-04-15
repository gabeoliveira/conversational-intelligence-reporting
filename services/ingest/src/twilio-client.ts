import Twilio from 'twilio';
import type { TwilioOperatorResult, TwilioOperatorResultsResponse } from './types';

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const authToken = process.env.TWILIO_AUTH_TOKEN!;

/**
 * Fetch operator results from Twilio CI API for a given transcript
 * Note: .list() only returns summary data, so we fetch each result individually
 */
export async function fetchOperatorResults(transcriptSid: string): Promise<TwilioOperatorResult[]> {
  const client = Twilio(accountSid, authToken);

  // List operator results to get their SIDs (unredacted)
  const operatorResultList = await client.intelligence.v2
    .transcripts(transcriptSid)
    .operatorResults
    .list({ redacted: false });

  // Fetch each operator result individually to get full data (unredacted)
  const fullResults = await Promise.all(
    operatorResultList.map(async (summary) => {
      const fullResult = await client.intelligence.v2
        .transcripts(transcriptSid)
        .operatorResults(summary.operatorSid)
        .fetch({ redacted: false });

      return {
        operator_sid: fullResult.operatorSid,
        operator_type: fullResult.operatorType,
        name: fullResult.name,
        ...normalizeOperatorResult(fullResult),
      };
    })
  );

  return fullResults;
}

/**
 * Fetch transcript details from Twilio CI API
 */
export async function fetchTranscript(transcriptSid: string): Promise<{
  sid: string;
  serviceSid: string;
  accountSid: string;
  channel: string;
  customerKey?: string;
  dateCreated: Date;
  status: string;
}> {
  const client = Twilio(accountSid, authToken);

  const transcript = await client.intelligence.v2
    .transcripts(transcriptSid)
    .fetch();

  return {
    sid: transcript.sid,
    serviceSid: transcript.serviceSid,
    accountSid: transcript.accountSid,
    channel: transcript.channel as string,
    customerKey: transcript.customerKey ?? undefined,
    dateCreated: transcript.dateCreated,
    status: transcript.status,
  };
}

/**
 * Fetch transcript sentences from Twilio CI API.
 * Each sentence includes start/end timestamps and media_channel (agent vs customer),
 * which we use to compute handling time and response time.
 *
 * Returns sentences sorted by start_time ascending.
 */
export async function fetchSentences(transcriptSid: string): Promise<TranscriptSentence[]> {
  const client = Twilio(accountSid, authToken);

  const sentences = await client.intelligence.v2
    .transcripts(transcriptSid)
    .sentences
    .list();

  return sentences
    .map((s) => ({
      index: s.sentenceIndex,
      text: s.transcript,
      startTime: parseFloat(s.startTime),     // seconds from start of recording
      endTime: parseFloat(s.endTime),         // seconds from start of recording
      mediaChannel: s.mediaChannel,           // 0 = customer, 1 = agent (typically)
      confidence: parseFloat(s.confidence),
    }))
    .sort((a, b) => a.startTime - b.startTime);
}

export interface TranscriptSentence {
  index: number;
  text: string;
  startTime: number;
  endTime: number;
  mediaChannel: number;
  confidence: number;
}

/**
 * Compute timing metrics from transcript sentences.
 *
 * - handlingTimeSec: total duration from first to last sentence
 * - avgResponseTimeSec: average time between a customer sentence ending
 *   and the next agent sentence starting (agent reaction time)
 * - avgCustomerWaitTimeSec: average time between an agent sentence ending
 *   and the next customer sentence starting
 * - sentenceCount: total number of sentences
 * - agentSentenceCount / customerSentenceCount: per-role counts
 */
// Maximum plausible call duration (2 hours). Anything above this indicates
// corrupted timestamp data (e.g., absolute Unix timestamps instead of relative offsets).
const MAX_HANDLING_TIME_SEC = 7200;

export function computeTimingMetrics(sentences: TranscriptSentence[]): TimingMetrics | null {
  if (sentences.length === 0) return null;

  const handlingTimeSec = sentences[sentences.length - 1].endTime - sentences[0].startTime;

  // Sanity check: discard results with implausible handling times
  if (handlingTimeSec < 0 || handlingTimeSec > MAX_HANDLING_TIME_SEC) {
    console.warn(`Discarding timing metrics: handlingTimeSec=${handlingTimeSec} exceeds max ${MAX_HANDLING_TIME_SEC}s`);
    return null;
  }

  // Compute response times: time from customer utterance end → next agent utterance start
  const agentResponseTimes: number[] = [];
  const customerWaitTimes: number[] = [];

  // Determine which channel is agent and which is customer.
  // Twilio uses 1-based channels: typically 1 = agent (or IVR/bot), 2 = customer.
  // But it can vary, so we detect: the channel that speaks first is usually the agent.
  const firstChannel = sentences[0].mediaChannel;
  const agentChannel = firstChannel;
  const customerChannel = sentences.find(s => s.mediaChannel !== firstChannel)?.mediaChannel;

  if (customerChannel === undefined) {
    // Monologue — only one party spoke, no response times to compute
    return {
      handlingTimeSec: Math.round(handlingTimeSec * 100) / 100,
      avgResponseTimeSec: 0,
      avgCustomerWaitTimeSec: 0,
      sentenceCount: sentences.length,
      agentSentenceCount: sentences.filter(s => s.mediaChannel === agentChannel).length,
      customerSentenceCount: 0,
    };
  }

  for (let i = 0; i < sentences.length - 1; i++) {
    const current = sentences[i];
    const next = sentences[i + 1];

    // Customer finished, agent responds
    if (current.mediaChannel === customerChannel && next.mediaChannel === agentChannel) {
      const gap = next.startTime - current.endTime;
      if (gap >= 0) agentResponseTimes.push(gap);
    }

    // Agent finished, customer responds
    if (current.mediaChannel === agentChannel && next.mediaChannel === customerChannel) {
      const gap = next.startTime - current.endTime;
      if (gap >= 0) customerWaitTimes.push(gap);
    }
  }

  const avg = (arr: number[]) => arr.length > 0
    ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100
    : 0;

  return {
    handlingTimeSec: Math.round(handlingTimeSec * 100) / 100,
    avgResponseTimeSec: avg(agentResponseTimes),
    avgCustomerWaitTimeSec: avg(customerWaitTimes),
    sentenceCount: sentences.length,
    agentSentenceCount: sentences.filter((s) => s.mediaChannel === agentChannel).length,
    customerSentenceCount: sentences.filter((s) => s.mediaChannel === customerChannel).length,
  };
}

export interface TimingMetrics {
  handlingTimeSec: number;
  avgResponseTimeSec: number;
  avgCustomerWaitTimeSec: number;
  sentenceCount: number;
  agentSentenceCount: number;
  customerSentenceCount: number;
}

/**
 * Normalize operator result data based on operator type
 * Captures all known result fields from Twilio CI API
 */
function normalizeOperatorResult(result: any): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  // Text generation results (for generative operators like summaries)
  if (result.textGenerationResults) {
    normalized.text_generation_results = result.textGenerationResults;
  }

  // Text extraction results
  if (result.textExtractionResults) {
    normalized.text_extraction_results = result.textExtractionResults;
  }

  // Text classification results
  if (result.predictedLabel) {
    normalized.text_classification_results = {
      prediction: result.predictedLabel,
      predicted_probability: result.predictedProbability,
    };
  }

  // Label probabilities
  if (result.labelProbabilities) {
    normalized.label_probabilities = result.labelProbabilities;
  }

  // Extract results
  if (result.extractResults) {
    normalized.extract_results = result.extractResults;
  }

  // Utterance results (for per-utterance operators)
  if (result.utteranceResults) {
    normalized.utterance_results = result.utteranceResults;
  }

  // Predicted probability (standalone)
  if (typeof result.predictedProbability === 'number') {
    normalized.predicted_probability = result.predictedProbability;
  }

  // Match probability
  if (typeof result.matchProbability === 'number') {
    normalized.match_probability = result.matchProbability;
  }

  // Normalized results (for normalized extraction)
  if (result.normalizedResults) {
    normalized.normalized_results = result.normalizedResults;
  }

  // JSON results (for json-type operators like custom generative operators)
  if (result.jsonResults) {
    normalized.json_results = result.jsonResults;
  }

  // Extract match flag
  if (typeof result.extractMatch === 'boolean') {
    normalized.extract_match = result.extractMatch;
  }

  // Utterance match flag
  if (typeof result.utteranceMatch === 'boolean') {
    normalized.utterance_match = result.utteranceMatch;
  }

  return normalized;
}
