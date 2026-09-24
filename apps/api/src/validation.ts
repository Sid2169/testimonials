// Input validation/normalisation for every kind of data the API accepts.
//
// Each exported schema (Zod) describes the shape and rules for one request
// body / query-string. Beyond rejecting bad input, parsing also normalises
// data — e.g. trimming whitespace and filling empty optional fields with
// defaults — so downstream handlers can trust the object they receive.
// User input is NEVER trusted with raw SQL or HTML; these schemas are the
// first line of defence, and parameterised SQL + HTML escaping come after.

import { z } from 'zod';

// The editable testimonial fields, shared by public submissions and the
// admin's edit form (the status of a submission is decided later, by an admin).
export const fields = z.object({
  name: z.string().trim().min(1, 'Please enter your name.').max(100),
  view: z.string().trim().min(10, 'Please write at least 10 characters.').max(3000),
  company: z.string().trim().max(150).default(''),
  // Company website: must be absent or a valid HTTPS URL with no credentials.
  // Requiring https: and forbidding user:pass prevents `javascript:` and
  // cred-phishing URLs from ever being stored/rendered.
  companyUrl: z.string().trim().max(500).default('').refine(value => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch { return false; }
  }, 'Use a secure company website URL beginning with https://.'),
  designation: z.string().trim().max(150).default(''),
  // LinkedIn must be a real https://linkedin.com/in/... profile. The hostname
  // match rejects look-alike domains, and the /in/ path rule rejects anything
  // that isn't an actual profile URL.
  linkedin: z.string().trim().max(500).default('').refine(value => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['linkedin.com', 'www.linkedin.com'].includes(url.hostname) && !url.username && !url.password && !url.port && /^\/in\/[^/]+\/?$/.test(url.pathname);
    } catch { return false; }
  }, 'Use a LinkedIn profile URL, such as https://www.linkedin.com/in/your-name/.'),
});

// The public submission form extends `fields` with metadata set by the
// browser: when it was submitted, the visitor's timezone, an optional
// location, the consent checkbox, and a hidden "website" honeypot field.
export const submission = fields.extend({
  // The browser sends ISO timestamps; turn them into real Date objects.
  clientSubmittedAt: z.iso.datetime({ offset: true }).transform(value => new Date(value)),
  // Timezone like "Asia/Kolkata". Validated by asking the runner to accept it.
  clientTimezone: z.string().max(100).default('UTC').refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Invalid timezone.'),
  // Optional approximate coordinates from the visitor's browser.
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().nonnegative().max(50_000_000),
  }).nullable().default(null),
  // A checkbox the browser marks required, so `false`/missing is rejected.
  // This is the visitor's explicit agreement to publish their details.
  consent: z.literal(true, { error: 'Please agree to publication before submitting.' }),
  // Honeypot: real visitors never see/fill this field (the hidden input).
  // If a value arrives, the request is almost certainly a form bot; the
  // handler short-circuits with a fake "thanks" success response.
  website: z.string().max(200).default(''),
});

// What an admin can change when reviewing a testimonial: all fields plus the
// publication status they wish to apply.
export const edit = fields.extend({ status: z.enum(['pending', 'approved', 'rejected']) });

// Query-string parameters for list endpoints (public wall + admin table).
// Number-ish values arrive as strings, hence z.coerce.number(). Every option
// is bounded to a strict allowlist/range so nothing unsafe reaches the SQL.
export const listing = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(12),
  sort: z.enum(['newest', 'oldest', 'name_asc', 'name_desc']).default('newest'),
  status: z.enum(['all', 'pending', 'approved', 'rejected']).default('all'),
  search: z.string().trim().max(100).default(''),
});

// The exact SQL ORDER BY clause for each advertised sort option. Only these
// fixed strings are ever interpolated into queries; user input never becomes
// SQL here (it maps to a key in this object, never the raw value).
export const orderBy = {
  newest: 'created_at DESC, id DESC', oldest: 'created_at ASC, id ASC',
  name_asc: 'name ASC, id ASC', name_desc: 'name DESC, id DESC',
};

// Turn any value into a safe CSV cell: wrap in double quotes with escaped
// quotes, and neutralise cells that start with characters spreadsheet
// formulas use (=, +, -, @) so an exported file cannot execute code when
// opened. Strings starting with whitespace/tabs/newlines are covered too.
export function csvCell(value: unknown) {
  let text = value == null ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}