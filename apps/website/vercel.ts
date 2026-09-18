const apiOrigin = process.env.API_ORIGIN?.replace(/\/$/, '');
if (!apiOrigin || new URL(apiOrigin).protocol !== 'https:') {
  throw new Error('Set API_ORIGIN to the HTTPS URL of the Render API service.');
}

export const config = {
  framework: 'vite',
  installCommand: 'cd ../.. && npm ci',
  buildCommand: 'cd ../.. && npm run build -w @testimonials/website',
  outputDirectory: 'dist',
  rewrites: [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }],
};
