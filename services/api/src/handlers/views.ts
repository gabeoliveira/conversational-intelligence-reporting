import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

interface ViewConfig {
  operatorName: string;
  schemaVersion: string;
  display: {
    title: string;
    icon?: string;
  };
  table?: {
    columns: Array<{
      field: string;
      label: string;
      type: string;
      format?: string;
      sortable?: boolean;
    }>;
  };
  detail?: {
    sections: Array<{
      title: string;
      fields?: string[];
      field?: string;
      type?: string;
    }>;
  };
  charts?: Array<{
    type: string;
    field: string;
    title: string;
    groupBy?: string;
  }>;
}

export async function listViews(tenantId: string): Promise<{ views: ViewConfig[] }> {
  // Query tenant views
  const tenantResult = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}#VIEW`,
      },
    })
  );

  // Also get default views if tenant is not 'default'
  let defaultViews: ViewConfig[] = [];
  if (tenantId !== 'default') {
    const defaultResult = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `TENANT#default#VIEW`,
        },
      })
    );
    defaultViews = (defaultResult.Items || []).map(mapViewItem);
  }

  const tenantViews = (tenantResult.Items || []).map(mapViewItem);

  // Merge, with tenant views taking precedence
  const viewMap = new Map<string, ViewConfig>();
  for (const view of defaultViews) {
    viewMap.set(`${view.operatorName}:${view.schemaVersion}`, view);
  }
  for (const view of tenantViews) {
    viewMap.set(`${view.operatorName}:${view.schemaVersion}`, view);
  }

  return {
    views: Array.from(viewMap.values()),
  };
}

export async function createView(
  tenantId: string,
  viewConfig: ViewConfig
): Promise<ViewConfig> {
  const { operatorName, schemaVersion } = viewConfig;

  if (!operatorName || !schemaVersion) {
    throw new Error('operatorName and schemaVersion are required');
  }

  const now = new Date().toISOString();

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `TENANT#${tenantId}#VIEW`,
        SK: `OP#${operatorName}#V#${schemaVersion}`,
        ...viewConfig,
        tenantId,
        entityType: 'VIEW',
        createdAt: now,
        updatedAt: now,
      },
    })
  );

  return viewConfig;
}

function mapViewItem(item: Record<string, unknown>): ViewConfig {
  return {
    operatorName: item.operatorName as string,
    schemaVersion: item.schemaVersion as string,
    display: item.display as ViewConfig['display'],
    table: item.table as ViewConfig['table'],
    detail: item.detail as ViewConfig['detail'],
    charts: item.charts as ViewConfig['charts'],
  };
}
