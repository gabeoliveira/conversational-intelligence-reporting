import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { writeToS3 } from './s3-writer';
import { emitEvent } from './event-emitter';
import { validateTwilioSignature } from './validate-signature';
import { handleEnrichment } from './enrichment';
import { ensureConfigLoaded, getTenantConfig, type CiVersion } from '@cirl/shared';
import { V2Adapter, isV2TwilioCIWebhook } from './adapters/v2-adapter';
import { V3Adapter, isV3RuleExecutionWebhook } from './adapters/v3-adapter';
import {
  AdapterServerError,
  type IntelligenceAdapter,
  type NormalizedResult,
  type AdapterContext,
} from './adapters/adapter';
import {
  CIWebhookPayload,
  PayloadReceivedEvent,
  DEFAULT_SCHEMA_VERSION,
  HTTP_STATUS,
  CORS_HEADERS,
} from './types';

const adapters: Record<CiVersion, IntelligenceAdapter> = {
  v2: new V2Adapter(),
  v3: new V3Adapter(),
};

// Use CIRL_TENANT_ID from environment, or fall back to 'default'
const DEFAULT_TENANT_ID = process.env.CIRL_TENANT_ID || 'default';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;

  try {
    // Route by API Gateway resource pattern. Webhook keeps its existing
    // /webhook/ci path; enrichment lives at /enrichment when the feature
    // flag is on (the route only exists in API Gateway when enabled).
    // Both are write-side producer endpoints with no tenant in the path —
    // tenant is resolved from CIRL_TENANT_ID at deploy time.
    if (event.resource === '/enrichment') {
      return handleEnrichment(event, requestId);
    }

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

    // Load tenants.json + operator-metrics.json (cached after cold start).
    // Tenants config determines which adapter to use for this tenant.
    await ensureConfigLoaded();

    const tenantId = resolveTenantId(event);

    // Legacy / direct-payload format (top-level conversationId + operatorName)
    // bypasses adapters — for testing and custom integrations.
    if (isLegacyPayload(rawPayload)) {
      return handleLegacyWebhook(rawPayload as unknown as CIWebhookPayload, tenantId, event, requestId);
    }

    return handleViaAdapter(rawPayload, tenantId, event, requestId);

  } catch (error) {
    console.error('Ingest error:', error);
    return response(HTTP_STATUS.INTERNAL_ERROR, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, requestId);
  }
}

function resolveTenantId(event: APIGatewayProxyEvent): string {
  return event.headers['X-Tenant-Id'] || event.headers['x-tenant-id'] || DEFAULT_TENANT_ID;
}

/** Resolve the adapter for this tenant. Tenant config is authoritative;
 * payload shape is only used as a tie-breaker when it conflicts with
 * the tenant's declared version (we log a warning and trust the payload). */
function resolveAdapter(tenantId: string, rawPayload: Record<string, unknown>): IntelligenceAdapter {
  const tenantConfig = getTenantConfig(tenantId);
  const declared: CiVersion = tenantConfig?.ciVersion ?? 'v2';
  const payloadLooksV3 = isV3RuleExecutionWebhook(rawPayload);
  const payloadLooksV2 = isV2TwilioCIWebhook(rawPayload);

  if (declared === 'v3' && payloadLooksV2) {
    console.warn('tenant declares v3 but payload looks v2 — falling back to v2 adapter', { tenantId });
    return adapters.v2;
  }
  if (declared === 'v2' && payloadLooksV3) {
    console.warn('tenant declares v2 but payload looks v3 — falling back to v3 adapter', { tenantId });
    return adapters.v3;
  }
  return adapters[declared];
}

/**
 * Tenant-driven adapter handler. The adapter normalizes the raw webhook
 * into N NormalizedResults; we write each to S3 and emit one EventBridge
 * event per result.
 */
async function handleViaAdapter(
  rawPayload: Record<string, unknown>,
  tenantId: string,
  event: APIGatewayProxyEvent,
  requestId: string
): Promise<APIGatewayProxyResult> {
  const adapter = resolveAdapter(tenantId, rawPayload);
  const receivedAt = new Date().toISOString();
  const ctx: AdapterContext = {
    tenantId,
    requestId,
    receivedAt,
    headers: event.headers as Record<string, string | undefined>,
  };

  let results: NormalizedResult[];
  try {
    results = await adapter.normalize(rawPayload, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Adapter normalization failed';
    if (err instanceof AdapterServerError) {
      console.error(`${adapter.version} adapter server error:`, msg);
      return response(HTTP_STATUS.INTERNAL_ERROR, { error: msg }, requestId);
    }
    console.warn(`${adapter.version} adapter rejected payload:`, msg);
    return response(HTTP_STATUS.BAD_REQUEST, { error: msg }, requestId);
  }

  const stored: Array<{ operatorName: string; s3Uri: string }> = [];
  for (const r of results) {
    const date = receivedAt.split('T')[0];
    const timestamp = receivedAt.replace(/[-:]/g, '').replace('T', '').split('.')[0];
    const s3Key = `${tenantId}/${r.operatorName}/${r.schemaVersion}/${date}/${r.conversationId}-${timestamp}.json`;
    const s3Uri = await writeToS3(s3Key, r.s3Payload as unknown as Record<string, unknown>);

    const eventPayload: PayloadReceivedEvent = {
      tenantId,
      conversationId: r.conversationId,
      operatorName: r.operatorName,
      schemaVersion: r.schemaVersion,
      s3Uri,
      receivedAt,
      ciVersion: r.ciVersion,
      trigger: r.trigger,
      metadata: r.eventMetadata,
    };
    await emitEvent(eventPayload);
    stored.push({ operatorName: r.operatorName, s3Uri });
  }

  console.log('Stored operator results', {
    ciVersion: adapter.version,
    conversationId: results[0]?.conversationId,
    count: stored.length,
  });

  // v2 callers depended on transcriptSid + conversationId in the response;
  // preserve that. v3 carries conversationId only.
  const firstPayload = results[0]?.s3Payload;
  return response(HTTP_STATUS.ACCEPTED, {
    message: 'Payload processed',
    ciVersion: adapter.version,
    conversationId: results[0]?.conversationId,
    ...(firstPayload?.transcriptSid && { transcriptSid: firstPayload.transcriptSid }),
    operatorResults: stored,
  }, requestId);
}

/** Detect legacy/test payloads (top-level conversationId + operatorName). */
function isLegacyPayload(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.conversationId === 'string' &&
    typeof payload.operatorName === 'string'
  );
}

/**
 * Handle legacy/custom webhook format (for testing or custom integrations).
 * Bypasses the v2/v3 adapter selection — the payload is already in our
 * internal CIWebhookPayload shape.
 */
async function handleLegacyWebhook(
  payload: CIWebhookPayload,
  tenantId: string,
  _event: APIGatewayProxyEvent,
  requestId: string
): Promise<APIGatewayProxyResult> {
  // Validate required fields
  if (!payload.conversationId || !payload.operatorName) {
    return response(HTTP_STATUS.BAD_REQUEST, {
      error: 'Missing required fields: conversationId and operatorName are required',
    }, requestId);
  }

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
