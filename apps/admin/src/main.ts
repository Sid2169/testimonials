import '../../shared/style.css';
import './style.css';
import { el, icon, escapeHtml, avatar, dateLabel, dateTimeLabel, request, ApiError, type Page, type Testimonial } from '../../shared/ui';

document.querySelectorAll<HTMLElement>('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon as Parameters<typeof icon>[0]); });
el<HTMLAnchorElement>('#website-link').href = import.meta.env.VITE_WEBSITE_URL || 'http://localhost:5173';
let csrfToken = '';
let currentPage = 1;
let status = 'all';
let items: Testimonial[] = [];
let selected: Testimonial | null = null;
let requestId = 0;
let toastTimer: ReturnType<typeof setTimeout>;
const editDialog = el<HTMLDialogElement>('#edit-dialog');
const deleteDialog = el<HTMLDialogElement>('#delete-dialog');

function toast(message: string, error = false) {
  const node = el('#toast');
  clearTimeout(toastTimer); node.textContent = message; node.classList.toggle('error', error); node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 5000);
}
function showLogin(message = '') {
  clearTimeout(searchTimer);
  requestId++; csrfToken = ''; items = []; selected = null;
  editDialog.close(); deleteDialog.close();
  el('#session-loading').hidden = true; el('#login-section').hidden = false;
  el('#dashboard').hidden = true; el('#logout').hidden = true;
  el('#table-container').replaceChildren(); el('#submission-details').replaceChildren();
  el<HTMLFormElement>('#edit-form').reset();
  el('#admin-email').textContent = 'Private access'; el('#login-error').textContent = message;
}
function showDashboard(session: { csrfToken: string; email: string }) {
  csrfToken = session.csrfToken; currentPage = 1;
  el('#session-loading').hidden = true; el('#login-section').hidden = true;
  el('#dashboard').hidden = false; el('#logout').hidden = false;
  el('#admin-email').textContent = session.email;
  el<HTMLFormElement>('#login-form').reset();
  void loadList();
}
function handleError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    showLogin('Your session has expired. Please sign in again.');
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
function query() {
  return new URLSearchParams({ page: String(currentPage), limit: '10', status,
    sort: el<HTMLSelectElement>('#sort').value, search: el<HTMLInputElement>('#search').value.trim() });
}
function row(item: Testimonial) {
  const label = item.status === 'approved' ? 'Published' : item.status === 'rejected' ? 'Not published' : 'Pending';
  return `<tr><td><div class="table-person">${avatar(item)}<div><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml([item.designation, item.company].filter(Boolean).join(' · '))}</p></div></div></td><td><p class="table-quote">${escapeHtml(item.view)}</p></td><td><span class="badge ${item.status}">${label}</span></td><td class="table-date">${dateLabel(item.created_at)}</td><td><div class="row-actions"><button data-action="edit" data-id="${item.id}" aria-label="Review testimonial by ${escapeHtml(item.name)}">Review</button>${item.status !== 'approved' ? `<button data-action="approve" data-id="${item.id}" aria-label="Approve testimonial by ${escapeHtml(item.name)}">Approve</button>` : ''}<button class="delete-action" data-action="delete" data-id="${item.id}" aria-label="Delete testimonial by ${escapeHtml(item.name)}">Delete</button></div></td></tr>`;
}
async function loadList() {
  if (!csrfToken) return;
  const id = ++requestId;
  el('#list-error').textContent = '';
  el('#table-container').setAttribute('aria-busy', 'true');
  el<HTMLButtonElement>('#previous').disabled = true;
  el<HTMLButtonElement>('#next').disabled = true;
  try {
    const data = await request<Page>(`/api/admin/testimonials?${query()}`);
    if (id !== requestId) return;
    if (!data.items.length && data.total > 0 && currentPage > 1) { currentPage--; void loadList(); return; }
    items = data.items;
    const counts = data.counts ?? {};
    el('#count-total').textContent = String(Object.values(counts).reduce((a, b) => a + b, 0));
    for (const key of ['pending', 'approved', 'rejected']) el(`#count-${key}`).textContent = String(counts[key] ?? 0);
    el('#table-container').innerHTML = items.length
      ? `<div class="table-scroll"><table class="testimonials-table"><caption class="sr-only">Testimonials matching your filters</caption><thead><tr><th scope="col">Person</th><th scope="col">Their experience</th><th scope="col">Status</th><th scope="col">Received</th><th scope="col">Actions</th></tr></thead><tbody>${items.map(row).join('')}</tbody></table></div>`
      : `<div class="empty-state">${icon('quote')}<h3>${status === 'pending' ? 'You’re all caught up.' : 'No testimonials here yet.'}</h3><p>${el<HTMLInputElement>('#search').value ? 'Try a different search or filter.' : 'New submissions will appear here, ready for your review.'}</p></div>`;
    const start = data.total ? (data.page - 1) * data.limit + 1 : 0;
    el('#list-summary').textContent = `${start}–${Math.min(data.page * data.limit, data.total)} of ${data.total} testimonials`;
    el('#page-number').textContent = `${data.page} / ${Math.max(1, Math.ceil(data.total / data.limit))}`;
    el<HTMLButtonElement>('#previous').disabled = data.page === 1;
    el<HTMLButtonElement>('#next').disabled = data.page * data.limit >= data.total;
  } catch (error) {
    if (id !== requestId) return;
    const message = handleError(error);
    if (!csrfToken) return;
    el('#list-error').textContent = message;
    el('#table-container').innerHTML = '<div class="empty-state"><p>Could not load testimonials.</p><button id="retry-list" class="button secondary">Try again</button></div>';
    el('#retry-list').addEventListener('click', () => void loadList());
  } finally { if (id === requestId) el('#table-container').removeAttribute('aria-busy'); }
}
const mutation = (url: string, method: string, data?: unknown) => request(url, {
  method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
  ...(data ? { body: JSON.stringify(data) } : {}),
});
el<HTMLFormElement>('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = el<HTMLButtonElement>('#login-button');
  if (button.disabled) return;
  button.disabled = true; button.textContent = 'Signing in…'; el('#login-error').textContent = '';
  try {
    const data = await request<{ email: string; csrfToken: string }>('/api/admin/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: el<HTMLInputElement>('#email').value.trim(), password: el<HTMLInputElement>('#password').value }) });
    showDashboard(data);
  } catch (error) { el('#login-error').textContent = handleError(error); }
  finally { button.disabled = false; button.innerHTML = `Sign in ${icon('arrow')}`; }
});
el('#logout').addEventListener('click', async () => {
  const button = el<HTMLButtonElement>('#logout'); button.disabled = true;
  try { await mutation('/api/admin/logout', 'POST'); showLogin(); }
  catch (error) { toast(handleError(error), true); }
  finally { button.disabled = false; }
});
document.querySelectorAll<HTMLButtonElement>('[data-status]').forEach(button => button.addEventListener('click', () => {
  status = button.dataset.status!; currentPage = 1;
  document.querySelectorAll('[data-status]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
  void loadList();
}));
let searchTimer: ReturnType<typeof setTimeout>;
el('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { currentPage = 1; void loadList(); }, 300); });
el('#sort').addEventListener('change', () => { currentPage = 1; void loadList(); });
el('#previous').addEventListener('click', () => { currentPage--; void loadList(); });
el('#next').addEventListener('click', () => { currentPage++; void loadList(); });

el('#table-container').addEventListener('click', async event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!button) return;
  const item = items.find(x => x.id === button.dataset.id);
  if (!item) return;
  if (button.dataset.action === 'approve') {
    button.disabled = true;
    try {
      await mutation(`/api/admin/testimonials/${item.id}`, 'PATCH', { ...item, status: 'approved' });
      toast('Testimonial approved and published.'); await loadList();
    } catch (error) { toast(handleError(error), true); }
    finally { button.disabled = false; }
    return;
  }
  selected = item;
  if (button.dataset.action === 'delete') {
    el('#delete-description').textContent = `Delete the testimonial from ${item.name}?`;
    el('#delete-error').textContent = ''; deleteDialog.showModal(); return;
  }
  for (const field of ['name', 'view', 'company', 'companyUrl', 'designation', 'linkedin', 'status'] as const) {
    el<HTMLInputElement | HTMLSelectElement>(`#edit-${field}`).value = item[field] ?? '';
  }
  const hasLocation = item.latitude != null && item.longitude != null;
  el('#submission-details').innerHTML = `<div><strong>Received:</strong> ${dateTimeLabel(item.created_at)}</div><div><strong>Visitor’s reported time:</strong> ${item.client_submitted_at ? dateTimeLabel(item.client_submitted_at) : 'Unavailable'}</div><div><strong>Visitor’s timezone:</strong> ${escapeHtml(item.client_timezone)}</div><div><strong>Approximate location:</strong> ${hasLocation ? `${escapeHtml(item.latitude)}, ${escapeHtml(item.longitude)} (accuracy ±${Math.round(Number(item.location_accuracy))} m)` : 'Not shared'}</div><span>Times above use your browser’s timezone. Location is never public.</span>${item.photoUrl ? `<a href="${escapeHtml(item.photoUrl)}" target="_blank" rel="noopener">View submitted photo ↗</a>` : ''}`;
  el('#edit-error').textContent = ''; editDialog.showModal();
});
for (const selector of ['#close-edit', '#cancel-edit']) el(selector).addEventListener('click', () => editDialog.close());
el('#cancel-delete').addEventListener('click', () => deleteDialog.close());
el<HTMLFormElement>('#edit-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!selected) return;
  const button = el<HTMLButtonElement>('#save-edit'); if (button.disabled) return;
  const id = selected.id;
  button.disabled = true; el('#edit-error').textContent = '';
  const data = Object.fromEntries(new FormData(el<HTMLFormElement>('#edit-form')));
  try {
    await mutation(`/api/admin/testimonials/${id}`, 'PATCH', data);
    editDialog.close(); toast('Testimonial saved.'); await loadList();
  } catch (error) { el('#edit-error').textContent = handleError(error); }
  finally { button.disabled = false; }
});
el('#confirm-delete').addEventListener('click', async () => {
  if (!selected) return;
  const button = el<HTMLButtonElement>('#confirm-delete'); if (button.disabled) return;
  const id = selected.id; button.disabled = true; el('#delete-error').textContent = '';
  try {
    await mutation(`/api/admin/testimonials/${id}`, 'DELETE');
    deleteDialog.close(); toast('Testimonial removed. Its archived record can be restored from the database.'); await loadList();
  } catch (error) { el('#delete-error').textContent = handleError(error); }
  finally { button.disabled = false; }
});
el('#export').addEventListener('click', async () => {
  const button = el<HTMLButtonElement>('#export'); button.disabled = true;
  try {
    const response = await fetch(`/api/admin/export?${query()}`, { credentials: 'same-origin' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiError(data.error ?? 'Could not export testimonials.', response.status);
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = 'testimonials.csv';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Exported all testimonials matching your filters.');
  } catch (error) { toast(handleError(error), true); }
  finally { button.disabled = false; }
});
void request<{ email: string; csrfToken: string }>('/api/admin/session').then(showDashboard).catch(error => {
  showLogin(error instanceof ApiError && error.status === 401 ? '' : handleError(error));
});
