// Application entry point. This file is what actually LISTENS on a port —
// createApp() only constructs the app, listening is this script's job, and it
// also handles graceful shutdown so in-flight requests finish on SIGINT/SIGTERM
// (the signals Docker/Kubernetes send when stopping a container).

import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const server = createApp().listen(config.PORT, () => console.log(`API listening at http://localhost:${config.PORT}`));
// Longest time allowed for any single request response (streams included).
server.requestTimeout = 30_000;

// Graceful shutdown: stop accepting new connections, finish current work,
// close the DB pool, then exit. A 10-second bail-out forces exit if shutdown
// hangs (e.g. a stuck request), so the container can be replaced.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => { void pool.end().then(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
});