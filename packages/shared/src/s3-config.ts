/**
 * S3-based config fetcher. Reads config files from S3 and initializes the config loader.
 *
 * Usage in Lambda handlers:
 *   import { ensureConfigLoaded } from '@cirl/shared';
 *   await ensureConfigLoaded(); // Call once at handler start
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { initializeConfig } from './config-loader';

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

  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: `${prefix}operator-metrics.json`,
    }));

    const body = await response.Body?.transformToString();
    if (body) {
      initializeConfig(body);
    }
  } catch (error: any) {
    if (error.name === 'NoSuchKey') {
      console.warn('operator-metrics.json not found in S3 — config-driven metrics disabled');
    } else {
      console.error('Failed to load operator metrics config from S3:', error);
    }
  }

  configLoaded = true;
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
