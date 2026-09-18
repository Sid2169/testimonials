# Siddhartha · Kind words

A testimonial website, a separately deployable private admin dashboard, and an Express API using MySQL. The frontends use semantic HTML, CSS, and vanilla TypeScript with Vite. No frontend framework is required.

## What’s included in this website

- Responsive public form and a paginated wall of **approved** testimonials.
- Required name and testimonial; optional company, company page, designation, LinkedIn profile, and photo.
- Optional browser location requested on page load. Permission denial, timeouts, or removal do not block submission. Coordinates are rounded to three decimal places and never returned by the public API.
- Automatic visitor timestamp, visitor timezone, and a separate authoritative UTC server timestamp. Visitor-supplied time and location are untrusted metadata, not proof of when or where someone submitted.
- JPEG, PNG, and WebP uploads, limited to 5 MB and 20 megapixels. Images are decoded, resized to at most 512 × 512, re-encoded as WebP, and stripped of metadata. Photos remain on server storage and are inaccessible publicly until approved.
- One admin account, hashed password, expiring server-side sessions, HttpOnly cookies, CSRF protection, and no registration endpoint.
- Approve, unpublish, edit, delete, search, paginate, sort by name/date, and export filtered CSV. Exports include all matching pages, up to 10,000 records, and escape spreadsheet formula injection.
- Docker Compose deployment with separate public and admin containers/domains, a private API and database, persistent uploads, and Caddy for HTTPS.

There are no invented testimonials or default admin credentials. Existing testimonials in the database appear when their status is `approved`.

## Project layout

```text
apps/
  website/     Public website, localhost:5173
  admin/       Admin dashboard, localhost:5174
  api/         Express API, localhost:3000
  shared/      Shared TypeScript helpers and CSS tokens
deploy/        Dockerfiles and Caddy configuration
compose.yml    Production deployment
compose.dev.yml Local MySQL only
```

## Run locally

Requirements: Node.js 22.12+ and MySQL 8.4. Docker Compose is the easiest way to run MySQL locally, provided your user can access the Docker daemon.

1. Install and configure:

   ```bash
   npm ci
   cp apps/api/.env.example apps/api/.env
   ```

   Edit `apps/api/.env` and choose a database password. Defaults assume the public site is opened at **http://localhost:5173** and the admin at **http://localhost:5174**. Use those exact origins, not `127.0.0.1`, unless you also change `PUBLIC_ORIGIN` and `ADMIN_ORIGIN`.

2. Start MySQL:

   ```bash
   docker compose --env-file apps/api/.env -f compose.dev.yml up -d --wait
   ```

   Alternatively, create a MySQL database named `testimonials` and a user with privileges on that database, then configure `DB_HOST`, `DB_PORT`, `DB_USER`, and `DB_PASSWORD`. MySQL must use `utf8mb4`; the migration creates its tables with this charset.

3. Create the tables and your admin account:

   ```bash
   npm run db:migrate
   npm run admin:create
   ```

   The admin command prompts for your email and password, with password input hidden. Passwords must be 12–72 UTF-8 bytes. No credentials are committed or embedded in either frontend. If an account already exists, the command refuses to replace it unless explicitly run with `--reset`:

   ```bash
   npm run admin:create -- --reset
   ```

4. Start all three apps:

   ```bash
   npm run dev
   ```

   Open **http://localhost:5173**. The **Admin** link opens the separate dashboard at **http://localhost:5174**, where the session check shows a login form before loading any private data. API endpoints enforce authentication independently of the UI.

   The Vite servers proxy `/api` to Express, keeping cookies same-origin. If you change the links, copy the frontend `.env.example` files to `.env` and update the `VITE_*` values. Those values are public build-time configuration, never secrets.

## Simplest production deployment: one VPS, two domains

For the managed, low-maintenance deployment using Vercel, Render, TiDB Cloud Starter, and Backblaze B2, follow [the managed production deployment guide](docs/PRODUCTION_DEPLOYMENT.md).

Use a Linux VPS with Docker Compose and two DNS names, for example `words.your-domain.com` and `admin.your-domain.com`. This keeps MySQL and uploaded photos on persistent server storage without requiring separate managed services. The public website and dashboard are built and served in separate containers. Both use same-origin `/api` reverse proxies to the private Express container.

1. Copy the repository to your VPS. Copy `.env.example` to `.env`, set your two real domain names, and set **different, long, random database and root passwords**. Keep the `.env` file private (`chmod 600 .env`).
2. Point both domains’ DNS A records to the VPS (and set AAAA only if IPv6 is configured). Open inbound TCP 80 and 443, and optionally UDP 443 for HTTP/3. Do not expose port 3000 or MySQL to the internet.
3. Build and initialize:

   ```bash
   docker compose build
   docker compose up -d db --wait
   docker compose run --rm api node dist/migrate.js
   docker compose run --rm -it api node dist/create-admin.js
   docker compose up -d
   ```

4. Visit your public and admin domains. Caddy obtains and renews HTTPS certificates automatically once DNS and ports are ready. Location access works over HTTPS or localhost. See [Caddy’s HTTPS requirements](https://caddyserver.com/docs/automatic-https#overview).

5. Check service state and logs:

   ```bash
   docker compose ps
   docker compose logs --tail=100 api caddy
   ```

   The API health check verifies database connectivity. Tables must be initialized before accepting traffic; migrations are an explicit deployment step, not performed by every API startup.

For subsequent releases, run `docker compose build`, `docker compose run --rm api node dist/migrate.js`, then `docker compose up -d`. The initial migration is idempotent; future schema changes should be added as reviewed migrations. Back up first when changing the schema. The public and admin frontends can also be released separately with `docker compose up -d --build website` or `docker compose up -d --build admin`.

If hosting either frontend on another server, configure that server to proxy `/api` to the API privately and preserve trusted forwarding headers. Update the frontend links and allowed origins. Avoid exposing authenticated cookies across unrelated domains; this starter deliberately uses same-origin proxies and does not enable wildcard CORS. The number of trusted proxy hops must match the actual topology. The supplied production setup uses exactly **one** hop, and the API port is not published.

## Moderation and privacy

New submissions are always `pending`. Only `approved` records and their photos are publicly readable. Unpublishing immediately removes a testimonial and photo from the public API. No location, timezone, client timestamp, or raw upload filename is returned in public responses. The server does not store visitor IP addresses; rate limiting uses in-memory IP keys.

Deletion is a **soft delete**: it removes the record from the dashboard, exports, public listing, and photo access, but retains the record and file. This is recoverable from the database. To restore a known record, a database administrator can run a parameterized equivalent of:

```sql
UPDATE testimonials
SET deleted_at = NULL, status = 'pending', updated_at = UTC_TIMESTAMP(3)
WHERE id = 'the-exact-testimonial-uuid';
```

For an erasure request, permanently remove the exact record and its associated photo from storage, and apply your backup retention policy. Soft deletion does not erase personal data. Include the database and upload volume in a regular backup/retention policy; exports also contain private metadata and should be handled accordingly.

Session cookies expire after 12 hours and are host-only, HttpOnly, SameSite=Strict, and Secure in production. Session tokens are stored hashed in MySQL. Resetting admin credentials revokes all sessions. The public production domain does not route `/api/admin` requests at all. Never use `NODE_ENV=development` for the public deployment.

## Rate limits

| Endpoint | Limit |
| --- | --- |
| All API requests | 180/minute per IP |
| Testimonial submissions | 5/hour per IP, plus 60/hour overall |
| Login | 5 failed attempts/15 minutes per IP, plus 100 attempts/15 minutes overall |

Limits run before upload parsing and password comparison. Responses include rate-limit headers and a `Retry-After` header when blocked. A hidden honeypot also catches basic form bots. Origin checks and CORS are browser controls, not bot authentication; non-browser clients can spoof an Origin header. The in-memory limiter is appropriate for this single API instance and resets on restart. Use a shared limiter store before scaling to multiple instances. Add a challenge service if targeted spam becomes an issue.

## API routes

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Database connectivity |
| `GET /api/testimonials` | Approved testimonials; accepts `page`, `limit`, `sort` |
| `POST /api/testimonials` | Multipart form: JSON `payload` and optional `photo` |
| `GET /api/photos/:id` | Approved photos publicly; pending/rejected photos require a session |
| `POST /api/admin/login` | Email/password login; admin origin only |
| `GET /api/admin/session` | Current session and CSRF token |
| `POST /api/admin/logout` | Revoke session |
| `GET /api/admin/testimonials` | Private listing; adds `status` and `search` |
| `PATCH /api/admin/testimonials/:id` | Edit all text fields and publication status |
| `DELETE /api/admin/testimonials/:id` | Archive testimonial |
| `GET /api/admin/export` | CSV with current status/search/sort filters |

The requested submission endpoint uses POST. Read routes and authenticated PATCH/DELETE routes support the public listing and admin features. Admin writes require both the configured admin Origin and an `X-CSRF-Token` header from the authenticated session. Public submission requires the public Origin. All SQL data values are parameterized; sorting is allowlisted.

## Checks

```bash
npm run build
npm test
npm audit
```

`npm test` checks validation, LinkedIn URL restrictions, CSV safety, unauthenticated access, origin/CSRF checks, upload rejection and re-encoding, and submission rate limiting without a database. Tests start temporary local HTTP listeners.

For the full MySQL lifecycle test, create a **dedicated** empty database whose name ends in `_test`, grant the configured user access, and run:

```bash
DB_NAME=testimonials_test npm run test:integration
```

The integration suite clears records in that database. It refuses to run unless `DB_NAME` ends in `_test`. It tests submission, private photos, login, CSRF, approval, public-data privacy, sorting/search, export, unpublishing, soft deletion, logout, and submission without location/photo. Never point it at your real database.

For manual acceptance: submit with location denied; submit with a valid photo; sign in on the separate dashboard; approve, edit, unpublish, and delete; verify the public wall; export with filters; then sign out and check that private requests return 401. Use a browser with a narrow viewport and keyboard navigation to review accessibility.

## Backups

Back up both **MySQL** and the **uploads volume**, and keep encrypted copies off the VPS. A CSV export is not a complete backup. Include Caddy’s data volume if preserving its certificates. Use a MySQL-consistent dump (`mysqldump --single-transaction`) and a coordinated upload snapshot; test restoration periodically. Do not run `docker compose down -v` on your production deployment: it removes named volumes, including the database and uploaded photos.

Google Fonts supplies the optional Manrope and DM Sans fonts; system sans-serif fallbacks keep both sites usable if fonts are blocked. Self-host these fonts if you prefer to avoid third-party font requests.
