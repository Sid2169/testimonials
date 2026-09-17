# Production deployment: Vercel, Render, TiDB Cloud, and Cloudflare R2

This guide deploys the two static frontends to Vercel, the Express API to Render, the MySQL-compatible database to TiDB Cloud Starter, and testimonial photos to Cloudflare R2.

The services do not need scheduled keepalive jobs, periodic refreshes, or routine redeployment. Git pushes deploy application changes automatically. Render’s free web service does sleep after 15 minutes without traffic, so its first request after inactivity can take about a minute. Upgrade the Render service if you need consistently immediate responses.

## Architecture

```text
Public Vercel project ─┐
                       ├── Render Express API ── TiDB Cloud Starter
Admin Vercel project ──┘                      └── private Cloudflare R2 bucket
```

Both Vercel projects proxy `/api/*` to Render. The browser therefore treats API calls as same-origin. This keeps the host-only admin cookie reliable and avoids exposing an API credential or relying on third-party cookies.

## Before you begin

You need:

- The repository pushed to GitHub, with the production branch merged into `main`.
- Accounts at [Vercel](https://vercel.com), [Render](https://render.com), [TiDB Cloud](https://tidbcloud.com), and [Cloudflare](https://dash.cloudflare.com).
- Node.js 22 and the repository checked out locally for the one-time database initialization.
- Optional custom domains. The supplied `vercel.app` and `onrender.com` domains work without them.

Never commit `.env` files, database passwords, or R2 credentials. They are already excluded by `.gitignore`.

## 1. Create the TiDB Cloud database

1. Sign in to TiDB Cloud and create a **Starter** instance.
2. Choose a region reasonably close to the Render region you intend to use.
3. Keep the spending limit at zero if you want to remain within the free quota.
4. Open the instance’s SQL Editor and run:

   ```sql
   CREATE DATABASE testimonials CHARACTER SET utf8mb4;
   ```

5. Open **Connect**, select the public endpoint, create or reset the database password, and record:

   - Host
   - Port, usually `4000`
   - Username
   - Password
   - Database name: `testimonials`

The API enables certificate validation and requires TLS 1.2 or newer when `DB_SSL=true`. Do not disable certificate validation.

TiDB Cloud Starter is MySQL-compatible and has an always-free monthly quota. If the quota is exhausted, new connections are refused until the next monthly reset or until a spending limit is added.

## 2. Create private Cloudflare R2 storage

1. In the Cloudflare dashboard, open **Storage & databases → R2**.
2. Complete the R2 subscription checkout. Usage within the R2 free allowance remains free, but Cloudflare may require billing details.
3. Create a Standard storage bucket named `siddhartha-testimonials`.
4. Leave public bucket access disabled. Photos are served through the Express authorization checks.
5. Open **Manage R2 API tokens** and create an account API token with **Object Read & Write** access limited to this bucket.
6. Record the following values when Cloudflare shows them:

   - Account ID
   - Access Key ID
   - Secret Access Key
   - Bucket name: `siddhartha-testimonials`

The secret access key is displayed only once. Store it in a password manager. Do not use a general Cloudflare API token.

## 3. Initialize the production schema and admin

Do this once from your local checkout. It connects directly to TiDB Cloud; it does not modify your local MySQL database.

1. Install the exact dependencies:

   ```bash
   npm ci
   ```

2. Copy the API environment template:

   ```bash
   cp apps/api/.env.example apps/api/.env
   ```

3. Edit `apps/api/.env` with the TiDB values. For this initialization step, the relevant settings are:

   ```dotenv
   NODE_ENV=development
   DB_HOST=YOUR_TIDB_HOST
   DB_PORT=4000
   DB_USER=YOUR_TIDB_USERNAME
   DB_PASSWORD=YOUR_TIDB_PASSWORD
   DB_NAME=testimonials
   DB_SSL=true
   PUBLIC_ORIGIN=http://localhost:5173
   ADMIN_ORIGIN=http://localhost:5174
   STORAGE_DRIVER=local
   TRUST_PROXY_HOPS=0
   ```

4. Create the tables:

   ```bash
   npm run db:migrate
   ```

5. Create the single administrator account:

   ```bash
   npm run admin:create
   ```

   Enter your email and the same password twice. The password must be 12–72 UTF-8 bytes. Nothing is displayed while you type the password.

6. Remove `apps/api/.env` from your computer if you do not need local production access. It is ignored by Git, but it still contains a live database password.

If you later need to replace the administrator credentials and revoke all sessions, reconnect with the production database settings and run:

```bash
npm run admin:create -- --reset
```

## 4. Deploy the Express API to Render

The repository includes [`render.yaml`](../render.yaml), so a Blueprint is the least error-prone deployment method.

1. In Render, choose **New → Blueprint**.
2. Connect the GitHub repository and select `render.yaml`.
3. Confirm the `siddhartha-testimonials-api` web service on the Free plan.
4. Render prompts for every variable marked `sync: false`. Enter:

   | Variable | Value |
   | --- | --- |
   | `DB_HOST` | TiDB public host |
   | `DB_PORT` | TiDB public port, normally `4000` |
   | `DB_USER` | TiDB username |
   | `DB_PASSWORD` | TiDB password |
   | `DB_NAME` | `testimonials` |
   | `PUBLIC_ORIGIN` | Temporarily `https://public-placeholder.invalid` |
   | `ADMIN_ORIGIN` | Temporarily `https://admin-placeholder.invalid` |
   | `R2_ACCOUNT_ID` | Cloudflare account ID |
   | `R2_BUCKET` | `siddhartha-testimonials` |
   | `R2_ACCESS_KEY_ID` | Bucket-scoped R2 access key |
   | `R2_SECRET_ACCESS_KEY` | Bucket-scoped R2 secret key |

5. Create the Blueprint and wait for the service to deploy.
6. Copy its HTTPS URL, such as `https://siddhartha-testimonials-api.onrender.com`. This is the value called `API_ORIGIN` below.
7. Open `https://YOUR-RENDER-SERVICE.onrender.com/api/health`. A working database connection returns:

   ```json
   { "status": "ok" }
   ```

The placeholder origins let the API start safely before the frontend URLs exist. Form submission and admin login remain blocked until you replace them in step 7.

If you create the Render service manually instead of using the Blueprint, leave **Root Directory** empty and use:

```text
Build command: npm ci && npm run build -w @testimonials/api
Start command: npm run start -w @testimonials/api
Health check: /api/health
```

Do not add a persistent disk. R2 stores uploads, and TiDB stores relational data.

## 5. Deploy the admin dashboard to Vercel

1. In Vercel, choose **Add New → Project** and import the GitHub repository.
2. Name the project, for example `siddhartha-testimonials-admin`.
3. Set **Root Directory** to `apps/admin`.
4. Keep the detected Vite framework settings. `apps/admin/vercel.ts` supplies the install command, build command, output directory, and API rewrite.
5. Add these Production environment variables:

   | Variable | Value |
   | --- | --- |
   | `API_ORIGIN` | The Render HTTPS origin, without a trailing slash |
   | `VITE_WEBSITE_URL` | Temporarily `https://public-placeholder.invalid` |

6. Deploy and copy the stable production URL from **Settings → Domains**, such as `https://siddhartha-testimonials-admin.vercel.app`.

Use the stable production domain, not a commit-specific preview URL.

## 6. Deploy the public website to Vercel

1. Import the same GitHub repository into a second Vercel project.
2. Name it, for example `siddhartha-testimonials`.
3. Set **Root Directory** to `apps/website`.
4. Keep the detected Vite framework settings. `apps/website/vercel.ts` supplies the deployment configuration and API rewrite.
5. Add these Production environment variables:

   | Variable | Value |
   | --- | --- |
   | `API_ORIGIN` | The Render HTTPS origin, without a trailing slash |
   | `VITE_ADMIN_URL` | The stable admin Vercel URL from step 5 |

6. Deploy and copy the stable production URL, such as `https://siddhartha-testimonials.vercel.app`.

## 7. Connect the final origins

1. Return to the admin Vercel project.
2. Replace `VITE_WEBSITE_URL` with the stable public Vercel URL and redeploy the admin project once.
3. Return to the Render service’s environment settings.
4. Set:

   ```dotenv
   PUBLIC_ORIGIN=https://YOUR-PUBLIC-PROJECT.vercel.app
   ADMIN_ORIGIN=https://YOUR-ADMIN-PROJECT.vercel.app
   ```

5. Save the Render settings and allow its automatic deploy/restart to finish.

Origins must contain only the scheme and hostname, with no path or trailing slash. The values must exactly match the URLs shown in the browser. These checks protect form submissions and authenticated admin writes.

Vercel preview deployments have changing hostnames and are intentionally not authorized for submissions or admin login. Review production write flows on the stable production domains.

## 8. Optional custom domains

You can stop with the supplied `vercel.app` URLs. If you add custom domains later:

1. Add one domain to each Vercel project, for example:

   ```text
   testimonials.example.com
   testimonials-admin.example.com
   ```

2. Change `VITE_ADMIN_URL` and `VITE_WEBSITE_URL` to the new domains and redeploy both Vercel projects.
3. Change `PUBLIC_ORIGIN` and `ADMIN_ORIGIN` on Render to the same new origins.
4. Test login and submission again.

No API custom domain is required because Vercel proxies `/api` to Render.

## 9. Production verification

Complete these checks from a normal browser window:

1. Open the public website over HTTPS.
2. Decline location access and submit a testimonial without a photo.
3. Submit a second testimonial with an allowed JPEG, PNG, or WebP image under 5 MB.
4. Open the admin website and sign in.
5. Confirm that both submissions are pending and that private location/submission metadata is not shown publicly.
6. Approve one testimonial and confirm that it appears on the public website with its photo.
7. Edit, unpublish, export, and soft-delete a test testimonial.
8. Sign out and confirm that refreshing the admin dashboard returns to the login screen.
9. Check the R2 bucket and confirm that the re-encoded `.webp` photo exists while the bucket remains private.
10. Check Render logs for unexpected database, storage, or origin errors. The API deliberately avoids logging testimonial contents, passwords, and coordinates.

The first API request after Render’s free service has slept may take about a minute. A timeout during that wake-up does not indicate lost data; reload after the service starts. TiDB and R2 remain persistent while Render sleeps.

## 10. Future deployments and maintenance

After setup, pushes to the connected production branch automatically deploy all three application services. TiDB Cloud and R2 do not need redeployment when application code changes.

Routine work is limited to:

- Reviewing dependency and provider security notices.
- Monitoring free-tier usage in TiDB, R2, Render, and Vercel.
- Exporting periodic database backups and testing restoration.
- Rotating the TiDB and R2 credentials if they are exposed.
- Upgrading Render if cold starts become unacceptable.

Do not use uptime-pinging services to prevent Render’s free instance from sleeping. Sleeping is part of the free plan, and keeping it artificially active can consume the monthly instance allowance.

### Credential rotation

When rotating a secret, update it in Render and wait for the service restart. R2 keys should stay bucket-scoped. Delete the old key only after `/api/health`, a test upload, and an approved-photo read succeed with the new key.

### Backups

CSV export is useful for content review but is not a complete relational backup. Periodically create a MySQL-compatible logical dump from TiDB and store it encrypted outside the application accounts. R2 objects should also be copied or covered by an appropriate retention policy. Soft deletion retains both the database record and photo; it is not a privacy erasure workflow.

## Troubleshooting

### `/api/health` returns 503

Check the TiDB host, port, username, password, database name, and `DB_SSL=true`. Confirm that the database exists and that the Starter quota has not been exhausted.

### The public page loads but submission returns 403

`PUBLIC_ORIGIN` on Render does not exactly match the public URL in the browser. Use only the HTTPS origin, with no trailing slash.

### Admin login returns 403

`ADMIN_ORIGIN` does not exactly match the admin URL. Confirm that `/api/admin/login` is being requested from the admin Vercel domain through the `/api` rewrite.

### Admin login succeeds but immediately disappears

Confirm that the browser calls `/api` on the Vercel domain rather than calling `onrender.com` directly. The supplied Vercel rewrite is what makes the secure host-only cookie first-party.

### Upload returns 500

Verify `STORAGE_DRIVER=r2`, the account ID, bucket name, and R2 credentials. Confirm that the token has Object Read & Write permission for the selected bucket.

### Vercel build says `API_ORIGIN` is missing

Add `API_ORIGIN` to that Vercel project’s Production environment variables and redeploy. Set it to the Render HTTPS origin without a trailing slash.
