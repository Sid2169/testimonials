import { migrate, pool } from './db.js';
try { await migrate(); console.log('Database schema is ready.'); }
finally { await pool.end(); }
