import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { HTTP_STATUS, CORS_HEADERS } from './types';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;
const DEFAULT_TENANT_ID = process.env.CIRL_TENANT_ID || 'default';

const ENRICHMENT_TTL_DAYS = 90;

export interface EnrichmentRequest {
  callSid?: string;
  conversationSid?: string;
  fields: Record<string, unknown>;
  source?: string;
}

/**
 * POST /enrichment
 *
 * Generic enrichment endpoint. Any upstream system (Twilio Studio, customer
 * backend, dispatcher, CRM webhook) can post arbitrary metadata tied to a
 * Twilio callSid or conversationSid. The fields are stored in an ENRICHMENT
 * record keyed by the correlation SID, and merged into conversation responses
 * at both write time (when the processor builds the spine) and read time (in
 * the conversations API). Two-stage merge handles arrival order races.
 *
 * Tenant is resolved from the CIRL_TENANT_ID env var (single-tenant per
 * deployment), with an X-Tenant-Id header override for testing. Same pattern
 * as the /webhook/ci route.
 *
 * See docs/enrichment.md for the full design and rationale.
 */
export async function handleEnrichment(
  event: APIGatewayProxyEvent,
  requestId: string
): Promise<APIGatewayProxyResult> {
  if (process.env.CIRL_ENRICHMENT_ENABLED !== 'true') {
    return response(HTTP_STATUS.NOT_FOUND, { error: 'Enrichment not enabled' }, requestId);
  }

  const tenantId =
    event.headers?.['X-Tenant-Id'] ||
    event.headers?.['x-tenant-id'] ||
    DEFAULT_TENANT_ID;

  if (!event.body) {
    return response(HTTP_STATUS.BAD_REQUEST, { error: 'Missing request body' }, requestId);
  }

  let body: EnrichmentRequest;
  try {
    body = JSON.parse(event.body) as EnrichmentRequest;
  } catch {
    return response(HTTP_STATUS.BAD_REQUEST, { error: 'Invalid JSON payload' }, requestId);
  }

  // At least one correlation key must be provided. callSid is the typical
  // voice-channel key; conversationSid is the equivalent for messaging.
  const callSid = typeof body.callSid === 'string' ? body.callSid.trim() : '';
  const conversationSid = typeof body.conversationSid === 'string' ? body.conversationSid.trim() : '';
  if (!callSid && !conversationSid) {
    return response(HTTP_STATUS.BAD_REQUEST, {
      error: 'Must provide callSid or conversationSid as correlation key',
    }, requestId);
  }

  if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)) {
    return response(HTTP_STATUS.BAD_REQUEST, {
      error: 'fields must be an object of key/value metadata to attach',
    }, requestId);
  }

  const correlationKey = callSid || conversationSid;
  const correlationType = callSid ? 'CALL' : 'CONV';
  const receivedAt = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + ENRICHMENT_TTL_DAYS * 86400;

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TENANT#${tenantId}#ENRICHMENT#${correlationType}#${correlationKey}`,
      SK: 'META',
      entityType: 'ENRICHMENT',
      tenantId,
      correlationType,
      correlationKey,
      callSid: callSid || null,
      conversationSid: conversationSid || null,
      fields: body.fields,
      source: typeof body.source === 'string' ? body.source : 'unknown',
      receivedAt,
      ttl,
    },
  }));

  return response(HTTP_STATUS.ACCEPTED, {
    message: 'Enrichment stored',
    correlationType,
    correlationKey,
  }, requestId);
}

function response(
  statusCode: number,
  body: Record<string, unknown>,
  requestId: string
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...body, requestId }),
  };
}
