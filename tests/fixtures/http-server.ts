import { serve } from '@hono/node-server';
import { app } from '../../apps/server/src/app';

// This process is killed by fault tests. Never allow it to use the development DB.
if (process.env.NODE_ENV !== 'test' || !process.env.DATABASE_URL ||
    !new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Fault server requires a dedicated *_test database');
}
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, address => {
  process.send?.({ port: address.port });
});
