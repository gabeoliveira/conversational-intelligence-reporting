/**
 * S3-based config fetcher. Reads config files from S3 and initializes the config loader.
 *
 * Usage in Lambda handlers:
 *   import { ensureConfigLoaded } from '@cirl/shared';
 *   await ensureConfigLoaded(); // Call once at handler start
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { initializeConfig } from './config-loader';
import { initializeTenantsConfig } from './tenant-config';

const s3Client = new S3Client({});
let configLoaded = false;

/**
 * Ensure operator metrics config is loaded from S3.
 * Safe to call multiple times — only fetches on first call (per cold start).
 */
export async function ensureConfigLoaded(): Promise<void> {
  if (configLoaded) return;

  const bucket = process.env.CONFIG_BUCKET;
  const prefix = process.env.CONFIG_PREFIX || 'config/';

  if (!bucket) {
    console.warn('CONFIG_BUCKET not set — config-driven metrics disabled');
    configLoaded = true;
    return;
  }

  await Promise.all([
    loadAndInit(bucket, `${prefix}operator-metrics.json`, initializeConfig, 'operator-metrics.json'),
    loadAndInit(bucket, `${prefix}tenants.json`, initializeTenantsConfig, 'tenants.json'),
  ]);

  configLoaded = true;
}

async function loadAndInit(
  bucket: string,
  key: string,
  init: (body: string) => unknown,
  label: string
): Promise<void> {
  try {
    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await response.Body?.transformToString();
    if (body) init(body);
  } catch (error: any) {
    if (error.name === 'NoSuchKey') {
      console.warn(`${label} not found in S3 — falling back to defaults`);
    } else {
      console.error(`Failed to load ${label} from S3:`, error);
    }
  }
}

/**
 * Load a specific config file from S3.
 * Returns the parsed JSON, or null if not found.
 */
export async function loadConfigFromS3<T>(fileName: string): Promise<T | null> {
  const bucket = process.env.CONFIG_BUCKET;
  const prefix = process.env.CONFIG_PREFIX || 'config/';

  if (!bucket) return null;

  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: `${prefix}${fileName}`,
    }));

    const body = await response.Body?.transformToString();
    if (body) {
      return JSON.parse(body) as T;
    }
  } catch (error: any) {
    if (error.name !== 'NoSuchKey') {
      console.error(`Failed to load ${fileName} from S3:`, error);
    }
  }

  return null;
}

/**
 * Reset for testing.
 */
export function resetS3ConfigState(): void {
  configLoaded = false;
}
