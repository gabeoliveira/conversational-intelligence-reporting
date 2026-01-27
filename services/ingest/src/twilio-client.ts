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

  // List operator results to get their SIDs
  const operatorResultList = await client.intelligence.v2
    .transcripts(transcriptSid)
    .operatorResults
    .list();

  // Fetch each operator result individually to get full data
  const fullResults = await Promise.all(
    operatorResultList.map(async (summary) => {
      const fullResult = await client.intelligence.v2
        .transcripts(transcriptSid)
        .operatorResults(summary.operatorSid)
        .fetch();

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
