// Vercel deployment settings for the ADMIN project, evaluated at build time.
// Functionally identical to apps/website/vercel.ts, but builds/installs the
// admin workspace and the API_ORIGIN rewrite applies to this separate project.
// Keeping a copy per app lets each Vercel project wire ONLY its own build.

import { routes, type VercelConfig } from '@vercel/config/v1';

// Required Production environment variable in Vercel; must be HTTPS.
const apiOrigin = process.env.API_ORIGIN?.replace(/\/$/, '');
if (!apiOrigin || new URL(apiOrigin).protocol !== 'https:') {
  throw new Error('Set API_ORIGIN to the HTTPS URL of the Render API service.');
}

export const config: VercelConfig = {
  framework: 'vite',
  installCommand: 'cd ../.. && npm ci',
  buildCommand: 'cd ../.. && npm run build -w @testimonials/admin',
  outputDirectory: 'dist',
  rewrites: [routes.rewrite('/api/:path*', `${apiOrigin}/api/:path*`)],
};