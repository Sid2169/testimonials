// Photo upload handling.
//
// Uploaded photos go through two safety gates:
//  1. Multer (see app.ts) rejects wrong MIME types and oversized files early.
//  2. This module decodes the image, strips all metadata, resizes it, and
//     re-encodes it as WebP. The original bytes are never stored, which
//     neutralises hidden payloads (e.g. EXIF data or a disguised executable)
//     and keeps stored files uniformly small.
// Storage is either the local filesystem or S3-compatible object storage
// (e.g. Backblaze B2), selected via STORAGE_DRIVER.

import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';

// Distinguishes "reject this upload" (BadPhoto, mapped to 400) from "the
// stored photo is missing" (PhotoNotFound, mapped to 404) so handlers can
// respond appropriately instead of a generic 500.
export class BadPhoto extends Error {}
export class PhotoNotFound extends Error {}

// Create the S3 client once if configured. `null` means "use local disk".
// forcePathStyle is needed for S3-compatible providers like Backblaze B2.
const objectStorage = config.STORAGE_DRIVER === 's3' ? new S3Client({
  region: config.S3_REGION!,
  endpoint: config.S3_ENDPOINT!,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY_ID!,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
  },
}) : null;

// Encode, transform, and persist an uploaded photo. Returns the new filename
// (a random UUID + .webp), or null when no file was provided. Only valid
// single-image JPEG/PNG/WebP files under the megapixel limit pass.
export async function savePhoto(file?: Express.Multer.File) {
  if (!file) return null;
  let output: Buffer;
  try {
    // limitInputPixels caps decompression to 20MP; animated:false rejects
    // animated files, which could otherwise be used to smuggle content or
    // behaviour incompatible with a static rendered image.
    const image = sharp(file.buffer, { limitInputPixels: 20_000_000, animated: false });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new BadPhoto();
    // rotate() honours orientation flags; resize() downscales without
    // enlarging; webp({ quality: 82 }) re-encodes. Re-encoding also strips
    // EXIF/GPS metadata and prevents executable uploads.
    output = await image.rotate().resize(512, 512, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  } catch {
    // The file-level MIME filter ran earlier, but the true format can still
    // be fake (e.g. an SVG labelled image/jpeg) — hence the decode here.
    throw new BadPhoto('Upload a valid, non-animated JPEG, PNG, or WebP image under 5 MB and 20 megapixels.');
  }
  const filename = `${randomUUID()}.webp`;
  if (objectStorage) {
    await objectStorage.send(new PutObjectCommand({
      Bucket: config.S3_BUCKET!, Key: filename, Body: output, ContentType: 'image/webp',
    }));
  } else {
    await mkdir(config.UPLOAD_DIR, { recursive: true });
    // flag: 'wx' fails if the file already exists (UUIDs make that ~impossible
    // anyway), and 0o600 keeps the file readable only by the owner.
    await writeFile(path.join(config.UPLOAD_DIR, filename), output, { flag: 'wx', mode: 0o600 });
  }
  return filename;
}

// Read a stored photo back as a Buffer, or throw PhotoNotFound if it is gone.
export async function readPhoto(filename: string) {
  if (!objectStorage) {
    try { return await readFile(path.join(config.UPLOAD_DIR, filename)); }
    catch (error) {
      // A missing local file surfaces as ENOENT; translate it to 404 semantics.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PhotoNotFound();
      throw error;
    }
  }
  try {
    const response = await objectStorage.send(new GetObjectCommand({ Bucket: config.S3_BUCKET!, Key: filename }));
    if (!response.Body) throw new PhotoNotFound();
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (error) {
    // S3 reports "not found" as either a NoSuchKey error or a 404 status;
    // translate all of those to PhotoNotFound.
    if (error instanceof PhotoNotFound || (error as { name?: string }).name === 'NoSuchKey' || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      throw new PhotoNotFound();
    }
    throw error;
  }
}

// Remove a stored photo (used to clean up when a submission fails mid-save).
export async function deletePhoto(filename: string) {
  if (objectStorage) {
    await objectStorage.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET!, Key: filename }));
    return;
  }
  // ENOENT means the file was already gone — not an error worth propagating.
  await unlink(path.join(config.UPLOAD_DIR, filename)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}