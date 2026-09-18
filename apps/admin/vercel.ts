import { routes, type VercelConfig } from '@vercel/config/v1';

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
