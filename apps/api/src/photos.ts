import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';

export class BadPhoto extends Error {}
export class PhotoNotFound extends Error {}

const r2 = config.STORAGE_DRIVER === 'r2' ? new S3Client({
  region: 'auto',
  endpoint: config.R2_ENDPOINT!,
  credentials: {
    accessKeyId: config.R2_ACCESS_KEY_ID!,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
  },
}) : null;

export async function savePhoto(file?: Express.Multer.File) {
  if (!file) return null;
  let output: Buffer;
  try {
    const image = sharp(file.buffer, { limitInputPixels: 20_000_000, animated: false });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new BadPhoto();
    // Re-encoding strips EXIF/GPS metadata and prevents executable uploads.
    output = await image.rotate().resize(512, 512, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  } catch {
    throw new BadPhoto('Upload a valid, non-animated JPEG, PNG, or WebP image under 5 MB and 20 megapixels.');
  }
  const filename = `${randomUUID()}.webp`;
  if (r2) {
    await r2.send(new PutObjectCommand({
      Bucket: config.R2_BUCKET!, Key: filename, Body: output, ContentType: 'image/webp',
    }));
  } else {
    await mkdir(config.UPLOAD_DIR, { recursive: true });
    await writeFile(path.join(config.UPLOAD_DIR, filename), output, { flag: 'wx', mode: 0o600 });
  }
  return filename;
}

export async function readPhoto(filename: string) {
  if (!r2) {
    try { return await readFile(path.join(config.UPLOAD_DIR, filename)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PhotoNotFound();
      throw error;
    }
  }
  try {
    const response = await r2.send(new GetObjectCommand({ Bucket: config.R2_BUCKET!, Key: filename }));
    if (!response.Body) throw new PhotoNotFound();
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (error) {
    if (error instanceof PhotoNotFound || (error as { name?: string }).name === 'NoSuchKey' || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      throw new PhotoNotFound();
    }
    throw error;
  }
}

export async function deletePhoto(filename: string) {
  if (r2) {
    await r2.send(new DeleteObjectCommand({ Bucket: config.R2_BUCKET!, Key: filename }));
    return;
  }
  await unlink(path.join(config.UPLOAD_DIR, filename)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}
