/**
 * V2Adapter — handles classic Twilio Voice Intelligence transcript webhooks.
 *
 * v2 webhooks are notifications only — they carry { transcript_sid, event_type,
 * customer_key?, service_sid? } and we have to REST-fetch the transcript,
 * operator results, and sentences from Twilio before we have the actual data.
 * normalize() emits one NormalizedResult per operator result on the transcript.
 *
 * This is a refactor of the existing handleTwilioCIWebhook() flow — same
 * fetch behavior, same S3 + EventBridge shape, packaged behind the
 * IntelligenceAdapter interface so handler.ts can pick it by tenant config.
 */

import {
  AdapterServerError,
  type IntelligenceAdapter,
  type NormalizedResult,
  type AdapterContext,
} from './adapter';
import type { CIWebhookPayload } from '../types';
import {
  fetchOperatorResults,
  fetchTranscript,
  fetchSentences,
  computeTimingMetrics,
} from '../twilio-client';

const DEFAULT_SCHEMA_VERSION = 'v1';

interface V2TwilioCIWebhook {
  transcript_sid: string;
  event_type: 'voice_intelligence_transcript_available' | string;
  customer_key?: string;
  service_sid?: string;
}

/** Type guard — matches the legacy isTwilioCIWebhook() detector. */
export function isV2TwilioCIWebhook(raw: Record<string, unknown>): boolean {
  return (
    typeof raw.transcript_sid === 'string' &&
    raw.event_type === 'voice_intelligence_transcript_available'
  );
}

export class V2Adapter implements IntelligenceAdapter {
  readonly version = 'v2' as const;

  async normalize(
    rawBody: Record<string, unknown>,
    ctx: AdapterContext
  ): Promise<NormalizedResult[]> {
    if (!isV2TwilioCIWebhook(rawBody)) {
      throw new Error('Payload does not match v2 Twilio CI webhook shape');
    }
    const webhook = rawBody as unknown as V2TwilioCIWebhook;
    const { transcript_sid, customer_key, service_sid } = webhook;

    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new AdapterServerError('Server configuration error: Twilio credentials not configured');
    }

    const [transcript, operatorResults, sentences] = await Promise.all([
      fetchTranscript(transcript_sid),
      fetchOperatorResults(transcript_sid),
      fetchSentences(transcript_sid),
    ]);

    const timingMetrics = computeTimingMetrics(sentences);
    const conversationId = customer_key || transcript_sid;

    return operatorResults.map((result) => {
      const operatorName = result.name;
      // Field placement preserves the pre-adapter legacy shape so downstream
      // consumers (S3 archive readers, conversations enrichment) keep working
      // without migration: transcriptSid / operatorSid / operatorType /
      // timingMetrics at the top level, channel object inside metadata.
      const s3Payload: CIWebhookPayload = {
        ciVersion: 'v2',
        conversationId,
        transcriptSid: transcript_sid,
        operatorName,
        operatorSid: result.operator_sid,
        operatorType: result.operator_type,
        schemaVersion: DEFAULT_SCHEMA_VERSION,
        timestamp: transcript.dateCreated.toISOString(),
        trigger: null, // v2 has no per-rule trigger
        data: result as unknown as Record<string, unknown>,
        metadata: {
          ...(customer_key && { customerKey: customer_key }),
          ...(service_sid && { serviceSid: service_sid }),
          channel: transcript.channel as unknown as string,
          transcriptCreatedAt: transcript.dateCreated.toISOString(),
        },
        ...(timingMetrics && { timingMetrics: timingMetrics as unknown as Record<string, unknown> }),
        _meta: {
          tenantId: ctx.tenantId,
          receivedAt: ctx.receivedAt,
          requestId: ctx.requestId,
        },
      };

      return {
        ciVersion: 'v2' as const,
        conversationId,
        operatorName,
        schemaVersion: DEFAULT_SCHEMA_VERSION,
        trigger: null,
        timestamp: transcript.dateCreated.toISOString(),
        s3Payload,
        eventMetadata: {
          transcriptSid: transcript_sid,
          ...(customer_key && { customerKey: customer_key }),
          ...(service_sid && { serviceSid: service_sid }),
          channel: transcript.channel,
          ...(timingMetrics && { timingMetrics }),
        },
      };
    });
  }
}
