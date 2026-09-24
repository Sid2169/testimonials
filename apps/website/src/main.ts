// Public website entry point: the form + the wall of approved testimonials.
//
// This is OpenUI-style vanilla TypeScript — no framework. The flow is simple:
// 1) On load we ask the browser (optionally) for the visitor's location,
//    wire up the form, and fetch the first page of testimonials.
// 2) Submitting the form bundles the fields (plus timestamp/timezone/location)
//    into a JSON 'payload' and sends it with the photo as a multipart request.
// 3) The wall is paginated and re-fetched on page navigation.

import '../../shared/style.css';
import './style.css';
import { el, icon, escapeHtml, avatar, dateLabel, request, type Page, type Testimonial } from '../../shared/ui';

// Static decorative icons in the HTML are filled in once at startup.
document.querySelectorAll<HTMLElement>('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon as Parameters<typeof icon>[0]); });
// The header "Admin" link points at the separate admin app; VITE_ADMIN_URL is
// public build-time configuration (falls back to the local dev URL).
el<HTMLAnchorElement>('#admin-link').href = import.meta.env.VITE_ADMIN_URL || 'http://localhost:5174';
el('#year').textContent = String(new Date().getFullYear());

const form = el<HTMLFormElement>('#testimonial-form');
const photo = el<HTMLInputElement>('#photo');
// Object URLs created from a selected photo; cleaned up with revokeObjectURL.
let photoUrl: string | null = null;
// The visitor's approximate coordinates, attached only if they consent.
let location: { latitude: number; longitude: number; accuracy: number } | null = null;
// Tracks whether the visitor chose to SKIP/REMOVE location so an in-flight
// geolocation callback can't silently re-attach it later.
let ignoreLocation = false;

// Purely optional location. A denial, timeout, or unavailable API never
// blocks the form — every path still lets the visitor submit.
const locationToggle = el<HTMLButtonElement>('#location-toggle');
function askLocation() {
  ignoreLocation = false;
  if (!navigator.geolocation || !window.isSecureContext) {
    // Geolocation requires HTTPS (or localhost); announce it as unavailable.
    el('#location-status').textContent = 'Location unavailable. You can still share your testimonial.';
    return;
  }
  locationToggle.hidden = false;
  locationToggle.textContent = 'Skip';
  el('#location-status').textContent = 'Location permission is optional. Allow it to share your approximate location privately.';
  // Asking saves e.g. "Allow"/"Deny" choice; low accuracy by default.
  navigator.geolocation.getCurrentPosition(position => {
    if (ignoreLocation) return;
    // Rounded to 0.001° (~100m) — precise enough but never exact.
    location = {
      latitude: Number(position.coords.latitude.toFixed(3)),
      longitude: Number(position.coords.longitude.toFixed(3)),
      accuracy: position.coords.accuracy,
    };
    el('#location-status').textContent = 'Approximate location attached. Only Siddhartha can see it.';
    locationToggle.textContent = 'Remove';
  }, () => {
    // User denied permission or it timed out — hand back control gracefully.
    if (ignoreLocation) return;
    el('#location-status').textContent = 'No location attached. Your testimonial can still be submitted.';
    locationToggle.textContent = 'Retry';
  }, { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 });
}
// The toggle cycles: "Retry" re-asks, otherwise it detaches any location and
// tells any pending callback (via ignoreLocation) not to re-attach.
locationToggle.addEventListener('click', () => {
  if (locationToggle.textContent === 'Retry') { askLocation(); return; }
  location = null;
  ignoreLocation = true;
  el('#location-status').textContent = 'No location attached. Your testimonial can still be submitted.';
  locationToggle.textContent = 'Retry';
});
askLocation(); // Ask on page load (silently nothing happens if unavailable).

// Live character counter under the textarea (mirrors the server's 3,000 max).
el<HTMLTextAreaElement>('#view').addEventListener('input', event => {
  el('#view-counter').textContent = `${(event.target as HTMLTextAreaElement).value.length.toLocaleString()} / 3,000`;
});

// Photograph: preview via an object URL, validate type/size client-side, let
// the visitor remove the selection. Real enforcement still happens server-side.
function clearPhoto() {
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null;
  photo.value = '';
  el('#photo-visual').innerHTML = icon('upload');
  el('#photo-label').textContent = 'Choose a photo';
  el('#remove-photo').hidden = true;
}
photo.addEventListener('change', () => {
  const file = photo.files?.[0];
  el('#photo-error').textContent = '';
  if (!file) { clearPhoto(); return; }
  // Client-side sanity check — gives instant feedback without a round trip.
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    clearPhoto();
    el('#photo-error').textContent = 'Choose a JPG, PNG or WebP photo, up to 5 MB.';
    return;
  }
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = URL.createObjectURL(file);
  // Show the picked image as a live preview.
  const preview = new Image(); preview.src = photoUrl; preview.alt = 'Selected photo';
  el('#photo-visual').replaceChildren(preview);
  el('#photo-label').textContent = file.name;
  el('#remove-photo').hidden = false;
});
el('#remove-photo').addEventListener('click', () => { clearPhoto(); el('#photo-error').textContent = ''; });

// The real submission. Graceful loading state on the button; every failure
// surfaces as a readable message near the form (never an alert()).
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = el<HTMLButtonElement>('#submit-button');
  if (button.disabled) return; // Double-submit guard.
  el('#form-error').textContent = '';

  // Validate the two URL fields client-side too (mirrors the API rules) so a
  // typo is caught instantly instead of after a wasted HTTP request.
  const linkedin = el<HTMLInputElement>('#linkedin').value.trim();
  if (linkedin && !/^https:\/\/(www\.)?linkedin\.com\/in\/[^/?#]+\/?([?#].*)?$/.test(linkedin)) {
    el('#form-error').textContent = 'Use your full LinkedIn profile URL: https://www.linkedin.com/in/your-name/.';
    el('#linkedin').focus(); return;
  }
  const companyUrl = el<HTMLInputElement>('#company-url').value.trim();
  if (companyUrl) {
    try {
      const url = new URL(companyUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    } catch {
      el('#form-error').textContent = 'Use a secure company website URL beginning with https://.';
      el('#company-url').focus(); return;
    }
  }

  // Bundle everything into the JSON payload the API understands. Note the
  // browser timestamp/timezone are included as untrusted metadata for the
  // admin's context only; the server records its own authoritative timestamp.
  const formData = new FormData(form);
  const payload = {
    name: formData.get('name'), view: formData.get('view'), company: formData.get('company'), companyUrl,
    designation: formData.get('designation'), linkedin, website: formData.get('website'),
    consent: el<HTMLInputElement>('#consent').checked,
    clientSubmittedAt: new Date().toISOString(), clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    location,
  };
  // Two-part multipart body: the JSON payload + the optional photo file.
  const body = new FormData();
  body.append('payload', JSON.stringify(payload));
  if (photo.files?.[0]) body.append('photo', photo.files[0]);

  button.disabled = true; button.textContent = 'Sending your kind words…';
  try {
    await request('/api/testimonials', { method: 'POST', body });
    // Success: stop any location callback, reset the form, show the thank-you
    // state (focusing it so assistive tech announces the result).
    ignoreLocation = true; location = null; clearPhoto(); form.reset();
    el('#form-content').hidden = true;
    el('#success-state').hidden = false;
    el('#success-state').focus();
  } catch (error) {
    el('#form-error').textContent = error instanceof Error ? error.message : 'Could not submit. Please try again.';
  } finally {
    button.disabled = false; button.innerHTML = `Share your experience ${icon('arrow')}`;
  }
});

// --- The public wall ------------------------------------------------------

// Render one testimonial as an <article>. Everything user-provided passes
// through escapeHtml() so a malicious string cannot inject markup or scripts.
function card(item: Testimonial) {
  const company = item.companyUrl && item.company
    ? `<a href="${escapeHtml(item.companyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.company)}</a>`
    : escapeHtml(item.company);
  const role = item.designation && company ? `${escapeHtml(item.designation)} at ${company}` : escapeHtml(item.designation) || company;
  return `<article class="testimonial-card panel"><span class="quote-icon">${icon('quote')}</span><blockquote class="testimonial-quote">${escapeHtml(item.view)}</blockquote><div class="testimonial-person">${avatar(item)}<div><strong>${escapeHtml(item.name)}</strong>${role ? `<p>${role}</p>` : ''}</div>${item.linkedin ? `<a class="profile-link" href="${escapeHtml(item.linkedin)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(item.name)} on LinkedIn">${icon('external')}</a>` : ''}</div><div class="card-date">${dateLabel(item.created_at)}</div></article>`;
}

// Pagination state for the wall ("kind words" section), 6 per page.
let wallPage = 1;
let wallLoading = false;
async function loadWall() {
  if (wallLoading) return; // Don't stack overlapping fetches.
  wallLoading = true;
  el<HTMLButtonElement>('#wall-prev').disabled = true;
  el<HTMLButtonElement>('#wall-next').disabled = true;
  try {
    const data = await request<Page>(`/api/testimonials?page=${wallPage}&limit=6`);
    el('#wall-count').textContent = `${data.total} ${data.total === 1 ? 'experience' : 'experiences'} shared`;
    // Re-render the grid (or the friendly first-submission teaser when empty).
    el('#testimonials').innerHTML = data.items.length ? data.items.map(card).join('') : `<div class="empty-state">${icon('quote')}<h3>The first kind words could be yours.</h3><p>Have we worked together? Share a little about your experience using the form above.</p><a class="button secondary" href="#testimonial-form">Leave a testimonial ${icon('arrow')}</a></div>`;
    el('#wall-pagination').hidden = data.total <= data.limit;
    el('#wall-page').textContent = `Page ${data.page} of ${Math.max(1, Math.ceil(data.total / data.limit))}`;
    // Disable prev/next at the edges — but never before the request, hence
    // the disabled=true at the top.
    el<HTMLButtonElement>('#wall-prev').disabled = data.page === 1;
    el<HTMLButtonElement>('#wall-next').disabled = data.page * data.limit >= data.total;
  } catch (error) {
    // Show an inline retry card; the page otherwise stays usable.
    el('#testimonials').innerHTML = `<div class="empty-state"><h3>Kind words are taking a moment.</h3><p>${escapeHtml(error instanceof Error ? error.message : 'Please try again.')}</p><button id="retry-wall" class="button secondary">Try again</button></div>`;
    el('#wall-pagination').hidden = true;
    el('#retry-wall').addEventListener('click', () => void loadWall());
  } finally { wallLoading = false; }
}
el('#wall-prev').addEventListener('click', () => { wallPage--; void loadWall(); });
el('#wall-next').addEventListener('click', () => { wallPage++; void loadWall(); });
void loadWall(); // Kick off the first page at startup.