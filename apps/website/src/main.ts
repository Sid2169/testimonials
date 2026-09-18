import '../../shared/style.css';
import './style.css';
import { el, icon, escapeHtml, avatar, dateLabel, request, type Page, type Testimonial } from '../../shared/ui';

document.querySelectorAll<HTMLElement>('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon as Parameters<typeof icon>[0]); });
el<HTMLAnchorElement>('#admin-link').href = import.meta.env.VITE_ADMIN_URL || 'http://localhost:5174';
el('#year').textContent = String(new Date().getFullYear());
const form = el<HTMLFormElement>('#testimonial-form');
const photo = el<HTMLInputElement>('#photo');
let photoUrl: string | null = null;
let location: { latitude: number; longitude: number; accuracy: number } | null = null;
let ignoreLocation = false;

// This runs on page load. A denial, timeout, or unavailable location never blocks the form.
const locationToggle = el<HTMLButtonElement>('#location-toggle');
function askLocation() {
  ignoreLocation = false;
  if (!navigator.geolocation || !window.isSecureContext) {
    el('#location-status').textContent = 'Location unavailable. You can still share your testimonial.';
    return;
  }
  locationToggle.hidden = false;
  locationToggle.textContent = 'Skip';
  el('#location-status').textContent = 'Location permission is optional. Allow it to share your approximate location privately.';
  navigator.geolocation.getCurrentPosition(position => {
    if (ignoreLocation) return;
    location = {
      latitude: Number(position.coords.latitude.toFixed(3)),
      longitude: Number(position.coords.longitude.toFixed(3)),
      accuracy: position.coords.accuracy,
    };
    el('#location-status').textContent = 'Approximate location attached. Only Siddhartha can see it.';
    locationToggle.textContent = 'Remove';
  }, () => {
    if (ignoreLocation) return;
    el('#location-status').textContent = 'No location attached. Your testimonial can still be submitted.';
    locationToggle.textContent = 'Retry';
  }, { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 });
}
locationToggle.addEventListener('click', () => {
  if (locationToggle.textContent === 'Retry') { askLocation(); return; }
  location = null;
  ignoreLocation = true;
  el('#location-status').textContent = 'No location attached. Your testimonial can still be submitted.';
  locationToggle.textContent = 'Retry';
});
askLocation();

el<HTMLTextAreaElement>('#view').addEventListener('input', event => {
  el('#view-counter').textContent = `${(event.target as HTMLTextAreaElement).value.length.toLocaleString()} / 3,000`;
});
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
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    clearPhoto();
    el('#photo-error').textContent = 'Choose a JPG, PNG or WebP photo, up to 5 MB.';
    return;
  }
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = URL.createObjectURL(file);
  const preview = new Image(); preview.src = photoUrl; preview.alt = 'Selected photo';
  el('#photo-visual').replaceChildren(preview);
  el('#photo-label').textContent = file.name;
  el('#remove-photo').hidden = false;
});
el('#remove-photo').addEventListener('click', () => { clearPhoto(); el('#photo-error').textContent = ''; });
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = el<HTMLButtonElement>('#submit-button');
  if (button.disabled) return;
  el('#form-error').textContent = '';
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
  const formData = new FormData(form);
  const payload = {
    name: formData.get('name'), view: formData.get('view'), company: formData.get('company'), companyUrl,
    designation: formData.get('designation'), linkedin, website: formData.get('website'),
    consent: el<HTMLInputElement>('#consent').checked,
    clientSubmittedAt: new Date().toISOString(), clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    location,
  };
  const body = new FormData();
  body.append('payload', JSON.stringify(payload));
  if (photo.files?.[0]) body.append('photo', photo.files[0]);
  button.disabled = true; button.textContent = 'Sending your kind words…';
  try {
    await request('/api/testimonials', { method: 'POST', body });
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

function card(item: Testimonial) {
  const company = item.companyUrl && item.company
    ? `<a href="${escapeHtml(item.companyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.company)}</a>`
    : escapeHtml(item.company);
  const role = item.designation && company ? `${escapeHtml(item.designation)} at ${company}` : escapeHtml(item.designation) || company;
  return `<article class="testimonial-card panel"><span class="quote-icon">${icon('quote')}</span><blockquote class="testimonial-quote">${escapeHtml(item.view)}</blockquote><div class="testimonial-person">${avatar(item)}<div><strong>${escapeHtml(item.name)}</strong>${role ? `<p>${role}</p>` : ''}</div>${item.linkedin ? `<a class="profile-link" href="${escapeHtml(item.linkedin)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(item.name)} on LinkedIn">${icon('external')}</a>` : ''}</div><div class="card-date">${dateLabel(item.created_at)}</div></article>`;
}
let wallPage = 1;
let wallLoading = false;
async function loadWall() {
  if (wallLoading) return;
  wallLoading = true;
  el<HTMLButtonElement>('#wall-prev').disabled = true;
  el<HTMLButtonElement>('#wall-next').disabled = true;
  try {
    const data = await request<Page>(`/api/testimonials?page=${wallPage}&limit=6`);
    el('#wall-count').textContent = `${data.total} ${data.total === 1 ? 'experience' : 'experiences'} shared`;
    el('#testimonials').innerHTML = data.items.length ? data.items.map(card).join('') : `<div class="empty-state">${icon('quote')}<h3>The first kind words could be yours.</h3><p>Have we worked together? Share a little about your experience using the form above.</p><a class="button secondary" href="#testimonial-form">Leave a testimonial ${icon('arrow')}</a></div>`;
    el('#wall-pagination').hidden = data.total <= data.limit;
    el('#wall-page').textContent = `Page ${data.page} of ${Math.max(1, Math.ceil(data.total / data.limit))}`;
    el<HTMLButtonElement>('#wall-prev').disabled = data.page === 1;
    el<HTMLButtonElement>('#wall-next').disabled = data.page * data.limit >= data.total;
  } catch (error) {
    el('#testimonials').innerHTML = `<div class="empty-state"><h3>Kind words are taking a moment.</h3><p>${escapeHtml(error instanceof Error ? error.message : 'Please try again.')}</p><button id="retry-wall" class="button secondary">Try again</button></div>`;
    el('#wall-pagination').hidden = true;
    el('#retry-wall').addEventListener('click', () => void loadWall());
  } finally { wallLoading = false; }
}
el('#wall-prev').addEventListener('click', () => { wallPage--; void loadWall(); });
el('#wall-next').addEventListener('click', () => { wallPage++; void loadWall(); });
void loadWall();
