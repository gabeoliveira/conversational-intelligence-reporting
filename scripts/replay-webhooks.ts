/**
 * Replay demo webhook calls to test the ingest pipeline
 *
 * Usage: npm run demo:replay
 *
 * This script posts demo payloads to the webhook endpoint,
 * simulating real CI webhook calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ENV = process.env.CIRL_ENV || 'demo';
const TENANT_ID = 'demo';

interface ConversationData {
  conversationId: string;
  customerKey?: string;
  channel: string;
  agentId?: string;
  teamId?: string;
  queueId?: string;
  startedAt: string;
  endedAt?: string;
}

interface OperatorResultData {
  conversationId: string;
  operatorName: string;
  schemaVersion: string;
  data: Record<string, unknown>;
}

async function main() {
  console.log(`Replaying webhooks for environment: ${ENV}`);

  // Get webhook URL from SSM or environment
  let webhookUrl = process.env.WEBHOOK_URL;

  if (!webhookUrl) {
    try {
      const ssmClient = new SSMClient({});
      const result = await ssmClient.send(
        new GetParameterCommand({
          Name: `/cirl/${ENV}/api-url`,
        })
      );
      webhookUrl = `${result.Parameter?.Value}webhook/ci`;
    } catch {
      console.error('Could not get webhook URL from SSM. Set WEBHOOK_URL environment variable.');
      process.exit(1);
    }
  }

  console.log(`Webhook URL: ${webhookUrl}`);

  // Load demo data
  const configPath = path.join(__dirname, '..', 'config', 'demo-data');
  const conversations: ConversationData[] = JSON.parse(
    fs.readFileSync(path.join(configPath, 'seed-conversations.json'), 'utf-8')
  ).conversations;

  const operatorResults: OperatorResultData[] = JSON.parse(
    fs.readFileSync(path.join(configPath, 'seed-operator-results.json'), 'utf-8')
  ).operatorResults;

  // Post each operator result as a webhook call
  console.log('\nSending webhook calls...');

  for (const result of operatorResults) {
    const conv = conversations.find(c => c.conversationId === result.conversationId);

    const payload = {
      conversationId: result.conversationId,
      operatorName: result.operatorName,
      schemaVersion: result.schemaVersion,
      timestamp: conv?.startedAt || new Date().toISOString(),
      data: result.data,
      metadata: conv
        ? {
            customerKey: conv.customerKey,
            channel: conv.channel,
            agentId: conv.agentId,
            teamId: conv.teamId,
            queueId: conv.queueId,
          }
        : undefined,
    };

    try {
      const response = await fetch(webhookUrl!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': TENANT_ID,
        },
        body: JSON.stringify(payload),
      });

      const responseBody = await response.json();

      if (response.ok) {
        console.log(`  ✓ ${result.conversationId}/${result.operatorName} - ${response.status}`);
      } else {
        console.log(`  ✗ ${result.conversationId}/${result.operatorName} - ${response.status}: ${JSON.stringify(responseBody)}`);
      }

      // Small delay to avoid overwhelming the API
      await sleep(100);
    } catch (error) {
      console.error(`  ✗ ${result.conversationId}/${result.operatorName} - Error: ${error}`);
    }
  }

  console.log('\n✅ Webhook replay complete!');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
