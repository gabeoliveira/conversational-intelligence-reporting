#!/usr/bin/env ts-node

/**
 * Migrate metrics from the main table to the dedicated metrics table
 *
 * Usage:
 *   ts-node scripts/migrate-metrics.ts --env demo
 *
 * Options:
 *   --env <env>       Environment (demo, dev, prod)
 *   --dry-run         Show what would be migrated without writing
 *   --tenant <id>     Migrate specific tenant only (default: all tenants)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

interface MigrationOptions {
  env: string;
  dryRun: boolean;
  tenantId?: string;
}

async function parseArgs(): Promise<MigrationOptions> {
  const args = process.argv.slice(2);
  const options: MigrationOptions = {
    env: '',
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--env':
        options.env = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--tenant':
        options.tenantId = args[++i];
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!options.env) {
    console.error('Error: --env is required');
    console.error('Usage: ts-node scripts/migrate-metrics.ts --env demo [--dry-run] [--tenant <id>]');
    process.exit(1);
  }

  return options;
}

async function getAllTenants(tableName: string): Promise<string[]> {
  const tenants = new Set<string>();
  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    const response = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'begins_with(PK, :prefix)',
        ExpressionAttributeValues: {
          ':prefix': 'TENANT#',
        },
        ProjectionExpression: 'PK',
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );

    response.Items?.forEach((item) => {
      const match = item.PK?.match(/^TENANT#([^#]+)/);
      if (match) {
        tenants.add(match[1]);
      }
    });

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return Array.from(tenants);
}

async function migrateMetricsForTenant(
  tenantId: string,
  sourceTable: string,
  targetTable: string,
  dryRun: boolean
): Promise<{ scanned: number; migrated: number }> {
  const pk = `TENANT#${tenantId}#AGG#DAY`;
  let scanned = 0;
  let migrated = 0;
  let lastEvaluatedKey: Record<string, any> | undefined;

  console.log(`\n  Tenant: ${tenantId}`);

  do {
    const response = await docClient.send(
      new QueryCommand({
        TableName: sourceTable,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': pk,
        },
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );

    const items = response.Items || [];
    scanned += items.length;

    if (items.length > 0 && !dryRun) {
      // Batch write to target table
      const batches: any[][] = [];
      for (let i = 0; i < items.length; i += 25) {
        batches.push(items.slice(i, i + 25));
      }

      for (const batch of batches) {
        await docClient.send(
          new BatchWriteCommand({
            RequestItems: {
              [targetTable]: batch.map((item) => ({
                PutRequest: {
                  Item: item,
                },
              })),
            },
          })
        );
        migrated += batch.length;
      }
    } else if (items.length > 0 && dryRun) {
      migrated += items.length;
    }

    if (items.length > 0) {
      console.log(`    Found ${items.length} metrics records`);
      if (dryRun) {
        console.log(`    [DRY RUN] Would migrate ${items.length} records`);
        // Show sample item
        console.log(`    Sample: PK=${items[0].PK}, SK=${items[0].SK}, value=${items[0].value}`);
      } else {
        console.log(`    ✓ Migrated ${items.length} records`);
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return { scanned, migrated };
}

async function main() {
  const options = await parseArgs();
  const sourceTable = `cirl-${options.env}`;
  const targetTable = `cirl-metrics-${options.env}`;

  console.log('='.repeat(70));
  console.log('CIRL Metrics Migration');
  console.log('='.repeat(70));
  console.log(`Environment:     ${options.env}`);
  console.log(`Source table:    ${sourceTable}`);
  console.log(`Target table:    ${targetTable}`);
  console.log(`Mode:            ${options.dryRun ? 'DRY RUN' : 'LIVE MIGRATION'}`);
  console.log('='.repeat(70));

  // Get list of tenants to migrate
  let tenants: string[];
  if (options.tenantId) {
    tenants = [options.tenantId];
    console.log(`\nMigrating specific tenant: ${options.tenantId}`);
  } else {
    console.log('\nDiscovering tenants...');
    tenants = await getAllTenants(sourceTable);
    console.log(`Found ${tenants.length} tenant(s): ${tenants.join(', ')}`);
  }

  // Migrate each tenant
  let totalScanned = 0;
  let totalMigrated = 0;

  for (const tenant of tenants) {
    const { scanned, migrated } = await migrateMetricsForTenant(
      tenant,
      sourceTable,
      targetTable,
      options.dryRun
    );
    totalScanned += scanned;
    totalMigrated += migrated;
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('Migration Summary');
  console.log('='.repeat(70));
  console.log(`Total metrics scanned:  ${totalScanned}`);
  console.log(`Total metrics migrated: ${totalMigrated}`);
  if (options.dryRun) {
    console.log('\n⚠️  DRY RUN - No data was written');
    console.log('Run without --dry-run to perform actual migration');
  } else {
    console.log('\n✓ Migration completed successfully');
  }
  console.log('='.repeat(70));
}

main().catch((error) => {
  console.error('\n❌ Migration failed:');
  console.error(error);
  process.exit(1);
});
