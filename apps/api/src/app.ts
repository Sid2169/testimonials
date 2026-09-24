// The Express application: every HTTP route, middleware, and error handling.
//
// Express apps are built from middleware: functions that run in order and can
// end a response or call `next()` to pass the request on. Below you'll see
// the middleware pipeline (security, rate limiting, auth) built for each
// /api route. This file is intentionally one place: it reads like an index of
// the whole backend.

import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import { execute, rows, type SqlValue } from './db.js';
import { cookieOptions, findSession, hashToken, randomToken, requireAdmin, requireCsrf, requireOrigin } from './auth.js';
import { submission, edit, listing, orderBy, csvCell } from './validation.js';
import { savePhoto, readPhoto, deletePhoto, BadPhoto, PhotoNotFound } from './photos.js';

// Columns safe to expose to the PUBLIC API. Everything sensitive — status,
// location, timestamps, timezone, filename — is intentionally omitted here
// and in the projects' shared helper.
const publicColumns = 'id, name, view, company, company_url, designation, linkedin, created_at, photo_filename';

// Reshape a raw database row into a public/client-safe object: rename
// snake_case columns to camelCase and swap the filename for a public URL
// (photos are private until a testimonial is approved; the route enforces
// that, not this helper).
function present(row: Record<string, unknown>) {
  const { photo_filename, company_url, ...rest } = row;
  return { ...rest, companyUrl: company_url ?? '', photoUrl: photo_filename ? `/api/photos/${row.id}` : null };
}

// Build the WHERE clause (and params) for admin listing/export. `where` is
// always a fixed string; user input only ever arrives as bound parameters.
// The `search` filter is a literal substring match — a visitor's text can
// never become SQL or wildcard syntax.
function queryFilter(query: z.infer<typeof listing>) {
  let where = 'deleted_at IS NULL';
  const params: SqlValue[] = [];
  if (query.status !== 'all') { where += ' AND status = ?'; params.push(query.status); }
  if (query.search) {
    // Literal substring search: user input never becomes SQL or wildcard syntax.
    where += ' AND (LOCATE(?, name) > 0 OR LOCATE(?, company) > 0 OR LOCATE(?, view) > 0)';
    params.push(query.search, query.search, query.search);
  }
  return { where, params };
}

// createApp() builds and returns a configured Express app. Returning it from
// a function (instead of exporting the app directly) lets tests spin up
// isolated instances and keeps startup side effects out.
export function createApp() {
  const app = express();

  // --- Global (non-route) middleware -------------------------------------
  app.disable('x-powered-by'); // Don't advertise Express to curious clients.
  // Trust the IP given in X-Forwarded-For this many hops, so rate limiting
  // keys on the real client IP when the app sits behind a proxy.
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  // helmet() sets a bundle of safe HTTP response headers (CSP, HSTS, etc.).
  app.use(helmet());
  app.use(cookieParser());
  // Never cache /api responses: testimonial data changes and must always be fresh.
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // Global per-IP rate limit: 180 requests/minute covers the whole API.
  // standardHeaders emit the standard RateLimit-* headers for tooling.
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Please try again in a minute.' } }));
  // Parse JSON bodies (admin login/edit) with a small cap, so a huge body
  // can't exhaust memory. Multipart (photo submissions) is handled per-route.
  app.use(express.json({ limit: '32kb' }));

  // --- Public routes -----------------------------------------------------

  // Health check: a simple SELECT proves the DB connection works. 200=ok, 503=down.
  app.get('/api/health', async (_req, res) => {
    try { await rows('SELECT 1'); res.json({ status: 'ok' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });

  // Paginated, filterable wall of APPROVED testimonials (public).
  app.get('/api/testimonials', async (req, res) => {
    const query = listing.parse(req.query);
    // Two queries: one for the total (drives the page count), one for the page.
    const [count] = await rows<{ total: number }>("SELECT COUNT(*) AS total FROM testimonials WHERE status = 'approved' AND deleted_at IS NULL");
    const data = await rows<Record<string, unknown>>(`SELECT ${publicColumns} FROM testimonials WHERE status = 'approved' AND deleted_at IS NULL ORDER BY ${orderBy[query.sort]} LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`);
    res.json({ items: data.map(present), total: count.total, page: query.page, limit: query.limit });
  });

  // Photo upload settings: held in memory (never on disk) and bounded —
  // one file, max 5 MB, one 32 KB text field. Rejecting here (with a custom
  // BadPhoto error) happens before any decoding work.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, fieldSize: 32 * 1024, parts: 2 },
    fileFilter: (_req, file, done) => {
      if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) done(null, true);
      else done(new BadPhoto('Choose a JPEG, PNG, or WebP photo.'));
    },
  });

  // Submit a testimonial. Guarded by (in order):
  //  - an Origin check (only the public site may POST here),
  //  - an overall hourly cap and a stricter per-IP cap,
  //  - Multer parsing the multipart body into req.file + req.body.payload.
  app.post('/api/testimonials',
    requireOrigin([config.PUBLIC_ORIGIN]),
    rateLimit({ windowMs: 60 * 60_000, limit: 60, keyGenerator: () => 'global-submissions', standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Submissions are temporarily busy. Please try again in an hour.' } }),
    rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'You have reached the submission limit. Please try again in an hour.' } }),
    upload.single('photo'), async (req, res) => {
      // The visible form fields arrive as a JSON string inside 'payload'.
      let payload: unknown;
      try { payload = JSON.parse(req.body?.payload ?? ''); }
      catch { res.status(400).json({ error: 'The testimonial form is invalid.' }); return; }
      const data = submission.parse(payload);
      // Honeypot: real users never fill the hidden 'website' field. When it
      // has a value this is a bot, so respond with a fake success — the bot
      // thinks it "worked", real people never notice. No row is inserted.
      if (data.website) { res.status(201).json({ message: 'Thank you. Your testimonial has been received.' }); return; }
      // Re-encode + persist the photo FIRST; only then write the row, so the
      // two never end up out of sync.
      const filename = await savePhoto(req.file);
      const id = randomUUID();
      try {
        // Coordinates are rounded to 3 decimals at save time (browser already
        // rounds, but this is authoritative). Everything is parameterised —
        // no user string ever touches the SQL text.
        await execute(`INSERT INTO testimonials (id, name, view, company, company_url, designation, linkedin, photo_filename, latitude, longitude, location_accuracy, client_submitted_at, client_timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, data.name, data.view, data.company, data.companyUrl, data.designation, data.linkedin, filename,
            data.location ? Number(data.location.latitude.toFixed(3)) : null,
            data.location ? Number(data.location.longitude.toFixed(3)) : null,
            data.location?.accuracy ?? null, data.clientSubmittedAt, data.clientTimezone]);
      } catch (error) {
        // Keep the DB and storage consistent: if the row insert fails, remove
        // the photo we just stored. (.catch(() => {}) — best-effort cleanup.)
        if (filename) await deletePhoto(filename).catch(() => {});
        throw error;
      }
      res.status(201).json({ message: 'Thank you! Your testimonial is awaiting review.' });
    },
  );

  // Serve a testimonial's photo. Public only when approved; pending/rejected
  // photos are private and require a signed-in session (the admin reviewing).
  app.get('/api/photos/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const [record] = await rows<{ status: string; photo_filename: string | null }>('SELECT status, photo_filename FROM testimonials WHERE id = ? AND deleted_at IS NULL', [id]);
    // 404 (not 403) for anything missing/forbidden — don't reveal existence.
    if (!record?.photo_filename || (record.status !== 'approved' && !await findSession(req.cookies[config.cookieName]))) {
      res.status(404).json({ error: 'Photo not found.' }); return;
    }
    try {
      const photo = await readPhoto(record.photo_filename);
      res.type('webp').send(photo);
    } catch (error) {
      if (error instanceof PhotoNotFound) { res.status(404).json({ error: 'Photo not found.' }); return; }
      throw error;
    }
  });

  // --- Admin auth --------------------------------------------------------

  // Sign in with the single admin account. Origin restricted to the admin
  // site, plus an overall and per-IP attempt ceiling.
  app.post('/api/admin/login', requireOrigin([config.ADMIN_ORIGIN]),
    rateLimit({ windowMs: 15 * 60_000, limit: 100, keyGenerator: () => 'global-login', standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Sign-in is temporarily limited. Please try again in 15 minutes.' } }),
    rateLimit({ windowMs: 15 * 60_000, limit: 5, skipSuccessfulRequests: true, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Please try again in 15 minutes.' } }),
    async (req, res) => {
      const credentials = z.object({ email: z.email().max(254), password: z.string().min(1).refine(value => Buffer.byteLength(value) <= 72, 'Incorrect email or password.') }).parse(req.body);
      const [admin] = await rows<{ email: string; password_hash: string }>('SELECT email, password_hash FROM admins WHERE id = 1');
      // Compare against a fixed cost-12 dummy hash when no admin is set up:
      // bcrypt still runs, so the timing stays identical and an attacker can't
      // tell "no account exists" apart from "wrong password".
      const valid = await bcrypt.compare(credentials.password, admin?.password_hash ?? '$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW');
      // Always the same message for wrong email AND wrong password — no hints.
      if (!valid || !admin || admin.email !== credentials.email.toLowerCase()) {
        res.status(401).json({ error: 'Incorrect email or password.' }); return;
      }
      // Rotate/limit live sessions: purge expired rows, invalidate any old
      // cookie so there is exactly one active session per login.
      await execute('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP(3)');
      const oldCookie = req.cookies[config.cookieName];
      if (typeof oldCookie === 'string') await execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(oldCookie)]);
      // Issue fresh token pairs and remember only the token's hash.
      const token = randomToken();
      const csrfToken = randomToken();
      await execute('INSERT INTO sessions (token_hash, csrf_token, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 12 HOUR))', [hashToken(token), csrfToken]);
      // The raw token goes into an HttpOnly cookie; the CSRF token goes to JS
      // because the admin page must echo it back in the X-CSRF-Token header.
      res.cookie(config.cookieName, token, { ...cookieOptions, maxAge: 12 * 60 * 60_000 });
      res.json({ email: admin.email, csrfToken });
    },
  );

  // Everything from here down is admin-only.
  app.use('/api/admin', requireAdmin);

  // Returns the current session's admin email + CSRF token (used on boot to
  // decide whether to show the login screen or the dashboard).
  app.get('/api/admin/session', async (_req, res) => {
    const [admin] = await rows<{ email: string }>('SELECT email FROM admins WHERE id = 1');
    res.json({ email: admin.email, csrfToken: res.locals.session.csrf_token });
  });

  // Admin WRITES additionally need the correct Origin and a valid CSRF token.
  // Safe methods (GET/HEAD/OPTIONS) skip both checks; they carry no state.
  app.use('/api/admin', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
    requireOrigin([config.ADMIN_ORIGIN])(req, res, () => requireCsrf(req, res, next));
  });

  // Sign out: delete this session row and clear the cookie.
  app.post('/api/admin/logout', async (_req, res) => {
    await execute('DELETE FROM sessions WHERE token_hash = ?', [res.locals.session.token_hash]);
    res.clearCookie(config.cookieName, cookieOptions).sendStatus(204);
  });

  // --- Admin data routes -------------------------------------------------

  // Admin list: paginated, searchable, filterable by status, with per-status
  // counts for the dashboard cards. Uses the shared queryFilter() OF WHICH
  // count/search/status checks the `deleted_at` scope — soft-deleted rows
  // never appear here.
  app.get('/api/admin/testimonials', async (req, res) => {
    const query = listing.parse(req.query);
    const { where, params } = queryFilter(query);
    const [count] = await rows<{ total: number }>(`SELECT COUNT(*) AS total FROM testimonials WHERE ${where}`, params);
    const data = await rows<Record<string, unknown>>(`SELECT * FROM testimonials WHERE ${where} ORDER BY ${orderBy[query.sort]} LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`, params);
    const counts = await rows<{ status: string; total: number }>('SELECT status, COUNT(*) AS total FROM testimonials WHERE deleted_at IS NULL GROUP BY status');
    res.json({ items: data.map(present), total: count.total, page: query.page, limit: query.limit, counts: Object.fromEntries(counts.map(x => [x.status, x.total])) });
  });

  // Download the current filter selection as CSV (max 10,000 rows, with a
  // UTF-8 BOM so Excel interprets it correctly). Values are escaped by
  // csvCell() which also blocks spreadsheet-formula injection.
  app.get('/api/admin/export', async (req, res) => {
    const query = listing.parse(req.query);
    const { where, params } = queryFilter(query);
    const columns = ['id', 'name', 'view', 'company', 'company_url', 'designation', 'linkedin', 'status', 'created_at', 'client_submitted_at', 'client_timezone', 'latitude', 'longitude', 'location_accuracy'];
    const data = await rows<Record<string, unknown>>(`SELECT ${columns.join(', ')} FROM testimonials WHERE ${where} ORDER BY ${orderBy[query.sort]} LIMIT 10001`, params);
    if (data.length > 10000) { res.status(422).json({ error: 'Export is limited to 10,000 testimonials. Narrow your search or status filter.' }); return; }
    res.setHeader('Content-Disposition', 'attachment; filename="testimonials.csv"');
    res.type('text/csv').send('\uFEFF' + [columns.map(csvCell).join(','), ...data.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\r\n'));
  });

  // Edit a testimonial's fields and publication status (approve/unpublish).
  app.patch('/api/admin/testimonials/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const data = edit.parse(req.body);
    const result = await execute('UPDATE testimonials SET name = ?, view = ?, company = ?, company_url = ?, designation = ?, linkedin = ?, status = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND deleted_at IS NULL', [data.name, data.view, data.company, data.companyUrl, data.designation, data.linkedin, data.status, id]);
    if (!result.affectedRows) { res.status(404).json({ error: 'Testimonial not found.' }); return; }
    res.json({ message: 'Testimonial updated.' });
  });

  // Soft delete: hide everywhere but keep the row (recoverable). Photos stay
  // on disk; public routes already filter out deleted_at IS NOT NULL.
  app.delete('/api/admin/testimonials/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const result = await execute('UPDATE testimonials SET deleted_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!result.affectedRows) { res.status(404).json({ error: 'Testimonial not found.' }); return; }
    res.sendStatus(204);
  });

  // --- Catch-all 404 + error handler -------------------------------------

  // Anything not matched above → JSON 404. (Admin handles are guarded earlier,
  // so unknown admin paths fall through to here.)
  app.use((_req, res) => { res.status(404).json({ error: 'Route not found.' }); });

  // The final safety net. Express funnels EVERY error (thrown in a handler,
  // rejected promise, Multer/Zod/JSON problems) into this handler, mapping
  // each kind to a clean user-facing status. Never leaks internals.
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) {
      // Validation failures produce a specific message and the offending fields.
      res.status(400).json({ error: error.issues[0]?.message ?? 'Please check the form.', fields: error.flatten().fieldErrors });
    } else if (error instanceof multer.MulterError || error instanceof BadPhoto) {
      // Upload problems: the 5 MB limit and invalid formats get tailored text.
      res.status(400).json({ error: error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 'Your photo must be 5 MB or smaller.' : error instanceof BadPhoto ? error.message : 'Invalid upload. Use one photo under 5 MB.' });
    } else if (error.type === 'entity.too.large') {
      res.status(413).json({ error: 'Your request is too large.' });
    } else if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: 'Invalid JSON request.' });
    } else {
      // Unknown errors: log only the error NAME (never request bodies,
      // credentials, SQL values, or client coordinates), and reply generically.
      console.error('Request failed:', error instanceof Error ? error.name : 'Unknown error');
      res.status(500).json({ error: 'Something went wrong. Please try again shortly.' });
    }
  };
  app.use(errorHandler);
  return app;
}