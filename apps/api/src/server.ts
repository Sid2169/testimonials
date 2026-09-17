import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const server = createApp().listen(config.PORT, () => console.log(`API listening at http://localhost:${config.PORT}`));
server.requestTimeout = 30_000;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => { void pool.end().then(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
});
