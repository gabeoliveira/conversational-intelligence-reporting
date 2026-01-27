/**
 * Core types for Conversational Intelligence Reporting Layer
 */

// Conversation header stored in DynamoDB
export interface ConversationHeader {
  conversationId: string;
  tenantId: string;
  customerKey?: string;
  channel: string;
  agentId?: string;
  teamId?: string;
  queueId?: string;
  startedAt: string; // ISO 8601
  endedAt?: string;
  summary?: string;
  operatorCount: number;
  createdAt: string;
  updatedAt: string;
}

// Operator result stored in DynamoDB (index record)
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

// Aggregate metric stored in DynamoDB
export interface AggregateMetric {
  tenantId: string;
  date: string; // YYYYMMDD
  metricName: string;
  value: number;
  dimensions?: Record<string, string>;
}

// Schema registry entry
export interface SchemaEntry {
  tenantId: string;
  operatorName: string;
  schemaVersion: string;
  jsonSchema: object;
  status: 'active' | 'deprecated';
  createdAt: string;
  createdBy?: string;
}

// View config for UI rendering
export interface ViewConfig {
  tenantId: string;
  operatorName: string;
  schemaVersion: string;
  display: {
    title: string;
    icon?: string;
  };
  table?: {
    columns: ColumnConfig[];
  };
  detail?: {
    sections: SectionConfig[];
  };
  charts?: ChartConfig[];
}

export interface ColumnConfig {
  field: string;
  label: string;
  type: 'string' | 'number' | 'badge' | 'date' | 'array';
  format?: string;
  sortable?: boolean;
}

export interface SectionConfig {
  title: string;
  fields?: string[];
  field?: string;
  type?: 'key-value' | 'tag-list' | 'key-value-table' | 'json';
}

export interface ChartConfig {
  type: 'pie' | 'bar' | 'line' | 'area';
  field: string;
  title: string;
  groupBy?: string;
}

// Webhook payload from CI
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

// EventBridge event for async processing
export interface PayloadReceivedEvent {
  tenantId: string;
  conversationId: string;
  operatorName: string;
  schemaVersion: string;
  s3Uri: string;
  receivedAt: string;
  metadata?: Record<string, unknown>;
}

// Enrichment hook types
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

// API response types
export interface ConversationListResponse {
  items: ConversationHeader[];
  nextToken?: string;
  total?: number;
}

export interface ConversationDetailResponse {
  conversation: ConversationHeader;
  operators: OperatorResult[];
}

export interface MetricsResponse {
  metrics: AggregateMetric[];
  period: {
    from: string;
    to: string;
  };
}

// Auth types
export type Role = 'ci_viewer' | 'ci_analyst' | 'ci_admin';

export interface AuthClaims {
  tenantId: string;
  roles: Role[];
  teams?: string[];
  queues?: string[];
  sub: string;
  iat: number;
  exp: number;
}

// API error response
export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
  requestId?: string;
}
