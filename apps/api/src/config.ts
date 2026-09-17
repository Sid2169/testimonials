import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_USER: z.string().default('testimonials'),
  DB_PASSWORD: z.string().min(1, 'Set DB_PASSWORD in apps/api/.env'),
  DB_NAME: z.string().regex(/^[a-zA-Z0-9_]+$/).default('testimonials'),
  PUBLIC_ORIGIN: z.url().default('http://localhost:5173'),
  ADMIN_ORIGIN: z.url().default('http://localhost:5174'),
  UPLOAD_DIR: z.string().default('./uploads'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
}).parse(process.env);

export const config = {
  ...env,
  UPLOAD_DIR: path.resolve(env.UPLOAD_DIR),
  PUBLIC_ORIGIN: new URL(env.PUBLIC_ORIGIN).origin,
  ADMIN_ORIGIN: new URL(env.ADMIN_ORIGIN).origin,
  cookieName: env.NODE_ENV === 'production' ? '__Host-testimonials_session' : 'testimonials_session',
};
if (env.NODE_ENV === 'production' && [env.PUBLIC_ORIGIN, env.ADMIN_ORIGIN].some(x => !x.startsWith('https://'))) {
  throw new Error('Production origins must use HTTPS.');
}
