// Authentication & request guards.
//
// The site uses cookie-based sessions: after a successful login the API hands
// the browser an opaque random token in an HttpOnly cookie, and remembers only
// its SHA-256 hash (plus a CSRF token) in the `sessions` table. Every
// subsequent private request sends the cookie back; these helpers verify it,
// attach the session to `res.locals`, and apply CSRF/origin checks.

import { createHash, randomBytes } from 'node:crypto';
import type { RequestHandler, CookieOptions } from 'express';
import { config } from './config.js';
import { rows } from './db.js';

// Never store the raw session token. Hashes make a leaked database useless to
// an attacker, while still being fine to look up.
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
// 32 random bytes ≈ 64 hexadecimal characters, cryptographically secure enough
// for session tokens and CSRF tokens.
export const randomToken = () => randomBytes(32).toString('hex');

// Settings applied to the session cookie. HttpOnly keeps it away from
// JavaScript, SameSite=Strict stops cross-site requests carrying it, and
// 'secure' only over HTTPS (never in development where we run HTTP).
export const cookieOptions: CookieOptions = {
  httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict', path: '/',
};

// Look up a session from the raw cookie value, or null when invalid/expired.
// Returning null tells callers "not signed in" without revealing why.
export async function findSession(cookie: unknown) {
  // Unknown/`unknown` cookies are ignored. A valid token is exactly 64 hex
  // chars; anything else can be rejected without touching the database.
  // (The check also prevents a malformed or huge input from being hashed.)
  if (typeof cookie !== 'string' || !/^[a-f0-9]{64}$/.test(cookie)) return null;
  const [session] = await rows<{ token_hash: string; csrf_token: string }>(
    'SELECT token_hash, csrf_token FROM sessions WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP(3)', [hashToken(cookie)],
  );
  return session ?? null;
}

// Route guard for everything under /api/admin. Rejects unauthenticated
// requests with 401 and stores the found session on res.locals for later use.
export const requireAdmin: RequestHandler = async (req, res, next) => {
  const session = await findSession(req.cookies[config.cookieName]);
  if (!session) { res.status(401).json({ error: 'Please sign in to continue.' }); return; }
  res.locals.session = session;
  next();
};

// Same-site cookies block most cross-site requests, but a malicious page could
// still script a request directly to the admin API. CSRF protection closes
// that gap: the page must send the X-CSRF-Token header that only the real
// session knows, and which JavaScript in other origins cannot read.
export const requireCsrf: RequestHandler = (req, res, next) => {
  if (req.get('x-csrf-token') !== res.locals.session.csrf_token) {
    res.status(403).json({ error: 'Your session could not be verified. Refresh and try again.' }); return;
  }
  next();
};

// Only accept requests whose Origin header is in the allowlist. Since the
// API must not answer requests from unrelated websites, each pointed origin
// (the public site or the admin) is compared against its configured value.
export const requireOrigin = (allowed: string[]): RequestHandler => (req, res, next) => {
  if (!allowed.includes(req.get('origin') ?? '')) {
    res.status(403).json({ error: 'This request origin is not allowed.' }); return;
  }
  next();
};