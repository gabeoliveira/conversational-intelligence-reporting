import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({});
const BUCKET_NAME = process.env.RAW_BUCKET_NAME!;

export async function writeToS3(key: string, payload: Record<string, unknown>): Promise<string> {
  const body = JSON.stringify(payload, null, 2);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: 'application/json',
    })
  );

  return `s3://${BUCKET_NAME}/${key}`;
}
