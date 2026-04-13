import type { EventBridgeEvent } from 'aws-lambda';
import { getPayloadFromS3 } from './storage/s3';
import { writeConversation, writeOperatorResult, updateAggregates, updateTimingAggregates } from './storage/dynamo';
import { enrich } from './enrich/enrich';
import { validatePayload } from './schema/validate';
import type { PayloadReceivedEvent, CIWebhookPayload } from './types';

export async function handler(
  event: EventBridgeEvent<'PayloadReceived', PayloadReceivedEvent>
): Promise<void> {
  const { detail } = event;
  const {
    tenantId,
    conversationId,
    operatorName,
    schemaVersion,
    s3Uri,
    receivedAt,
    metadata,
  } = detail;

  console.log(`Processing: tenant=${tenantId}, conversation=${conversationId}, operator=${operatorName}`);

  try {
    // 1. Fetch raw payload from S3
    const rawPayload = await getPayloadFromS3(s3Uri) as unknown as Record<string, unknown>;

    // 2. Extract actual results based on operator type
    // For Twilio CI webhooks: operatorType is at top level, data contains the operator result
    // For legacy format: data contains the actual payload directly
    const operatorType = rawPayload.operatorType as string | undefined;
    const operatorData = (rawPayload.data || rawPayload) as Record<string, unknown>;
    const extractedResults = extractOperatorResults(operatorType, operatorData);

    // 3. Validate against schema (if schema exists)
    const validationResult = await validatePayload(tenantId, operatorName, schemaVersion, extractedResults);
    if (!validationResult.valid) {
      console.warn(`Schema validation failed for ${operatorName}:`, validationResult.errors);
      // Continue processing - we log but don't block
    }

    // 4. Run enrichment hook
    let enrichedPayload = extractedResults;
    let enrichmentError: string | undefined;
    let enrichedAt: string | undefined;

    try {
      const enrichmentResult = await enrich({
        tenantId,
        conversationId,
        operatorName,
        rawPayload: extractedResults,
      });
      enrichedPayload = enrichmentResult.enrichedPayload;
      enrichedAt = new Date().toISOString();
    } catch (error) {
      console.error('Enrichment failed:', error);
      enrichmentError = error instanceof Error ? error.message : 'Unknown enrichment error';
      // Continue with extracted results
    }

    // 5. Extract display fields (top-level scalar values for list views)
    const displayFields = extractDisplayFields(enrichedPayload);

    // 6. Write/update conversation header
    await writeConversation({
      tenantId,
      conversationId,
      metadata: metadata || {},
      receivedAt,
    });

    // 7. Write operator result
    await writeOperatorResult({
      tenantId,
      conversationId,
      operatorName,
      schemaVersion,
      s3Uri,
      displayFields,
      enrichedPayload,
      enrichedAt,
      enrichmentError,
      receivedAt,
    });

    // 8. Update aggregates (operator metrics + timing metrics if available)
    await updateAggregates({
      tenantId,
      conversationId,
      operatorName,
      payload: enrichedPayload,
      receivedAt,
    });

    // 9. Update timing metrics (from transcript sentences, if present)
    const timingMetrics = (metadata as Record<string, unknown>)?.timingMetrics as
      Record<string, number> | undefined;
    if (timingMetrics) {
      await updateTimingAggregates({
        tenantId,
        timingMetrics,
        receivedAt,
      });
    }

    console.log(`Successfully processed: ${conversationId}/${operatorName}`);

  } catch (error) {
    console.error('Processing error:', error);
    throw error; // Let Lambda retry via EventBridge
  }
}

/**
 * Extract the actual operator results based on operator type.
 * Flattens the nested result structure to make data more accessible.
 */
function extractOperatorResults(
  operatorType: string | undefined,
  data: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!data) {
    return {};
  }

  // Map operator types to their result fields
  const resultFieldMap: Record<string, string> = {
    'json': 'json_results',
    'text-generation': 'text_generation_results',
    'extract': 'extract_results',
    'extract-normalize': 'normalized_results',
    'pii-extract': 'extract_results',
    'conversation-classify': 'label_probabilities',
    'utterance-classify': 'utterance_results',
  };

  const resultField = operatorType ? resultFieldMap[operatorType] : undefined;

  if (resultField && data[resultField]) {
    const results = data[resultField];

    // If results is an object, spread it; otherwise wrap in a results key
    if (typeof results === 'object' && results !== null && !Array.isArray(results)) {
      return {
        ...results as Record<string, unknown>,
        _operator_type: operatorType,
        _operator_name: data.name,
      };
    } else {
      return {
        results,
        _operator_type: operatorType,
        _operator_name: data.name,
      };
    }
  }

  // Fallback: return the full data object with metadata stripped
  const { operator_sid, operator_type, name, ...rest } = data;
  return {
    ...rest,
    _operator_type: operatorType || operator_type,
    _operator_name: name,
  };
}

/**
 * Extract scalar values from payload for list view display
 */
function extractDisplayFields(payload: Record<string, unknown>): Record<string, unknown> {
  const displayFields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    // Include primitives and small arrays (skip internal fields)
    if (key.startsWith('_')) continue;

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (Array.isArray(value) && value.length <= 5 && value.every(v => typeof v === 'string'))
    ) {
      displayFields[key] = value;
    }
  }

  return displayFields;
}
