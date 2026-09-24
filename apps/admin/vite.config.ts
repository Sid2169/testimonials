// Vite configuration for the ADMIN dashboard dev server.
//
// Runs on port 5174 (the website uses 5173) and proxies /api to the same
// local Express API on 3000, so cookies stay same-origin in development.
// `strictPort` fails loudly if the port is taken instead of silently
// renumbering, because ADMIN_ORIGIN in apps/api/.env expects this value.
import { defineConfig } from 'vite';
export default defineConfig({ server: { port: 5174, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3000' } } });