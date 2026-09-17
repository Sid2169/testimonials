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

const publicColumns = 'id, name, view, company, designation, linkedin, created_at, photo_filename';
function present(row: Record<string, unknown>) {
  const { photo_filename, ...rest } = row;
  return { ...rest, photoUrl: photo_filename ? `/api/photos/${row.id}` : null };
}
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

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(helmet());
  app.use(cookieParser());
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Please try again in a minute.' } }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', async (_req, res) => {
    try { await rows('SELECT 1'); res.json({ status: 'ok' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });

  app.get('/api/testimonials', async (req, res) => {
    const query = listing.parse(req.query);
    const [count] = await rows<{ total: number }>("SELECT COUNT(*) AS total FROM testimonials WHERE status = 'approved' AND deleted_at IS NULL");
    const data = await rows<Record<string, unknown>>(`SELECT ${publicColumns} FROM testimonials WHERE status = 'approved' AND deleted_at IS NULL ORDER BY ${orderBy[query.sort]} LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`);
    res.json({ items: data.map(present), total: count.total, page: query.page, limit: query.limit });
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, fieldSize: 32 * 1024, parts: 2 },
    fileFilter: (_req, file, done) => {
      if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) done(null, true);
      else done(new BadPhoto('Choose a JPEG, PNG, or WebP photo.'));
    },
  });
  app.post('/api/testimonials',
    requireOrigin([config.PUBLIC_ORIGIN]),
    rateLimit({ windowMs: 60 * 60_000, limit: 60, keyGenerator: () => 'global-submissions', standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Submissions are temporarily busy. Please try again in an hour.' } }),
    rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'You have reached the submission limit. Please try again in an hour.' } }),
    upload.single('photo'), async (req, res) => {
      let payload: unknown;
      try { payload = JSON.parse(req.body?.payload ?? ''); }
      catch { res.status(400).json({ error: 'The testimonial form is invalid.' }); return; }
      const data = submission.parse(payload);
      if (data.website) { res.status(201).json({ message: 'Thank you. Your testimonial has been received.' }); return; }
      const filename = await savePhoto(req.file);
      const id = randomUUID();
      try {
        await execute(`INSERT INTO testimonials (id, name, view, company, designation, linkedin, photo_filename, latitude, longitude, location_accuracy, client_submitted_at, client_timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, data.name, data.view, data.company, data.designation, data.linkedin, filename,
            data.location ? Number(data.location.latitude.toFixed(3)) : null,
            data.location ? Number(data.location.longitude.toFixed(3)) : null,
            data.location?.accuracy ?? null, data.clientSubmittedAt, data.clientTimezone]);
      } catch (error) {
        if (filename) await deletePhoto(filename).catch(() => {});
        throw error;
      }
      res.status(201).json({ message: 'Thank you! Your testimonial is awaiting review.' });
    },
  );

  app.get('/api/photos/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const [record] = await rows<{ status: string; photo_filename: string | null }>('SELECT status, photo_filename FROM testimonials WHERE id = ? AND deleted_at IS NULL', [id]);
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

  app.post('/api/admin/login', requireOrigin([config.ADMIN_ORIGIN]),
    rateLimit({ windowMs: 15 * 60_000, limit: 100, keyGenerator: () => 'global-login', standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Sign-in is temporarily limited. Please try again in 15 minutes.' } }),
    rateLimit({ windowMs: 15 * 60_000, limit: 5, skipSuccessfulRequests: true, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Please try again in 15 minutes.' } }),
    async (req, res) => {
      const credentials = z.object({ email: z.email().max(254), password: z.string().min(1).refine(value => Buffer.byteLength(value) <= 72, 'Incorrect email or password.') }).parse(req.body);
      const [admin] = await rows<{ email: string; password_hash: string }>('SELECT email, password_hash FROM admins WHERE id = 1');
      // A valid cost-12 dummy hash preserves password work when no admin is configured.
      const valid = await bcrypt.compare(credentials.password, admin?.password_hash ?? '$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW');
      if (!valid || !admin || admin.email !== credentials.email.toLowerCase()) {
        res.status(401).json({ error: 'Incorrect email or password.' }); return;
      }
      await execute('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP(3)');
      const oldCookie = req.cookies[config.cookieName];
      if (typeof oldCookie === 'string') await execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(oldCookie)]);
      const token = randomToken();
      const csrfToken = randomToken();
      await execute('INSERT INTO sessions (token_hash, csrf_token, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 12 HOUR))', [hashToken(token), csrfToken]);
      res.cookie(config.cookieName, token, { ...cookieOptions, maxAge: 12 * 60 * 60_000 });
      res.json({ email: admin.email, csrfToken });
    },
  );

  app.use('/api/admin', requireAdmin);
  app.get('/api/admin/session', async (_req, res) => {
    const [admin] = await rows<{ email: string }>('SELECT email FROM admins WHERE id = 1');
    res.json({ email: admin.email, csrfToken: res.locals.session.csrf_token });
  });
  app.use('/api/admin', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
    requireOrigin([config.ADMIN_ORIGIN])(req, res, () => requireCsrf(req, res, next));
  });
  app.post('/api/admin/logout', async (_req, res) => {
    await execute('DELETE FROM sessions WHERE token_hash = ?', [res.locals.session.token_hash]);
    res.clearCookie(config.cookieName, cookieOptions).sendStatus(204);
  });
  app.get('/api/admin/testimonials', async (req, res) => {
    const query = listing.parse(req.query);
    const { where, params } = queryFilter(query);
    const [count] = await rows<{ total: number }>(`SELECT COUNT(*) AS total FROM testimonials WHERE ${where}`, params);
    const data = await rows<Record<string, unknown>>(`SELECT * FROM testimonials WHERE ${where} ORDER BY ${orderBy[query.sort]} LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`, params);
    const counts = await rows<{ status: string; total: number }>('SELECT status, COUNT(*) AS total FROM testimonials WHERE deleted_at IS NULL GROUP BY status');
    res.json({ items: data.map(present), total: count.total, page: query.page, limit: query.limit, counts: Object.fromEntries(counts.map(x => [x.status, x.total])) });
  });
  app.get('/api/admin/export', async (req, res) => {
    const query = listing.parse(req.query);
    const { where, params } = queryFilter(query);
    const columns = ['id', 'name', 'view', 'company', 'designation', 'linkedin', 'status', 'created_at', 'client_submitted_at', 'client_timezone', 'latitude', 'longitude', 'location_accuracy'];
    const data = await rows<Record<string, unknown>>(`SELECT ${columns.join(', ')} FROM testimonials WHERE ${where} ORDER BY ${orderBy[query.sort]} LIMIT 10001`, params);
    if (data.length > 10000) { res.status(422).json({ error: 'Export is limited to 10,000 testimonials. Narrow your search or status filter.' }); return; }
    res.setHeader('Content-Disposition', 'attachment; filename="testimonials.csv"');
    res.type('text/csv').send('\uFEFF' + [columns.map(csvCell).join(','), ...data.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\r\n'));
  });
  app.patch('/api/admin/testimonials/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const data = edit.parse(req.body);
    const result = await execute('UPDATE testimonials SET name = ?, view = ?, company = ?, designation = ?, linkedin = ?, status = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND deleted_at IS NULL', [data.name, data.view, data.company, data.designation, data.linkedin, data.status, id]);
    if (!result.affectedRows) { res.status(404).json({ error: 'Testimonial not found.' }); return; }
    res.json({ message: 'Testimonial updated.' });
  });
  app.delete('/api/admin/testimonials/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const result = await execute('UPDATE testimonials SET deleted_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!result.affectedRows) { res.status(404).json({ error: 'Testimonial not found.' }); return; }
    res.sendStatus(204);
  });

  app.use((_req, res) => { res.status(404).json({ error: 'Route not found.' }); });
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: error.issues[0]?.message ?? 'Please check the form.', fields: error.flatten().fieldErrors });
    } else if (error instanceof multer.MulterError || error instanceof BadPhoto) {
      res.status(400).json({ error: error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 'Your photo must be 5 MB or smaller.' : error instanceof BadPhoto ? error.message : 'Invalid upload. Use one photo under 5 MB.' });
    } else if (error.type === 'entity.too.large') {
      res.status(413).json({ error: 'Your request is too large.' });
    } else if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: 'Invalid JSON request.' });
    } else {
      // Avoid logging request bodies, credentials, SQL values, or client coordinates.
      console.error('Request failed:', error instanceof Error ? error.name : 'Unknown error');
      res.status(500).json({ error: 'Something went wrong. Please try again shortly.' });
    }
  };
  app.use(errorHandler);
  return app;
}
