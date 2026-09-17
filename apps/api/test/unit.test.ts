import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import sharp from 'sharp';
import express from 'express';
import { csvCell, submission, fields, listing } from '../src/validation.js';

const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'testimonials-unit-'));
process.env.NODE_ENV = 'test';
process.env.DB_PASSWORD = 'unit-tests-never-connect';
process.env.UPLOAD_DIR = uploadDir;
const { createApp } = await import('../src/app.js');
const { savePhoto, BadPhoto } = await import('../src/photos.js');
const { requireCsrf } = await import('../src/auth.js');
const { pool } = await import('../src/db.js');
test.after(async () => { await pool.end(); await rm(uploadDir, { recursive: true, force: true }); });

const valid = {
  name: 'Anika Rao', view: 'Thoughtful development and clear communication throughout our project.',
  clientSubmittedAt: new Date().toISOString(), clientTimezone: 'Asia/Kolkata', consent: true,
};

test('submission accepts omitted location and optional profile fields', () => {
  const result = submission.parse(valid);
  assert.equal(result.location, null);
  assert.equal(result.linkedin, '');
  assert.equal(result.company, '');
  assert.equal(result.name, valid.name);
});
test('validation rejects invalid required fields, location, timestamp, timezone and missing consent', () => {
  for (const change of [{ name: ' ' }, { view: 'tiny' }, { view: 'a'.repeat(3001) }, { consent: false },
    { location: { latitude: 91, longitude: 1, accuracy: 1 } },
    { location: { latitude: 12, longitude: 181, accuracy: 1 } },
    { clientSubmittedAt: 'not a date' }, { clientTimezone: 'Made/Up' }]) {
    assert.equal(submission.safeParse({ ...valid, ...change }).success, false);
  }
});
test('LinkedIn accepts only HTTPS LinkedIn profiles without spoofed hosts', () => {
  assert.equal(fields.safeParse({ ...valid, linkedin: 'https://www.linkedin.com/in/anika/' }).success, true);
  for (const linkedin of ['javascript:alert(1)', 'https://linkedin.com.evil.test/in/person', 'https://evil.test/in/person', 'https://linkedin.com@evil.test/in/person', 'https://user:pass@linkedin.com/in/person', 'http://linkedin.com/in/person']) {
    assert.equal(fields.safeParse({ ...valid, linkedin }).success, false);
  }
});
test('sorting and pagination allow only bounded known values', () => {
  assert.equal(listing.safeParse({ sort: 'name; DROP TABLE admins' }).success, false);
  assert.equal(listing.safeParse({ page: -1 }).success, false);
  assert.equal(listing.safeParse({ limit: 100000 }).success, false);
});
test('CSV quoting blocks spreadsheet formulas and preserves commas, quotes and newlines', () => {
  assert.equal(csvCell('Hello, "friend"\nWelcome'), '"Hello, ""friend""\nWelcome"');
  for (const input of ['=CMD()', '+1', '-1', '@SUM(1)', '  =1', '\t=1', '\n=1']) assert.equal(csvCell(input), `"'${input}"`);
});
test('admin data, export, edits, deletion and media are protected before any database access', async () => {
  const api = supertest(createApp());
  await api.get('/api/admin/testimonials').expect(401);
  await api.get('/api/admin/export').expect(401);
  await api.patch('/api/admin/testimonials/123').send({}).expect(401);
  await api.delete('/api/admin/testimonials/123').expect(401);
  await api.get('/api/admin/session').set('Cookie', 'testimonials_session=invalid').expect(401);
  await api.get('/api/photos/not-a-uuid').expect(400);
});
test('submission and login reject missing and foreign origins', async () => {
  const api = supertest(createApp());
  await api.post('/api/testimonials').expect(403);
  await api.post('/api/testimonials').set('Origin', 'https://evil.test').expect(403);
  await api.post('/api/admin/login').set('Origin', 'http://localhost:5173').send({}).expect(403);
});
test('CSRF rejects missing/wrong tokens and accepts matching session token', async () => {
  const app = express();
  app.use((_req, res, next) => { res.locals.session = { csrf_token: 'valid-token' }; next(); });
  app.post('/change', requireCsrf, (_req, res) => { res.sendStatus(204); });
  const api = supertest(app);
  await api.post('/change').expect(403);
  await api.post('/change').set('X-CSRF-Token', 'wrong-token').expect(403);
  await api.post('/change').set('X-CSRF-Token', 'valid-token').expect(204);
});
test('malformed form, invalid content types and oversized uploads are rejected', async () => {
  const api = supertest(createApp());
  await api.post('/api/testimonials').set('Origin', 'http://localhost:5173').field('payload', 'not-json').expect(400);
  await api.post('/api/testimonials').set('Origin', 'http://localhost:5173').field('payload', JSON.stringify(valid))
    .attach('photo', Buffer.from('<svg></svg>'), { filename: 'photo.svg', contentType: 'image/svg+xml' }).expect(400);
  await api.post('/api/testimonials').set('Origin', 'http://localhost:5173').field('payload', JSON.stringify(valid))
    .attach('photo', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'photo.jpg', contentType: 'image/jpeg' }).expect(400);
  await api.post('/api/testimonials').set('Origin', 'http://localhost:5173').field('payload', JSON.stringify(valid))
    .attach('photo', Buffer.from('This is not an image'), { filename: 'photo.jpg', contentType: 'image/jpeg' }).expect(400);
});
test('submission rate limit stops the sixth attempt and returns retry headers', async () => {
  const api = supertest(createApp());
  for (let i = 0; i < 5; i++) await api.post('/api/testimonials').set('Origin', 'http://localhost:5173').field('payload', '{}').expect(400);
  const result = await api.post('/api/testimonials').set('Origin', 'http://localhost:5173').field('payload', '{}').expect(429);
  assert.ok(result.headers['retry-after']);
});
test('photo handling rejects disguised files and re-encodes valid images without metadata', async () => {
  await assert.rejects(savePhoto({ buffer: Buffer.from('fake jpeg') } as Express.Multer.File), BadPhoto);
  const buffer = await sharp({ create: { width: 700, height: 600, channels: 3, background: '#aabbcc' } }).jpeg().withMetadata().toBuffer();
  const name = await savePhoto({ buffer } as Express.Multer.File);
  assert.match(name!, /^[a-f0-9-]+\.webp$/);
  const output = await readFile(path.join(uploadDir, name!));
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);
  assert.equal(metadata.exif, undefined);
});
