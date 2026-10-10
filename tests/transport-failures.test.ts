import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, one, pool } from '../apps/server/src/db';
import { migrate } from '../apps/server/src/db/migrate';
import { createProject } from '../apps/server/src/modules/projects';
import { createTask, getResource, history } from '../apps/server/src/modules/resources';
import { createCredential } from '../apps/server/src/modules/credentials';
import type { Actor } from '../apps/server/src/modules/core';

afterAll(async () => { await pool.end(); });

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
}

async function start() {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  const applicationName = `yuanplan-fault-${randomUUID()}`;
  url.searchParams.set('application_name', applicationName);
  const child = fork(fileURLToPath(new URL('./fixtures/http-server.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], silent: true,
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: url.toString(), APP_URL: 'http://127.0.0.1' },
  });
  // Drain output but never echo a child error containing connection details.
  child.stdout?.resume();
  child.stderr?.resume();
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fault server startup timed out')), 10000);
      child.once('message', message => { clearTimeout(timeout); resolve((message as { port: number }).port); });
      child.once('error', () => { clearTimeout(timeout); reject(new Error('Fault server failed to start')); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Fault server exited before ready')); });
    });
    return { child, applicationName, url: `http://127.0.0.1:${port}/api/mcp` };
  } catch (error) { await stop(child); throw error; }
}

async function fixture() {
  await migrate(process.env.TEST_DATABASE_URL);
  const actor: Actor = { userId: randomUUID(), source: 'web' };
  await db.execute(sql`INSERT INTO users(id,name,email,identity_source) VALUES(${actor.userId},'Fault test',${`${actor.userId}@example.test`},'invite')`);
  const project = await createProject(actor, { name: 'Transport fault test' }, randomUUID());
  const task = await createTask(actor, project.id, { title: 'Original' }, randomUUID());
  const credential = await createCredential(actor, { name: 'Fault client', projectIds: [project.id], scope: 'write' }, randomUUID());
  const operation = randomUUID();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'update_task', arguments: { projectId: project.id, id: task.id, expectedVersion: 1, operationId: operation, changes: { title: 'Committed through HTTP' } },
  } });
  const send = (url: string) => fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body, signal: AbortSignal.timeout(10000),
  });
  return { actor, project, task, operation, send };
}

it('retries a committed MCP write after its HTTP response is dropped without duplicating history', async () => {
  const f = await fixture();
  const server = await start();
  let upstreamStatus: number | undefined;
  const proxy = createServer((incoming, outgoing) => {
    const upstream = request(server.url, { method: incoming.method, headers: incoming.headers }, response => {
      upstreamStatus = response.statusCode;
      response.resume();
      // Consume the entire committed response, then close without forwarding bytes.
      response.on('end', () => outgoing.destroy());
    });
    upstream.on('error', () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  try {
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const address = proxy.address() as { port: number };
    await expect(f.send(`http://127.0.0.1:${address.port}/api/mcp`)).rejects.toThrow();
    expect(upstreamStatus).toBe(200);
    expect(await getResource(f.actor, f.project.id, 'task', f.task.id)).toMatchObject({ title: 'Committed through HTTP', version: 2 });
    const response = await f.send(server.url);
    expect(response.status).toBe(200);
    const rpc = await response.json();
    expect(rpc.result.isError).not.toBe(true);
    expect(JSON.parse(rpc.result.content[0].text)).toMatchObject({ id: f.task.id, version: 2 });
    expect((await history(f.actor, f.project.id, 'task', f.task.id)).items).toHaveLength(2);
    expect((await one(db, sql`SELECT count(*)::int AS count FROM audit_events WHERE operation_id=${f.operation}`))?.count).toBe(1);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await stop(server.child);
  }
});

it('rolls back a task write when the API process dies before audit insertion and permits retry after restart', async () => {
  const f = await fixture();
  const server = await start();
  const blocker = await pool.connect();
  let pending: Promise<PromiseSettledResult<Response>[]> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
    pending = Promise.allSettled([f.send(server.url)]);
    await vi.waitFor(async () => {
      const result = await pool.query("SELECT query FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [server.applicationName]);
      expect(result.rows.some(row => /INSERT INTO audit_events/i.test(row.query))).toBe(true);
    }, { timeout: 5000, interval: 20 });
    await stop(server.child);
    expect((await pending)[0].status).toBe('rejected');
    // A backend waiting on a table lock may only notice the closed client socket
    // after the lock is released. It never receives the transaction's COMMIT.
    await blocker.query('COMMIT');
    await vi.waitFor(async () => {
      const result = await pool.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1', [server.applicationName]);
      expect(result.rows).toHaveLength(0);
    }, { timeout: 5000, interval: 20 });
    expect(await getResource(f.actor, f.project.id, 'task', f.task.id)).toMatchObject({ title: 'Original', version: 1 });
    expect((await history(f.actor, f.project.id, 'task', f.task.id)).items).toHaveLength(1);
    expect(await one(db, sql`SELECT operation_id FROM operation_receipts WHERE actor_id=${f.actor.userId} AND operation_id=${f.operation}`)).toBeUndefined();
    const restarted = await start();
    try {
      const response = await f.send(restarted.url);
      expect(response.status).toBe(200);
      expect((await response.json()).result.isError).not.toBe(true);
      expect(await getResource(f.actor, f.project.id, 'task', f.task.id)).toMatchObject({ title: 'Committed through HTTP', version: 2 });
      expect((await history(f.actor, f.project.id, 'task', f.task.id)).items).toHaveLength(2);
    } finally { await stop(restarted.child); }
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await stop(server.child);
    await pending;
  }
});
