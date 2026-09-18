import { z } from 'zod';

export const fields = z.object({
  name: z.string().trim().min(1, 'Please enter your name.').max(100),
  view: z.string().trim().min(10, 'Please write at least 10 characters.').max(3000),
  company: z.string().trim().max(150).default(''),
  companyUrl: z.string().trim().max(500).default('').refine(value => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch { return false; }
  }, 'Use a secure company website URL beginning with https://.'),
  designation: z.string().trim().max(150).default(''),
  linkedin: z.string().trim().max(500).default('').refine(value => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['linkedin.com', 'www.linkedin.com'].includes(url.hostname) && !url.username && !url.password && !url.port && /^\/in\/[^/]+\/?$/.test(url.pathname);
    } catch { return false; }
  }, 'Use a LinkedIn profile URL, such as https://www.linkedin.com/in/your-name/.'),
});
export const submission = fields.extend({
  clientSubmittedAt: z.iso.datetime({ offset: true }).transform(value => new Date(value)),
  clientTimezone: z.string().max(100).default('UTC').refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Invalid timezone.'),
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().nonnegative().max(50_000_000),
  }).nullable().default(null),
  consent: z.literal(true, { error: 'Please agree to publication before submitting.' }),
  website: z.string().max(200).default(''),
});
export const edit = fields.extend({ status: z.enum(['pending', 'approved', 'rejected']) });
export const listing = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(12),
  sort: z.enum(['newest', 'oldest', 'name_asc', 'name_desc']).default('newest'),
  status: z.enum(['all', 'pending', 'approved', 'rejected']).default('all'),
  search: z.string().trim().max(100).default(''),
});
export const orderBy = {
  newest: 'created_at DESC, id DESC', oldest: 'created_at ASC, id ASC',
  name_asc: 'name ASC, id ASC', name_desc: 'name DESC, id DESC',
};
export function csvCell(value: unknown) {
  let text = value == null ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
