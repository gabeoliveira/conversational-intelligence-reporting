/**
 * IntelligenceAdapter — version-specific normalization layer.
 *
 * Each adapter consumes the raw webhook body from one Twilio Conversational
 * Intelligence version (v2 transcript-notification or v3 rule-execution)
 * and emits one or more NormalizedResults. The ingest handler stays
 * version-agnostic: it picks the adapter from the tenant's config, calls
 * normalize(), and writes each result to S3 + emits an EventBridge event.
 */

import type { CiVersion, IntelligenceTrigger } from '@cirl/shared';
import type { CIWebhookPayload, PayloadReceivedEvent } from '../types';

export type { CiVersion, IntelligenceTrigger };

/**
 * One operator result, ready to write to S3 and emit. A single v2 webhook
 * produces N (one per operator on the transcript). A single v3 rule-execution
 * webhook also produces N (one per entry in operatorResults[]).
 */
export interface NormalizedResult {
  /** Adapter version that produced this result. Stored on both S3 + event. */
  ciVersion: CiVersion;
  /** Internal conversationId — v2 transcript SID or v3 conv_conversation_*. */
  conversationId: string;
  /** Operator display name; matches operator-metrics.json `operatorName`. */
  operatorName: string;
  /** Schema version string (v2 uses 'v1'; v3 uses 'v' + operator.version). */
  schemaVersion: string;
  /** v3 rule trigger; null for v2. */
  trigger: IntelligenceTrigger | null;
  /** ISO 8601 timestamp this result was created (Twilio-side). */
  timestamp: string;
  /** Payload to write to S3. */
  s3Payload: CIWebhookPayload;
  /** EventBridge event metadata (passed through to the processor). */
  eventMetadata?: PayloadReceivedEvent['metadata'];
}

/** Tenant + request context passed to every adapter invocation. */
export interface AdapterContext {
  tenantId: string;
  requestId: string;
  receivedAt: string;
  /** Raw request headers — adapters that need bodySHA256 / signature data read from here. */
  headers: Record<string, string | undefined>;
}

export interface IntelligenceAdapter {
  readonly version: CiVersion;
  /**
   * Normalize a raw webhook body into one or more results. Throws on
   * malformed payloads (caught as 400) or server-misconfiguration
   * (AdapterServerError → 500).
   */
  normalize(rawBody: Record<string, unknown>, ctx: AdapterContext): Promise<NormalizedResult[]>;
}

/** Adapter-side error indicating server misconfiguration (missing creds,
 * unreachable upstream, etc.). The handler maps this to 500 instead of 400. */
export class AdapterServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterServerError';
  }
}
