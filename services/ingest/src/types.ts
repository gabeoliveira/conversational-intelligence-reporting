// Re-export from shared package
// In production, this would import from @cirl/shared
// For Lambda bundling, we inline the types

/**
 * Twilio CI Webhook payload - notification that transcript is ready
 * The actual operator results must be fetched via Twilio API
 */
export interface TwilioCIWebhookPayload {
  account_sid: string;
  service_sid: string;
  transcript_sid: string;
  customer_key?: string;
  event_type: 'voice_intelligence_transcript_available';
  encryption_credential_sid?: string;
}

/**
 * Twilio Operator Result from /v2/Transcripts/{sid}/OperatorResults
 */
export interface TwilioOperatorResult {
  operator_sid: string;
  operator_type: string;
  name: string;
  text_generation_results?: {
    result: string;
  };
  text_extraction_results?: Array<{
    key: string;
    value: string;
  }>;
  text_classification_results?: {
    prediction: string;
    predicted_probability: number;
  };
  label_probabilities?: Array<{
    label: string;
    probability: number;
  }>;
  extract_results?: Array<{
    entity: string;
    value: string;
  }>;
  [key: string]: unknown;
}

/**
 * Response from Twilio API /v2/Transcripts/{sid}/OperatorResults
 */
export interface TwilioOperatorResultsResponse {
  operator_results: TwilioOperatorResult[];
  meta: {
    page: number;
    page_size: number;
    first_page_url: string;
    previous_page_url?: string;
    next_page_url?: string;
    url: string;
    key: string;
  };
}

/**
 * Legacy/custom webhook payload format (for testing or custom integrations)
 */
export interface CIWebhookPayload {
  conversationId: string;
  operatorName: string;
  schemaVersion?: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata?: {
    customerKey?: string;
    channel?: string;
    agentId?: string;
    teamId?: string;
    queueId?: string;
    [key: string]: unknown;
  };
}

export interface PayloadReceivedEvent {
  tenantId: string;
  conversationId: string;
  operatorName: string;
  schemaVersion: string;
  s3Uri: string;
  receivedAt: string;
  metadata?: Record<string, unknown>;
}

export const DEFAULT_TENANT_ID = 'default';
export const DEFAULT_SCHEMA_VERSION = 'v1';

export const EVENT_SOURCE = 'cirl.ingest';
export const EVENT_DETAIL_TYPE_PAYLOAD_RECEIVED = 'PayloadReceived';

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
} as const;

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Twilio-Signature',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};
