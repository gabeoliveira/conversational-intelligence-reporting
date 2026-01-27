import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

interface SchemaEntry {
  operatorName: string;
  schemaVersion: string;
  jsonSchema: object;
  status: string;
  createdAt: string;
  createdBy?: string;
}

export async function listSchemas(tenantId: string): Promise<{ schemas: SchemaEntry[] }> {
  // Query tenant schemas
  const tenantResult = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}#SCHEMA`,
      },
    })
  );

  // Also get default schemas if tenant is not 'default'
  let defaultSchemas: SchemaEntry[] = [];
  if (tenantId !== 'default') {
    const defaultResult = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `TENANT#default#SCHEMA`,
        },
      })
    );
    defaultSchemas = (defaultResult.Items || []).map(mapSchemaItem);
  }

  const tenantSchemas = (tenantResult.Items || []).map(mapSchemaItem);

  // Merge, with tenant schemas taking precedence
  const schemaMap = new Map<string, SchemaEntry>();
  for (const schema of defaultSchemas) {
    schemaMap.set(`${schema.operatorName}:${schema.schemaVersion}`, schema);
  }
  for (const schema of tenantSchemas) {
    schemaMap.set(`${schema.operatorName}:${schema.schemaVersion}`, schema);
  }

  return {
    schemas: Array.from(schemaMap.values()),
  };
}

export async function getSchema(
  tenantId: string,
  operatorName: string,
  version: string
): Promise<SchemaEntry | null> {
  // Try tenant-specific schema first
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `TENANT#${tenantId}#SCHEMA`,
        SK: `OP#${operatorName}#V#${version}`,
      },
    })
  );

  if (result.Item) {
    return mapSchemaItem(result.Item);
  }

  // Fall back to default tenant
  if (tenantId !== 'default') {
    const defaultResult = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `TENANT#default#SCHEMA`,
          SK: `OP#${operatorName}#V#${version}`,
        },
      })
    );

    if (defaultResult.Item) {
      return mapSchemaItem(defaultResult.Item);
    }
  }

  return null;
}

function mapSchemaItem(item: Record<string, unknown>): SchemaEntry {
  return {
    operatorName: item.operatorName as string,
    schemaVersion: item.schemaVersion as string,
    jsonSchema: item.jsonSchema as object,
    status: item.status as string,
    createdAt: item.createdAt as string,
    createdBy: item.createdBy as string | undefined,
  };
}
