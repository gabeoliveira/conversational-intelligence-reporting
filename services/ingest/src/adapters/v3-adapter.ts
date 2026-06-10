/**
 * V3Adapter — parses Twilio Intelligence v3 Rule Execution webhooks.
 *
 * v3 webhooks are self-contained: the full operator result is inline,
 * no REST follow-up needed. A single webhook can carry N operator results
 * (one per operator the rule fires), so normalize() returns an array.
 *
 * Field mapping (v3 webhook → CIRL internal):
 *   conversationId           → conversationId  (opaque conv_conversation_*)
 *   referenceIds[0]          → referenceSids.conversationSid  (CH* — for cross-ref)
 *   operator.displayName     → operatorName
 *   "v" + operator.version   → schemaVersion
 *   result                   → CIWebhookPayload.data
 *   executionDetails.trigger.on   → trigger
 *   executionDetails.channels[0]  → metadata.channel
 *   CUSTOMER participant.profileId → metadata.customerKey
 *   metadata.system          → metadata.executionMetadata
 */

import type {
  IntelligenceAdapter,
  NormalizedResult,
  AdapterContext,
} from './adapter';
import type { IntelligenceTrigger } from '@cirl/shared';
import type { CIWebhookPayload } from '../types';

interface V3Operator {
  id: string;
  displayName: string;
  version: number;
  parameters: Record<string, unknown> | null;
}

interface V3Participant {
  id: string | null;
  profileId: string | null;
  /** Twilio enumerates HUMAN_AGENT/CUSTOMER/AI_AGENT but UNKNOWN appears in real payloads. */
  type: string | null;
}

interface V3ExecutionDetails {
  trigger?: { on?: string; timestamp?: string };
  communications?: { first: string | null; last: string | null };
  channels?: string[];
  participants?: V3Participant[];
  resolvedContext?: {
    memory: { profileId: string; memoryStoreId: string } | null;
    knowledge: { sources: Array<{ baseId: string; sourceId: string }> } | null;
  };
}

interface V3OperatorResult {
  id: string;
  operator: V3Operator;
  outputFormat: 'TEXT' | 'JSON' | 'CLASSIFICATION';
  result: unknown;
  dateCreated: string;
  referenceIds: string[];
  executionDetails: V3ExecutionDetails;
  metadata?: { system?: Record<string, unknown> };
}

interface V3RuleExecutionWebhook {
  accountId: string;
  conversationId: string;
  intelligenceConfiguration: {
    id: string;
    displayName: string;
    version: number;
    ruleId: string;
  };
  operatorResults: V3OperatorResult[];
}

const VALID_TRIGGERS: ReadonlySet<string> = new Set([
  'COMMUNICATION',
  'CONVERSATION_INACTIVE',
  'CONVERSATION_END',
]);

/**
 * Type guard — used by the ingest handler when picking between adapters
 * based on payload shape rather than tenant config (e.g. for test payloads).
 */
export function isV3RuleExecutionWebhook(raw: Record<string, unknown>): boolean {
  return (
    typeof raw.conversationId === 'string' &&
    typeof raw.accountId === 'string' &&
    Array.isArray(raw.operatorResults) &&
    typeof raw.intelligenceConfiguration === 'object' &&
    raw.intelligenceConfiguration !== null
  );
}

export class V3Adapter implements IntelligenceAdapter {
  readonly version = 'v3' as const;

  async normalize(
    rawBody: Record<string, unknown>,
    ctx: AdapterContext
  ): Promise<NormalizedResult[]> {
    if (!isV3RuleExecutionWebhook(rawBody)) {
      throw new Error('Payload does not match v3 Rule Execution webhook shape');
    }
    const webhook = rawBody as unknown as V3RuleExecutionWebhook;
    const { conversationId, intelligenceConfiguration, operatorResults } = webhook;

    if (operatorResults.length === 0) {
      console.warn('v3 webhook contained no operatorResults', {
        conversationId,
        ruleId: intelligenceConfiguration.ruleId,
      });
      return [];
    }

    return operatorResults.map((r) => normalizeOne(r, webhook, ctx));
  }
}

function normalizeOne(
  result: V3OperatorResult,
  webhook: V3RuleExecutionWebhook,
  ctx: AdapterContext
): NormalizedResult {
  const trigger = parseTrigger(result.executionDetails?.trigger?.on);
  const operatorName = result.operator.displayName;
  const schemaVersion = `v${result.operator.version}`;

  // Twilio Conversations SID (CH*) — present for chat/WhatsApp/SMS flows,
  // absent for voice. Used as the cross-reference key to the Conversations API.
  const conversationSid =
    result.referenceIds.find((id) => id.startsWith('CH')) ?? null;

  const customer = (result.executionDetails?.participants ?? []).find(
    (p) => p.type === 'CUSTOMER'
  );

  const channel = result.executionDetails?.channels?.[0]?.toLowerCase() ?? null;

  // result.result shape depends on outputFormat:
  //   JSON           → object  (passed through)
  //   CLASSIFICATION → { label: string }
  //   TEXT           → string (wrapped so downstream consumers always see an object)
  const data = wrapResult(result.outputFormat, result.result);

  const s3Payload: CIWebhookPayload = {
    ciVersion: 'v3',
    conversationId: webhook.conversationId,
    operatorName,
    schemaVersion,
    timestamp: result.dateCreated,
    trigger,
    data,
    metadata: {
      ...(customer?.profileId && { customerKey: customer.profileId }),
      ...(channel && { channel }),
      referenceSids: {
        ...(conversationSid && { conversationSid }),
      },
      ruleId: webhook.intelligenceConfiguration.ruleId,
      intelligenceConfigurationId: webhook.intelligenceConfiguration.id,
      operatorResultId: result.id,
      operatorId: result.operator.id,
      outputFormat: result.outputFormat,
      executionDetails: result.executionDetails,
      ...(result.metadata?.system && { executionMetadata: result.metadata.system }),
    },
    _meta: {
      tenantId: ctx.tenantId,
      receivedAt: ctx.receivedAt,
      requestId: ctx.requestId,
    },
  };

  return {
    ciVersion: 'v3',
    conversationId: webhook.conversationId,
    operatorName,
    schemaVersion,
    trigger,
    timestamp: result.dateCreated,
    s3Payload,
    eventMetadata: {
      ...(customer?.profileId && { customerKey: customer.profileId }),
      ...(channel && { channel }),
      ...(conversationSid && { conversationSid }),
      ruleId: webhook.intelligenceConfiguration.ruleId,
    },
  };
}

function parseTrigger(value: unknown): IntelligenceTrigger | null {
  if (typeof value === 'string' && VALID_TRIGGERS.has(value)) {
    return value as IntelligenceTrigger;
  }
  return null;
}

function wrapResult(outputFormat: string, result: unknown): Record<string, unknown> {
  if (outputFormat === 'TEXT') {
    // Wrap so downstream code always works with an object.
    return { text: typeof result === 'string' ? result : String(result ?? '') };
  }
  // JSON and CLASSIFICATION both come through as objects already.
  if (result && typeof result === 'object') {
    return result as Record<string, unknown>;
  }
  // Defensive — wrap primitives so we never lose data.
  return { value: result };
}
