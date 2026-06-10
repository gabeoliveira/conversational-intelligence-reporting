// Re-export from shared package
// For Lambda bundling, we inline the types

/** Conversational Intelligence version this payload was emitted by. */
export type CiVersion = 'v2' | 'v3';

/** v3 rule trigger; null/absent for v2. */
export type IntelligenceTrigger =
  | 'COMMUNICATION'
  | 'CONVERSATION_INACTIVE'
  | 'CONVERSATION_END';

export interface CIWebhookPayload {
  /** Adapter version that produced this normalized payload. Default 'v2' for legacy records. */
  ciVersion?: CiVersion;
  conversationId: string;
  operatorName: string;
  schemaVersion?: string;
  timestamp: string;
  /** v3 only — rule trigger that fired this execution. */
  trigger?: IntelligenceTrigger | null;
  data: Record<string, unknown>;
  metadata?: {
    customerKey?: string;
    channel?: string;
    agentId?: string;
    teamId?: string;
    queueId?: string;
    [key: string]: unknown;
  };
  _meta?: {
    tenantId: string;
    receivedAt: string;
    requestId: string;
  };
}

export interface PayloadReceivedEvent {
  tenantId: string;
  conversationId: string;
  operatorName: string;
  schemaVersion: string;
  s3Uri: string;
  receivedAt: string;
  /** Adapter version. Absent in legacy records — treat as 'v2'. */
  ciVersion?: CiVersion;
  /** v3 rule trigger that fired this execution. */
  trigger?: IntelligenceTrigger | null;
  metadata?: Record<string, unknown>;
}

export interface EnrichmentContext {
  tenantId: string;
  conversationId: string;
  operatorName: string;
  rawPayload: Record<string, unknown>;
}

export interface EnrichmentResult {
  enrichedPayload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ConversationHeader {
  conversationId: string;
  tenantId: string;
  customerKey?: string;
  channel: string;
  agentId?: string;
  teamId?: string;
  queueId?: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  operatorCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OperatorResult {
  conversationId: string;
  tenantId: string;
  operatorName: string;
  schemaVersion: string;
  s3Uri: string;
  displayFields: Record<string, unknown>;
  normalized?: Record<string, unknown>;
  enrichedAt?: string;
  enrichmentError?: string;
  receivedAt: string;
}
