import Ajv, { ValidateFunction } from 'ajv';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

const ajv = new Ajv({ allErrors: true, strict: false });

// Cache compiled schemas
const schemaCache = new Map<string, ValidateFunction>();

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export async function validatePayload(
  tenantId: string,
  operatorName: string,
  schemaVersion: string,
  payload: Record<string, unknown>
): Promise<ValidationResult> {
  const cacheKey = `${tenantId}:${operatorName}:${schemaVersion}`;

  // Check cache first
  let validate = schemaCache.get(cacheKey);

  if (!validate) {
    // Try to load schema from DynamoDB
    const schema = await loadSchema(tenantId, operatorName, schemaVersion);

    if (!schema) {
      // No schema registered - skip validation
      return { valid: true };
    }

    try {
      validate = ajv.compile(schema);
      schemaCache.set(cacheKey, validate);
    } catch (error) {
      console.error(`Failed to compile schema ${cacheKey}:`, error);
      return { valid: true }; // Skip validation if schema is invalid
    }
  }

  const valid = validate(payload);

  if (!valid && validate.errors) {
    return {
      valid: false,
      errors: validate.errors.map(e => `${e.instancePath} ${e.message}`),
    };
  }

  return { valid: true };
}

async function loadSchema(
  tenantId: string,
  operatorName: string,
  schemaVersion: string
): Promise<object | null> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `TENANT#${tenantId}#SCHEMA`,
          SK: `OP#${operatorName}#V#${schemaVersion}`,
        },
      })
    );

    if (result.Item?.jsonSchema) {
      return result.Item.jsonSchema as object;
    }

    // Try default tenant schema
    if (tenantId !== 'default') {
      const defaultResult = await docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: `TENANT#default#SCHEMA`,
            SK: `OP#${operatorName}#V#${schemaVersion}`,
          },
        })
      );

      if (defaultResult.Item?.jsonSchema) {
        return defaultResult.Item.jsonSchema as object;
      }
    }

    return null;
  } catch (error) {
    console.error(`Failed to load schema ${operatorName}:${schemaVersion}:`, error);
    return null;
  }
}
