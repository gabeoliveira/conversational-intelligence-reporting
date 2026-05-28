/**
 * Shared helper for writing CIRL's denormalized index records.
 *
 * Each index record gives the conversations API an O(1) lookup from
 * (fieldName, value) → conversationId. Used by:
 * - operator-config primitives marked `surfaceInList: true`
 *   (handoff_reason, primary_topic, subtopic, actual_csat, ...)
 * - hardcoded built-in indexes (customer_phone_last4)
 * - enrichment fields named in CIRL_ENRICHMENT_FILTERABLE_FIELDS
 *   (e.g. interaction_id, crm_ticket)
 *
 * PK: TENANT#{tenantId}#IDX#{fieldName}#{normalizedValue}
 * SK: TS#{timestamp}#CONV#{conversationId}
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

export const INDEX_TTL_DAYS = 180;

export async function writeIndexRecord(
  tenantId: string,
  fieldName: string,
  fieldValue: string,
  conversationId: string,
  timestamp: string
): Promise<void> {
  const normalizedValue = fieldValue.toLowerCase().replace(/\s+/g, '_');
  const ttl = Math.floor(Date.now() / 1000) + INDEX_TTL_DAYS * 86400;

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `TENANT#${tenantId}#IDX#${fieldName}#${normalizedValue}`,
        SK: `TS#${timestamp}#CONV#${conversationId}`,
        tenantId,
        conversationId,
        fieldName,
        fieldValue: normalizedValue,
        entityType: 'INDEX',
        ttl,
      },
    })
  );
}
