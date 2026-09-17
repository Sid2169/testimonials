import { createHash, randomBytes } from 'node:crypto';
import type { RequestHandler, CookieOptions } from 'express';
import { config } from './config.js';
import { rows } from './db.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const randomToken = () => randomBytes(32).toString('hex');
export const cookieOptions: CookieOptions = {
  httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict', path: '/',
};
export async function findSession(cookie: unknown) {
  if (typeof cookie !== 'string' || !/^[a-f0-9]{64}$/.test(cookie)) return null;
  const [session] = await rows<{ token_hash: string; csrf_token: string }>(
    'SELECT token_hash, csrf_token FROM sessions WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP(3)', [hashToken(cookie)],
  );
  return session ?? null;
}
export const requireAdmin: RequestHandler = async (req, res, next) => {
  const session = await findSession(req.cookies[config.cookieName]);
  if (!session) { res.status(401).json({ error: 'Please sign in to continue.' }); return; }
  res.locals.session = session;
  next();
};
export const requireCsrf: RequestHandler = (req, res, next) => {
  if (req.get('x-csrf-token') !== res.locals.session.csrf_token) {
    res.status(403).json({ error: 'Your session could not be verified. Refresh and try again.' }); return;
  }
  next();
};
export const requireOrigin = (allowed: string[]): RequestHandler => (req, res, next) => {
  if (!allowed.includes(req.get('origin') ?? '')) {
    res.status(403).json({ error: 'This request origin is not allowed.' }); return;
  }
  next();
};
