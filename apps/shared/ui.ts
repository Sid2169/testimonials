// Shared browser helpers: types and tiny functions used by BOTH the public
// website and the admin dashboard. Both apps import from here so behaviour
// (e.g. date formatting, HTML escaping) stays consistent in one place.

// The shape of a testimonial as returned by the API. Fields marked with a
// `?` are only present on admin responses; the public API only ever sends
// the approved, non-private subset.
export interface Testimonial {
  id: string; name: string; view: string; company: string; companyUrl: string; designation: string;
  linkedin: string; photoUrl: string | null; created_at: string;
  status?: 'pending' | 'approved' | 'rejected';
  client_submitted_at?: string; client_timezone?: string;
  latitude?: string | null; longitude?: string | null; location_accuracy?: number | null;
}

// The paginated envelope the list endpoints return: one page of items, the
// total count (across all pages), and the current page/limit that was asked.
// `counts` (per-status totals) only ships with admin responses.
export interface Page {
  items: Testimonial[]; total: number; page: number; limit: number;
  counts?: Record<string, number>;
}

// Convert untrusted text into something safe to put in HTML. Without this,
// a name like `<img src=x onerror=alert(1)>` could inject scripts. It runs
// whenever user-provided content is rendered into the DOM as HTML.
export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

// Show a fallback avatar: the first letters of the first two words of a name,
// uppercase (e.g. "Anika Rao" → "AR").
export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();

// Human-readable date/time labels. `undefined` as the first arg means "use
// this browser's locale"; the format is adjusted automatically.
export const dateLabel = (date: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(date));
export const dateTimeLabel = (date: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));

// Type-safe querySelector: like document.querySelector but throws immediately
// if the element is missing (a typo'd selector fails loudly instead of
// silently doing nothing later).
export const el = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

// A fetch error that carries an HTTP status (0 = didn't get a response at
// all, e.g. offline). Callers can inspect status to special-case 401 → log in.
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

// Small wrapper around fetch() that:
//  - sends cookies automatically (credentials: same-origin),
//  - turns network failures into ApiError(0),
//  - extracts the API's JSON error message into an ApiError,
//  - returns the parsed JSON body (or undefined for 204 No Content).
// This is the ONLY place the apps talk to the network.
export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { credentials: 'same-origin', ...options }); }
  catch { throw new ApiError('Could not connect. Check your connection and try again.', 0); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error ?? 'Something went wrong. Please try again.', response.status);
  }
  return response.status === 204 ? undefined as T : response.json();
}

// Inline SVG icons. Each name maps to a set of <path> strokes drawn in the
// 24×24 "feather" style — kept as code (not image files) so they always match
// the current text colour and need no extra requests.
export const icon = (name: 'arrow' | 'lock' | 'upload' | 'check' | 'quote' | 'pin' | 'external' | 'close') => {
  const paths = {
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    quote: '<path d="M10 5H4v8h5c0 3-2 5-5 6M21 5h-6v8h5c0 3-2 5-5 6"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    external: '<path d="M14 3h7v7m0-7L10 14m0-10H4v16h16v-6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
  };
  // aria-hidden: the icons are decorations; screen readers get the button's
  // own accessible name instead of reading SVG paths.
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};

// The avatar visual used across cards and tables: the uploaded photo when
// present, otherwise a coloured circle with the person's initials. Both
// escape their inputs because this markup is emitted as an HTML string.
export function avatar(item: Testimonial) {
  return item.photoUrl
    ? `<img class="avatar" src="${escapeHtml(item.photoUrl)}" alt="" loading="lazy" width="44" height="44">`
    : `<span class="avatar initials" aria-hidden="true">${escapeHtml(initials(item.name))}</span>`;
}