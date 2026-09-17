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
  DB_SSL: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  PUBLIC_ORIGIN: z.url().default('http://localhost:5173'),
  ADMIN_ORIGIN: z.url().default('http://localhost:5174'),
  STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
  UPLOAD_DIR: z.string().default('./uploads'),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
}).superRefine((value, context) => {
  if (value.STORAGE_DRIVER !== 'r2') return;
  for (const key of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const) {
    if (!value[key]) context.addIssue({ code: 'custom', path: [key], message: `${key} is required when STORAGE_DRIVER=r2` });
  }
}).parse(process.env);

export const config = {
  ...env,
  UPLOAD_DIR: path.resolve(env.UPLOAD_DIR),
  PUBLIC_ORIGIN: new URL(env.PUBLIC_ORIGIN).origin,
  ADMIN_ORIGIN: new URL(env.ADMIN_ORIGIN).origin,
  R2_ENDPOINT: env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined,
  cookieName: env.NODE_ENV === 'production' ? '__Host-testimonials_session' : 'testimonials_session',
};
if (env.NODE_ENV === 'production' && [env.PUBLIC_ORIGIN, env.ADMIN_ORIGIN].some(x => !x.startsWith('https://'))) {
  throw new Error('Production origins must use HTTPS.');
}
