// Vite configuration for the PUBLIC website dev server.
//
// In development, the site runs on port 5173 while the Express API runs on
// port 3000 — two different ports, therefore two different "origins". The
// proxy below forwards any `/api/...` request from this dev server to the
// API as if it were same-origin, so cookies and Origin checks behave exactly
// like they will in production (where a real reverse proxy does this job).
// `strictPort` fails loudly if the port is taken instead of silently
// renumbering, because PUBLIC_ORIGIN in apps/api/.env expects this value.
import { defineConfig } from 'vite';
export default defineConfig({ server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3000' } } });