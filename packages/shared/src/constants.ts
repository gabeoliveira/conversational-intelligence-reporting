/**
 * Shared constants
 */

export const EVENT_SOURCE = 'cirl.ingest';
export const EVENT_DETAIL_TYPE_PAYLOAD_RECEIVED = 'PayloadReceived';

export const DEFAULT_TENANT_ID = 'default';
export const DEFAULT_SCHEMA_VERSION = 'v1';

export const ENTITY_TYPES = {
  CONVERSATION: 'CONVERSATION',
  OPERATOR_RESULT: 'OPERATOR_RESULT',
  AGGREGATE: 'AGGREGATE',
  SCHEMA: 'SCHEMA',
  VIEW: 'VIEW',
} as const;

export const METRIC_NAMES = {
  CONVERSATION_COUNT: 'conversation_count',
  SENTIMENT_AVG: 'sentiment_avg',
  SENTIMENT_POSITIVE: 'sentiment_positive',
  SENTIMENT_NEGATIVE: 'sentiment_negative',
  SENTIMENT_NEUTRAL: 'sentiment_neutral',
} as const;

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
