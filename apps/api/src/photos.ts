import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export class BadPhoto extends Error {}
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
  await mkdir(config.UPLOAD_DIR, { recursive: true });
  const filename = `${randomUUID()}.webp`;
  await writeFile(path.join(config.UPLOAD_DIR, filename), output, { flag: 'wx', mode: 0o600 });
  return filename;
}
