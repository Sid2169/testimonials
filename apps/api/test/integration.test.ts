// Integration test: the full MySQL lifecycle using a REAL database.
// Run with `DB_NAME=<something>_test npm run test:integration`.
//
// This suite is destructive — it clears the tables it touches — so it refuses
// to run unless the configured database name ends in `_test`. Never point it
// at a real database. It walks a submission end-to-end through the real API:
// submit → private review (including the photo) → approve → public visibility
// → search/CSV → reject → soft-delete → logout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import supertest from 'supertest';
import 'dotenv/config';

// Guard: abort before doing ANYTHING if not pointed at a dedicated test DB.
if (!process.env.DB_NAME?.endsWith('_test')) throw new Error('Set DB_NAME to a dedicated database ending in _test. Never run this suite on your real database.');
const uploads = await mkdtemp(path.join(os.tmpdir(), 'testimonials-integration-'));
process.env.NODE_ENV = 'test'; process.env.UPLOAD_DIR = uploads;
// Exact configured origins; they must match the values used as headers below.
process.env.PUBLIC_ORIGIN = 'http://localhost:5173'; process.env.ADMIN_ORIGIN = 'http://localhost:5174';
const { migrate, execute, rows, pool } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const publicOrigin = 'http://localhost:5173';
const adminOrigin = 'http://localhost:5174';
// Random password so the test never relies on a known/committed value.
const password = randomUUID();

test('MySQL lifecycle: submission → private review → approval → export → unpublish → delete → logout', async () => {
  await migrate();
  // Start from a clean slate each run.
  await execute('DELETE FROM sessions'); await execute('DELETE FROM testimonials'); await execute('DELETE FROM admins');
  await execute('INSERT INTO admins (id, email, password_hash) VALUES (1, ?, ?)', ['owner@example.test', await bcrypt.hash(password, 12)]);
  const app = createApp();
  const visitor = supertest(app);
  // .agent() keeps cookies across requests — like a real logged-in browser.
  const admin = supertest.agent(app);
  // A believable submission: note the leading '=' in the name — a deliberate
  // spreadsheet-formula-injection attempt we expect the CSV export to defuse.
  const payload = { name: '=Anika', view: 'A thoughtful developer and an excellent collaborator.', company: 'Studio', companyUrl: 'https://studio.example/about', designation: 'Designer', linkedin: 'https://www.linkedin.com/in/anika/', consent: true, clientSubmittedAt: new Date().toISOString(), clientTimezone: 'Asia/Kolkata', location: { latitude: 12.123456, longitude: 77.123456, accuracy: 400 } };
  // A tiny real PNG to upload as the testimonial photo.
  const photo = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#123456' } }).png().toBuffer();

  // 1. A visitor submits (multipart form: JSON payload + photo).
  await visitor.post('/api/testimonials').set('Origin', publicOrigin).field('payload', JSON.stringify(payload)).attach('photo', photo, { filename: 'avatar.png', contentType: 'image/png' }).expect(201);

  // 2. The row saved as PENDING, with coordinates rounded to 3 decimals.
  const [record] = await rows<{ id: string; status: string; latitude: string }>('SELECT id, status, latitude FROM testimonials');
  assert.equal(record.status, 'pending'); assert.equal(Number(record.latitude), 12.123);

  // 3. Nothing is public yet: the wall is empty and the photo is 404.
  assert.equal((await visitor.get('/api/testimonials').expect(200)).body.total, 0);
  await visitor.get(`/api/photos/${record.id}`).expect(404);
  // ...and the export is off-limits without a session.
  await visitor.get('/api/admin/export').expect(401);

  // 4. Admin login: wrong password fails; correct one succeeds and issues a
  //    hardened cookie (HttpOnly, SameSite=Strict) plus a CSRF token.
  await admin.post('/api/admin/login').set('Origin', adminOrigin).send({ email: 'owner@example.test', password: 'incorrect' }).expect(401);
  const session = await admin.post('/api/admin/login').set('Origin', adminOrigin).send({ email: 'owner@example.test', password }).expect(200);
  const csrf = session.body.csrfToken;
  assert.match(session.headers['set-cookie'][0], /HttpOnly/i);
  assert.match(session.headers['set-cookie'][0], /SameSite=Strict/i);
  await admin.get('/api/admin/session').expect(200);

  // 5. Pending photos are visible to the authenticated admin but not the public.
  await admin.get(`/api/photos/${record.id}`).expect(200).expect('Content-Type', /webp/);

  // 6. Admin write REQUIRES BOTH the admin origin AND the CSRF token — we
  //    verify each failure mode before the approach that works.
  const approved = { ...payload, status: 'approved' };
  await admin.patch(`/api/admin/testimonials/${record.id}`).set('Origin', adminOrigin).send(approved).expect(403);
  await admin.patch(`/api/admin/testimonials/${record.id}`).set('Origin', 'https://evil.test').set('X-CSRF-Token', csrf).send(approved).expect(403);
  await admin.patch(`/api/admin/testimonials/${record.id}`).set('Origin', adminOrigin).set('X-CSRF-Token', csrf).send(approved).expect(200);

  // 7. Approved ⇒ public. Privacy: none of the private metadata leaks.
  const published = (await visitor.get('/api/testimonials').expect(200)).body;
  assert.equal(published.total, 1);
  assert.equal(published.items[0].companyUrl, payload.companyUrl);
  for (const privateField of ['latitude', 'longitude', 'location_accuracy', 'client_submitted_at', 'client_timezone', 'photo_filename']) assert.equal(privateField in published.items[0], false);
  await visitor.get(`/api/photos/${record.id}`).expect(200);

  // 8. Export: the '='-prefixed name is neutralised → "'=Anika", and the
  //    company URL survives CSV quoting intact.
  const csv = await admin.get('/api/admin/export?status=approved').expect(200);
  assert.ok(csv.text.includes('"\'=Anika"'));
  assert.ok(csv.text.includes(`"${payload.companyUrl}"`));

  // 9. Search + filter by status; per-status counts are reported.
  const list = (await admin.get('/api/admin/testimonials?sort=name_asc&search=Anika').expect(200)).body;
  assert.equal(list.total, 1); assert.equal(list.counts.approved, 1);

  // 10. Unpublish (status → rejected): vanishes from the public wall + photo.
  await admin.patch(`/api/admin/testimonials/${record.id}`).set('Origin', adminOrigin).set('X-CSRF-Token', csrf).send({ ...approved, name: 'Anika Rao', status: 'rejected' }).expect(200);
  assert.equal((await visitor.get('/api/testimonials').expect(200)).body.total, 0);
  await visitor.get(`/api/photos/${record.id}`).expect(404);

  // 11. Soft delete: gone everywhere, but the row survives with deleted_at set.
  await admin.delete(`/api/admin/testimonials/${record.id}`).set('Origin', adminOrigin).set('X-CSRF-Token', csrf).expect(204);
  assert.equal((await admin.get('/api/admin/testimonials').expect(200)).body.total, 0);
  await admin.get(`/api/photos/${record.id}`).expect(404);
  const [archived] = await rows<{ deleted_at: Date }>('SELECT deleted_at FROM testimonials WHERE id = ?', [record.id]);
  assert.ok(archived.deleted_at);

  // 12. Logout revokes the session on the server, so the next call is 401.
  await admin.post('/api/admin/logout').set('Origin', adminOrigin).set('X-CSRF-Token', csrf).expect(204);
  await admin.get('/api/admin/session').expect(401);

  // 13. A second submission WITHOUT a photo or location is equally valid.
  const { location: _location, ...noLocation } = payload;
  await visitor.post('/api/testimonials').set('Origin', publicOrigin).field('payload', JSON.stringify(noLocation)).expect(201);
});
test.after(async () => { await pool.end(); await rm(uploads, { recursive: true, force: true }); });