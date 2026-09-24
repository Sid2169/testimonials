// Centralised environment-variable handling.
//
// Everything the API needs to know about its surroundings arrives through
// environment variables (e.g. the port to listen on, database credentials,
// allowed browser origins). This file is the single place that reads and
// validates them, so the rest of the code can import the typed `config`
// object and trust that values were already checked at startup.

import 'dotenv/config'; // Loads variables from apps/api/.env when present (never committed).
import path from 'node:path';
import { z } from 'zod';

// Describe every environment variable as a strict schema. Running .parse()
// below fails fast at startup with a clear message instead of letting the
// server boot with a broken or missing setting. `.default(...)` supplies a
// safe value when the variable is absent.
const env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_USER: z.string().default('testimonials'),
  // No default: the database password must always be supplied explicitly.
  DB_PASSWORD: z.string().min(1, 'Set DB_PASSWORD in apps/api/.env'),
  DB_NAME: z.string().regex(/^[a-zA-Z0-9_]+$/).default('testimonials'),
  // Accept the string "true"/"false" from the environment and turn it into a boolean.
  DB_SSL: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  // The exact browser origins (scheme + host, no trailing slash) that are
  // allowed to submit testimonials / sign in. Used later for Origin checks.
  PUBLIC_ORIGIN: z.url().default('http://localhost:5173'),
  ADMIN_ORIGIN: z.url().default('http://localhost:5174'),
  // Where to store resized photos: the local disk or S3-compatible object storage.
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  UPLOAD_DIR: z.string().default('./uploads'),
  // S3 settings are only meaningful when STORAGE_DRIVER=s3 (see superRefine below).
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // How many reverse proxies sit in front of the API. Used to resolve the
  // real client IP for rate limiting. 0 locally; 1 behind the bundled Caddy.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
}).superRefine((value, context) => {
  // Cross-field validation: the S3 credentials are only required when the
  // object-storage driver was explicitly selected.
  if (value.STORAGE_DRIVER !== 's3') return;
  for (const key of ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
    if (!value[key]) context.addIssue({ code: 'custom', path: [key], message: `${key} is required when STORAGE_DRIVER=s3` });
  }
  // Object storage must be reached over TLS; plain HTTP could leak credentials.
  if (value.S3_ENDPOINT && !value.S3_ENDPOINT.startsWith('https://')) {
    context.addIssue({ code: 'custom', path: ['S3_ENDPOINT'], message: 'S3_ENDPOINT must use HTTPS' });
  }
}).parse(process.env);

// The validated, ready-to-use configuration. A few values receive light
// post-processing to make them convenient for the rest of the app:
// - UPLOAD_DIR is resolved to an absolute path (paths with `.`/`..` and
//   trailing slashes are normalised), so files land where expected regardless
//   of the process's current working directory.
// - origins become full `URL` objects; `.origin` always strips a trailing
//   slash so configured and incoming origins compare reliably.
// - the session cookie gets a different name in production. The `__Host-`
//   prefix opts into stricter cookie handling that only browsers on HTTPS
//   accept, a protection we can use because production runs over HTTPS.
export const config = {
  ...env,
  UPLOAD_DIR: path.resolve(env.UPLOAD_DIR),
  PUBLIC_ORIGIN: new URL(env.PUBLIC_ORIGIN).origin,
  ADMIN_ORIGIN: new URL(env.ADMIN_ORIGIN).origin,
  cookieName: env.NODE_ENV === 'production' ? '__Host-testimonials_session' : 'testimonials_session',
};
// In production the API talks to browsers over HTTPS, so session cookies must
// be Secure (they would be dropped over plain HTTP). Refuse to boot if the
// configured origins are not HTTPS, otherwise login would silently break.
if (env.NODE_ENV === 'production' && [env.PUBLIC_ORIGIN, env.ADMIN_ORIGIN].some(x => !x.startsWith('https://'))) {
  throw new Error('Production origins must use HTTPS.');
}