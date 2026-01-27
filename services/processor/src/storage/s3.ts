import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { CIWebhookPayload } from '../types';

const s3Client = new S3Client({});

export async function getPayloadFromS3(s3Uri: string): Promise<CIWebhookPayload> {
  // Parse s3://bucket/key format
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid S3 URI: ${s3Uri}`);
  }

  const [, bucket, key] = match;

  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  const body = await response.Body?.transformToString();
  if (!body) {
    throw new Error(`Empty response from S3: ${s3Uri}`);
  }

  return JSON.parse(body);
}
