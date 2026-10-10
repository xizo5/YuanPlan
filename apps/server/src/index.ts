import { serve } from '@hono/node-server';
import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db/index.js';
const server = serve({ fetch: app.fetch, hostname: config.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1', port: config.PORT }, () => console.log(`YuanPlan API listening on port ${config.PORT}`));
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => { server.close(() => { void pool.end().then(() => process.exit(0)); }); });
