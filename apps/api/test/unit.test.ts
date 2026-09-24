// Unit tests: run WITHOUT a database (`npm test`). They exercise the pure
// pieces — validation, CSV escaping, auth guards, photo transformation — by
// building an Express app with supertest and sending real HTTP requests to it.
//
// Why no DB: app.ts only connects to MySQL lazily on a query, and these tests
// arrange never to reach one; the guarded routes respond 401/403 before any
// database access, which is itself something we assert below.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import sharp from 'sharp';
import express from 'express';
import { csvCell, submission, fields, listing } from '../src/validation.js';

// Isolate uploads in a fresh temp dir and put the process in 'test' mode.
const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'testimonials-unit-'));
process.env.NODE_ENV = 'test';
process.env.DB_PASSWORD = 'unit-tests-never-connect'; // Satisfies config validation only.
process.env.UPLOAD_DIR = uploadDir;
const { createApp } = await import('../src/app.js');
const { savePhoto, readPhoto, deletePhoto, BadPhoto, PhotoNotFound } = await import('../src/photos.js');
const { requireCsrf } = await import('../src/auth.js');
const { pool } = await import('../src/db.js');
test.after(async () => { await pool.end(); await rm(uploadDir, { recursive: true, force: true }); });

// The minimum valid submission — every other test builds on this and varies
// one field at a time to isolate what each rule rejects.
const valid = {
  name: 'Anika Rao', view: 'Thoughtful development and clear communication throughout our project.',
  clientSubmittedAt: new Date().toISOString(), clientTimezone: 'Asia/Kolkata', consent: true,
};

test('submission accepts omitted location and optional profile fields', () => {
  const result = submission.parse(valid);
  // Unfilled optional fields become empty strings / null — not undefined.
  assert.equal(result.location, null);
  assert.equal(result.linkedin, '');
  assert.equal(result.company, '');
  assert.equal(result.companyUrl, '');
  assert.equal(result.name, valid.name);
});

test('validation rejects invalid required fields, location, timestamp, timezone and missing consent', () => {
  // Each entry swaps one part of the payload for something invalid.
  for (const change of [{ name: ' ' }, { view: 'tiny' }, { view: 'a'.repeat(3001) }, { consent: false },
    { location: { latitude: 91, longitude: 1, accuracy: 1 } },
    { location: { latitude: 12, longitude: 181, accuracy: 1 } },
    { clientSubmittedAt: 'not a date' }, { clientTimezone: 'Made/Up' }]) {
    assert.equal(submission.safeParse({ ...valid, ...change }).success, false);
  }
});

test('LinkedIn accepts only HTTPS LinkedIn profiles without spoofed hosts', () => {
  // The one acceptable shape: a real linkedin.com profile URL over HTTPS.
  assert.equal(fields.safeParse({ ...valid, linkedin: 'https://www.linkedin.com/in/anika/' }).success, true);
  // Everything else must fail: javascript: schemes, spoofed subdomains,
  // credential-embedding URLs, HTTP, non-profile paths.
  for (const linkedin of ['javascript:alert(1)', 'https://linkedin.com.evil.test/in/person', 'https://evil.test/in/person', 'https://linkedin.com@evil.test/in/person', 'https://user:pass@linkedin.com/in/person', 'http://linkedin.com/in/person']) {
    assert.equal(fields.safeParse({ ...valid, linkedin }).success, false);
  }
});

test('company page accepts secure URLs without embedded credentials', () => {
  for (const companyUrl of ['https://example.com', 'https://www.example.com/about?team=web#people']) {
    assert.equal(fields.safeParse({ ...valid, companyUrl }).success, true);
  }
  for (const companyUrl of ['javascript:alert(1)', 'http://example.com', 'https://user:pass@example.com', 'not-a-url']) {
    assert.equal(fields.safeParse({ ...valid, companyUrl }).success, false);
  }
});

test('sorting and pagination allow only bounded known values', () => {
  // Query parameters never become SQL: 'sort' is an allowlist key and page/
  // limit are bounded integers, so injection attempts and absurd values fail.
  assert.equal(listing.safeParse({ sort: 'name; DROP TABLE admins' }).success, false);
  assert.equal(listing.safeParse({ page: -1 }).success, false);
  assert.equal(listing.safeParse({ limit: 100000 }).success, false);
});

test('CSV quoting blocks spreadsheet formulas and preserves commas, quotes and newlines', () => {
  // Ordinary text keeps commas/quotes/newlines but must be quoted+escaped.
  assert.equal(csvCell('Hello, "friend"\nWelcome'), '"Hello, ""friend""\nWelcome"');
  // Everything a spreadsheet would interpret as a formula gets neutralised
  // by prefixing an apostrophe.
  for (const input of ['=CMD()', '+1', '-1', '@SUM(1)', '  =1', '\t=1', '\n=1']) assert.equal(csvCell(input), `"'${input}"`);
});

test('admin data, export, edits, deletion and media are protected before any database access', async () => {
  // createApp() builds the app; supertest lets us fire HTTP requests at it
  // in-process. Every admin route must answer 401 when unauthenticated and,
  // crucially, before touching the database (which isn't configured here).
  const api = supertest(createApp());
  await api.get('/api/admin/testimonials').expect(401);
  await api.get('/api/admin/export').expect(401);
  await api.patch('/api/admin/testimonials/123').send({}).expect(401);
  await api.delete('/api/admin/testimonials/123').expect(401);
  await api.get('/api/admin/session').set('Cookie', 'testimonials_session=invalid').expect(401);
  // A malformed photo UUID is rejected before lookup.
  await api.get('/api/photos/not-a-uuid').expect(400);
});

test('submission and login reject missing and foreign origins', async () => {
  const api = supertest(createApp());
  // No Origin header at all → rejected, as is an Origin that isn't allowlisted.
  await api.post('/api/testimonials').expect(403);
  await api.post('/api/testimonials').set('Origin', 'https://evil.test').expect(403);
  // The public origin is NOT allowed on the admin login.
  await api.post('/api/admin/login').set('Origin', 'http://localhost:5173').send({}).expect(403);
});

test('CSRF rejects missing/wrong tokens and accepts matching session token', async () => {
  // Standalone micro-app so we can test requireCsrf in isolation: a stub
  // session supplies the expected csrf_token, and we vary the header.
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
  // Payload isn't JSON.
  await api.post('/api/testimonials').set('Origin', 'http://localhost:5173').field('payload', 'not-json').expect(400);
  // SVG is a valid image for humans but rejected: it isn't in our allowlist.
  await api.post('/api/testimonials').set('Origin', 'http://localhost:5173').field('payload', JSON.stringify(valid))
    .attach('photo', Buffer.from('<svg></svg>'), { filename: 'photo.svg', contentType: 'image/svg+xml' }).expect(400);
  // One byte over the 5 MB limit.
  await api.post('/api/testimonials').set('Origin', 'http://localhost:5173').field('payload', JSON.stringify(valid))
    .attach('photo', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'photo.jpg', contentType: 'image/jpeg' }).expect(400);
  // Correct MIME label but garbage bytes — sharp's decode must catch it.
  await api.post('/api/testimonials').set('Origin', 'http://localhost:5173').field('payload', JSON.stringify(valid))
    .attach('photo', Buffer.from('This is not an image'), { filename: 'photo.jpg', contentType: 'image/jpeg' }).expect(400);
});

test('submission rate limit stops the sixth attempt and returns retry headers', async () => {
  const api = supertest(createApp());
  // Invalid bodies are fine for this test — the limit fires before validation
  // — and each returns 400 rather than being counted as a success.
  for (let i = 0; i < 5; i++) await api.post('/api/testimonials').set('Origin', 'http://localhost:5173').field('payload', '{}').expect(400);
  // Sixth attempt hits the per-IP cap of 5/hour.
  const result = await api.post('/api/testimonials').set('Origin', 'http://localhost:5173').field('payload', '{}').expect(429);
  // Clients learn when they may retry.
  assert.ok(result.headers['retry-after']);
});

test('photo handling rejects disguised files and re-encodes valid images without metadata', async () => {
  // Garbage labelled as a photo — savePhoto must raise BadPhoto.
  await assert.rejects(savePhoto({ buffer: Buffer.from('fake jpeg') } as Express.Multer.File), BadPhoto);
  // Build a REAL 700×600 JPEG with EXIF metadata attached, then save it.
  const buffer = await sharp({ create: { width: 700, height: 600, channels: 3, background: '#aabbcc' } }).jpeg().withMetadata().toBuffer();
  const name = await savePhoto({ buffer } as Express.Multer.File);
  assert.match(name!, /^[a-f0-9-]+\.webp$/);
  // The stored file must be the transformed WebP: 512×512, no EXIF left —
  // proof that metadata stripping and resizing really happened.
  const output = await readFile(path.join(uploadDir, name!));
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);
  assert.equal(metadata.exif, undefined);
  // Round trip read matches bytes; delete makes the read throw PhotoNotFound.
  assert.deepEqual(await readPhoto(name!), output);
  await deletePhoto(name!);
  await assert.rejects(readPhoto(name!), PhotoNotFound);
});