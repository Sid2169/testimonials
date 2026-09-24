// One-shot CLI: apply the database schema. Run via `npm run db:migrate`.
// Migrations are an explicit deploy step (see README), not something every
// API startup does, so a release can't surprise you mid-traffic.
// Top-level await is available because the workspace uses ES modules.

import { migrate, pool } from './db.js';
try { await migrate(); console.log('Database schema is ready.'); }
// pool.end() closes connections even if migrate() threw, so the CLI always
// exits cleanly.
finally { await pool.end(); }