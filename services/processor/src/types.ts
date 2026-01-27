// Re-export from shared package
// For Lambda bundling, we inline the types

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
