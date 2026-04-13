import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { writeToS3 } from './s3-writer';
import { emitEvent } from './event-emitter';
import { validateTwilioSignature } from './validate-signature';
import { fetchOperatorResults, fetchTranscript, fetchSentences, computeTimingMetrics } from './twilio-client';
import {
  TwilioCIWebhookPayload,
  CIWebhookPayload,
  PayloadReceivedEvent,
  DEFAULT_SCHEMA_VERSION,
  HTTP_STATUS,
  CORS_HEADERS,
} from './types';

// Use CIRL_TENANT_ID from environment, or fall back to 'default'
const DEFAULT_TENANT_ID = process.env.CIRL_TENANT_ID || 'default';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;

  try {
    // Parse and validate payload
    if (!event.body) {
      return response(HTTP_STATUS.BAD_REQUEST, { error: 'Missing request body' }, requestId);
    }

    // Validate Twilio signature (unless explicitly skipped)
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const skipValidation = process.env.SKIP_SIGNATURE_VALIDATION === 'true';

    if (authToken && !skipValidation) {
      const signature = event.headers['X-Twilio-Signature'] || event.headers['x-twilio-signature'];
      const webhookUrl = buildWebhookUrl(event);
      const expectedBodyHash = event.queryStringParameters?.bodySHA256;

      if (!signature || !validateTwilioSignature(authToken, signature, webhookUrl, event.body, expectedBodyHash)) {
        console.warn('Signature validation failed');
        return response(HTTP_STATUS.UNAUTHORIZED, { error: 'Invalid signature' }, requestId);
      }
    }

    let rawPayload: Record<string, unknown>;
    try {
      rawPayload = JSON.parse(event.body);
    } catch {
      return response(HTTP_STATUS.BAD_REQUEST, { error: 'Invalid JSON payload' }, requestId);
    }

    // Detect payload type: Twilio CI webhook vs legacy/custom format
    if (isTwilioCIWebhook(rawPayload)) {
      return handleTwilioCIWebhook(rawPayload as unknown as TwilioCIWebhookPayload, event, requestId);
    } else {
      return handleLegacyWebhook(rawPayload as unknown as CIWebhookPayload, event, requestId);
    }

  } catch (error) {
    console.error('Ingest error:', error);
    return response(HTTP_STATUS.INTERNAL_ERROR, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, requestId);
  }
}

/**
 * Check if payload is a Twilio CI webhook notification
 */
function isTwilioCIWebhook(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.transcript_sid === 'string' &&
    payload.event_type === 'voice_intelligence_transcript_available'
  );
}

/**
 * Handle real Twilio CI webhook - fetch operator results from Twilio API
 */
async function handleTwilioCIWebhook(
  payload: TwilioCIWebhookPayload,
  event: APIGatewayProxyEvent,
  requestId: string
): Promise<APIGatewayProxyResult> {
  const { transcript_sid, customer_key, service_sid } = payload;

  console.log('Processing Twilio CI webhook', { transcript_sid, customer_key, service_sid });

  // Validate Twilio credentials are configured
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
    return response(HTTP_STATUS.INTERNAL_ERROR, {
      error: 'Server configuration error: Twilio credentials not configured',
    }, requestId);
  }

  // Fetch transcript details, operator results, and sentences from Twilio
  const [transcript, operatorResults, sentences] = await Promise.all([
    fetchTranscript(transcript_sid),
    fetchOperatorResults(transcript_sid),
    fetchSentences(transcript_sid),
  ]);

  // Compute timing metrics from sentence-level timestamps
  const timingMetrics = computeTimingMetrics(sentences);

  console.log('Fetched from Twilio', {
    transcriptSid: transcript.sid,
    operatorCount: operatorResults.length,
    operators: operatorResults.map((r) => r.name),
    sentenceCount: sentences.length,
    timingMetrics,
  });

  // Extract tenant ID from header or use default
  const tenantId = event.headers['X-Tenant-Id'] || event.headers['x-tenant-id'] || DEFAULT_TENANT_ID;
  const receivedAt = new Date().toISOString();
  const date = receivedAt.split('T')[0];
  const timestamp = receivedAt.replace(/[-:]/g, '').replace('T', '').split('.')[0];

  // Use transcript_sid as conversationId, or customer_key if provided
  const conversationId = customer_key || transcript_sid;

  // Store each operator result
  const storedResults: Array<{ operatorName: string; s3Uri: string }> = [];

  for (const result of operatorResults) {
    const operatorName = result.name;
    const s3Key = `${tenantId}/${operatorName}/${DEFAULT_SCHEMA_VERSION}/${date}/${conversationId}-${timestamp}.json`;

    const s3Uri = await writeToS3(s3Key, {
      conversationId,
      transcriptSid: transcript_sid,
      operatorName,
      operatorSid: result.operator_sid,
      operatorType: result.operator_type,
      schemaVersion: DEFAULT_SCHEMA_VERSION,
      data: result,
      metadata: {
        customerKey: customer_key,
        serviceSid: service_sid,
        channel: transcript.channel,
        transcriptCreatedAt: transcript.dateCreated.toISOString(),
      },
      timingMetrics: timingMetrics || undefined,
      _meta: {
        tenantId,
        receivedAt,
        requestId,
      },
    });

    // Emit event for async processing
    const eventPayload: PayloadReceivedEvent = {
      tenantId,
      conversationId,
      operatorName,
      schemaVersion: DEFAULT_SCHEMA_VERSION,
      s3Uri,
      receivedAt,
      metadata: {
        transcriptSid: transcript_sid,
        customerKey: customer_key,
        serviceSid: service_sid,
        channel: transcript.channel,
        ...(timingMetrics && { timingMetrics }),
      },
    };

    await emitEvent(eventPayload);
    storedResults.push({ operatorName, s3Uri });
  }

  console.log('Stored operator results', { conversationId, count: storedResults.length });

  return response(HTTP_STATUS.ACCEPTED, {
    message: 'Transcript processed',
    transcriptSid: transcript_sid,
    conversationId,
    operatorResults: storedResults,
  }, requestId);
}

/**
 * Handle legacy/custom webhook format (for testing or custom integrations)
 */
async function handleLegacyWebhook(
  payload: CIWebhookPayload,
  event: APIGatewayProxyEvent,
  requestId: string
): Promise<APIGatewayProxyResult> {
  // Validate required fields
  if (!payload.conversationId || !payload.operatorName) {
    return response(HTTP_STATUS.BAD_REQUEST, {
      error: 'Missing required fields: conversationId and operatorName are required',
    }, requestId);
  }

  // Extract tenant ID from header or use default
  const tenantId = event.headers['X-Tenant-Id'] || event.headers['x-tenant-id'] || DEFAULT_TENANT_ID;
  const schemaVersion = payload.schemaVersion || DEFAULT_SCHEMA_VERSION;
  const receivedAt = new Date().toISOString();

  // Build S3 key: tenant/operator/version/date/conversationId-timestamp.json
  const date = receivedAt.split('T')[0];
  const timestamp = receivedAt.replace(/[-:]/g, '').replace('T', '').split('.')[0];
  const s3Key = `${tenantId}/${payload.operatorName}/${schemaVersion}/${date}/${payload.conversationId}-${timestamp}.json`;

  // Write raw payload to S3
  const s3Uri = await writeToS3(s3Key, {
    ...payload,
    _meta: {
      tenantId,
      receivedAt,
      requestId,
    },
  });

  // Emit event for async processing
  const eventPayload: PayloadReceivedEvent = {
    tenantId,
    conversationId: payload.conversationId,
    operatorName: payload.operatorName,
    schemaVersion,
    s3Uri,
    receivedAt,
    metadata: payload.metadata,
  };

  await emitEvent(eventPayload);

  // Return 202 Accepted immediately
  return response(HTTP_STATUS.ACCEPTED, {
    message: 'Payload received',
    conversationId: payload.conversationId,
    operatorName: payload.operatorName,
    s3Uri,
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
    body: JSON.stringify({
      ...body,
      requestId,
    }),
  };
}

/**
 * Reconstructs the full webhook URL from API Gateway event.
 * This URL must match exactly what Twilio sends to for signature validation.
 */
function buildWebhookUrl(event: APIGatewayProxyEvent): string {
  const protocol = event.headers['X-Forwarded-Proto'] || event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers['Host'] || event.headers['host'] || '';
  const path = event.path;
  const stage = event.requestContext.stage;

  // Include stage in the path - API Gateway REST API separates stage from path
  return `${protocol}://${host}/${stage}${path}`;
}
