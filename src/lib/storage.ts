import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

const { endpoint, region, key, secret, bucket, prefix } = config.spaces;

if (!endpoint) {
  throw new Error(
    'DO_SPACES_ENDPOINT is not set. Add it to your environment variables (e.g. https://sfo3.digitaloceanspaces.com).'
  );
}

const s3 = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId: key, secretAccessKey: secret },
  forcePathStyle: false,
});

/** Full CDN URL for a Space key. */
export function cdnUrl(objectKey: string): string {
  // cdn origin: https://{bucket}.{endpoint-host}/{key}
  const host = endpoint.replace(/^https?:\/\//, '');
  return `https://${bucket}.${host}/${objectKey}`;
}

/**
 * Extracts the object key from a CDN URL produced by cdnUrl().
 * Returns null for any URL that does not belong to this Space.
 */
export function keyFromCdnUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const host = endpoint.replace(/^https?:\/\//, '');
  const base = `https://${bucket}.${host}/`;
  if (!url.startsWith(base)) return null;
  return url.slice(base.length);
}

/**
 * Uploads a buffer to the Space with public-read ACL.
 * Returns the CDN URL of the uploaded object.
 */
export async function uploadPublic(objectKey: string, buffer: Buffer, mimeType: string): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: buffer,
      ContentType: mimeType,
      ACL: 'public-read',
    })
  );
  return cdnUrl(objectKey);
}

/**
 * Uploads a buffer to the Space with no ACL (private).
 * The object is only accessible via a presigned URL.
 */
export async function uploadPrivate(objectKey: string, buffer: Buffer, mimeType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: buffer,
      ContentType: mimeType,
    })
  );
}

/**
 * Deletes an object from the Space by its key.
 * Silently ignores NoSuchKey — safe to call even if the object may not exist.
 */
export async function deleteObject(objectKey: string | null | undefined): Promise<void> {
  if (!objectKey) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
  } catch (err: unknown) {
    const code = (err as { Code?: string; name?: string }).Code ?? (err as { name?: string }).name ?? '';
    if (code === 'NoSuchKey' || code === 'NotFound') return;
    throw err;
  }
}

/**
 * Generates a presigned GET URL for a private object.
 * @param objectKey  The space object key (e.g. "sax/files/folder-id/filename")
 * @param ttlSeconds URL validity in seconds (default: 300 = 5 min)
 */
export async function getPresignedUrl(objectKey: string, ttlSeconds = 300): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: objectKey });
  return getSignedUrl(s3, command, { expiresIn: ttlSeconds });
}

/** Project-scoped key builder helpers */
export const keys = {
  propertyImage: (propertyId: string, filename: string) =>
    `${prefix}/properties/${propertyId}/${filename}`,
  siteImage: (type: 'logo' | 'favicon', filename: string) =>
    `${prefix}/site/${type}/${filename}`,
  sitePartner: (filename: string) =>
    `${prefix}/site/partners/${filename}`,
  settingsImage: (warehouseId: string, type: string, filename: string) =>
    `${prefix}/settings/${warehouseId}/${type}/${filename}`,
  avatar: (filename: string) =>
    `${prefix}/avatars/${filename}`,
  helpdeskImage: (ticketId: string, filename: string) =>
    `${prefix}/helpdesk/${ticketId}/${filename}`,
  pdvFile: (folderId: string | null | undefined, filename: string) =>
    folderId
      ? `${prefix}/files/${folderId}/${filename}`
      : `${prefix}/files/${filename}`,
};
