// Vercel deployment settings for this project, evaluated AT BUILD TIME by
// Vercel's build system (this file is imported by Vercel, not run by Node at
// runtime). It tells Vercel how to install, build, and — crucially — where to
// proxy `/api` requests to.
//
// Why a rewrite? The API lives on a different host (Render), but the browser
// must see the API as same-origin so cookies (e.g. the admin session) stay
// first-party. Vercel's rewrite transparently forwards `/api/...` to the API.

import { routes, type VercelConfig } from '@vercel/config/v1';

// API_ORIGIN is a required Production environment variable in Vercel (see
// docs/PRODUCTION_DEPLOYMENT.md). Strip any trailing slash and insist on
// https — a wrong value here would silently break login in production.
const apiOrigin = process.env.API_ORIGIN?.replace(/\/$/, '');
if (!apiOrigin || new URL(apiOrigin).protocol !== 'https:') {
  throw new Error('Set API_ORIGIN to the HTTPS URL of the Render API service.');
}

// Must be a named `config` export so Vercel picks it up (a default export is
// not always interpreted correctly — see the deployment guide's troubleshooting).
export const config: VercelConfig = {
  framework: 'vite',
  // Vercel's root directory is apps/website, so we walk up two levels to the
  // workspace root to install and build the correct workspace package.
  installCommand: 'cd ../.. && npm ci',
  buildCommand: 'cd ../.. && npm run build -w @testimonials/website',
  outputDirectory: 'dist',
  // Forward every /api request to the Render API, preserving the path.
  rewrites: [routes.rewrite('/api/:path*', `${apiOrigin}/api/:path*`)],
};