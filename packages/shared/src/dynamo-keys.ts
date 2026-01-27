/**
 * DynamoDB key generation utilities for single-table design
 */

// Primary key builders
export const keys = {
  // Conversation header: TENANT#{tenantId}#CONV / TS#{timestamp}#CONV#{conversationId}
  conversationPK: (tenantId: string) => `TENANT#${tenantId}#CONV`,
  conversationSK: (timestamp: string, conversationId: string) =>
    `TS#${timestamp}#CONV#${conversationId}`,

  // Operator results: TENANT#{tenantId}#CONV#{conversationId} / OP#{operatorName}#V#{version}#TS#{timestamp}
  operatorPK: (tenantId: string, conversationId: string) =>
    `TENANT#${tenantId}#CONV#${conversationId}`,
  operatorSK: (operatorName: string, version: string, timestamp: string) =>
    `OP#${operatorName}#V#${version}#TS#${timestamp}`,

  // Aggregates: TENANT#{tenantId}#AGG#DAY / DAY#{yyyyMMdd}#METRIC#{metricName}
  aggregatePK: (tenantId: string) => `TENANT#${tenantId}#AGG#DAY`,
  aggregateSK: (date: string, metricName: string) => `DAY#${date}#METRIC#${metricName}`,

  // Schema registry: TENANT#{tenantId}#SCHEMA / OP#{operatorName}#V#{version}
  schemaPK: (tenantId: string) => `TENANT#${tenantId}#SCHEMA`,
  schemaSK: (operatorName: string, version: string) => `OP#${operatorName}#V#${version}`,

  // View config: TENANT#{tenantId}#VIEW / OP#{operatorName}#V#{version}
  viewPK: (tenantId: string) => `TENANT#${tenantId}#VIEW`,
  viewSK: (operatorName: string, version: string) => `OP#${operatorName}#V#${version}`,
};

// GSI key builders
export const gsiKeys = {
  // GSI1: By agent
  gsi1PK: (tenantId: string, agentId: string) => `TENANT#${tenantId}#AGENT#${agentId}`,
  gsi1SK: (timestamp: string, conversationId: string) => `TS#${timestamp}#CONV#${conversationId}`,

  // GSI2: By queue
  gsi2PK: (tenantId: string, queueId: string) => `TENANT#${tenantId}#QUEUE#${queueId}`,
  gsi2SK: (timestamp: string) => `TS#${timestamp}`,

  // GSI3: By customerKey
  gsi3PK: (tenantId: string, customerKey: string) => `TENANT#${tenantId}#CK#${customerKey}`,
  gsi3SK: (timestamp: string) => `TS#${timestamp}`,
};

// Timestamp formatting for sort keys
export function formatTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '').split('.')[0];
}

export function formatDate(date: Date = new Date()): string {
  return date.toISOString().split('T')[0].replace(/-/g, '');
}

// Key parsing utilities
export function parseConversationSK(sk: string): { timestamp: string; conversationId: string } {
  const parts = sk.split('#');
  return {
    timestamp: parts[1],
    conversationId: parts[3],
  };
}

export function parseOperatorSK(sk: string): {
  operatorName: string;
  version: string;
  timestamp: string;
} {
  const parts = sk.split('#');
  return {
    operatorName: parts[1],
    version: parts[3],
    timestamp: parts[5],
  };
}
