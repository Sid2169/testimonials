export interface Testimonial {
  id: string; name: string; view: string; company: string; companyUrl: string; designation: string;
  linkedin: string; photoUrl: string | null; created_at: string;
  status?: 'pending' | 'approved' | 'rejected';
  client_submitted_at?: string; client_timezone?: string;
  latitude?: string | null; longitude?: string | null; location_accuracy?: number | null;
}
export interface Page {
  items: Testimonial[]; total: number; page: number; limit: number;
  counts?: Record<string, number>;
}
export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
export const dateLabel = (date: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(date));
export const dateTimeLabel = (date: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
export const el = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
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
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};
export function avatar(item: Testimonial) {
  return item.photoUrl
    ? `<img class="avatar" src="${escapeHtml(item.photoUrl)}" alt="" loading="lazy" width="44" height="44">`
    : `<span class="avatar initials" aria-hidden="true">${escapeHtml(initials(item.name))}</span>`;
}
