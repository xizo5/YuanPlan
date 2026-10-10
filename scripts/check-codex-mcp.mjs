import 'dotenv/config';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { serve } from '@hono/node-server';

// No model turns are started. This checks the installed Codex MCP runtime in an
// isolated home with an ephemeral, non-persisted protocol context.
if (!process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('A dedicated *_test database is required');
}
const bridgeEntry = resolve('packages/mcp-stdio/dist/index.js');
await access(bridgeEntry); // Build first, so the actual desktop command is tested.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
const { sql } = await import('drizzle-orm');
const { db, pool, one } = await import('../apps/server/src/db/index.ts');
const { migrate } = await import('../apps/server/src/db/migrate.ts');
const { app } = await import('../apps/server/src/app.ts');
const projects = await import('../apps/server/src/modules/projects.ts');
const resources = await import('../apps/server/src/modules/resources.ts');
const credentials = await import('../apps/server/src/modules/credentials.ts');
const issued = [];
const actor = { userId: randomUUID(), source: 'web' };
let child, server, lines;
const pending = new Map();
let nextId = 1;

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex timed out: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
function result(value) {
  assert.notEqual(value.isError, true, 'Expected successful MCP tool result');
  assert.equal(value.content[0]?.type, 'text');
  return JSON.parse(value.content[0].text);
}
function toolError(value, code) {
  assert.equal(value.isError, true);
  assert.equal(JSON.parse(value.content[0].text).code, code);
}

try {
  await migrate(process.env.TEST_DATABASE_URL);
  await db.execute(sql`INSERT INTO users(id,name,email,identity_source) VALUES(${actor.userId},'Codex verification',${`${actor.userId}@example.test`},'invite')`);
  const project = await projects.createProject(actor, { name: 'Codex runtime verification' }, randomUUID());
  const other = await projects.createProject(actor, { name: 'Outside Codex credential' }, randomUUID());
  for (const scope of ['write', 'read']) {
    issued.push(await credentials.createCredential(actor, {
      name: `Codex ${scope} verification`, projectIds: [project.id], scope,
      expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
    }, randomUUID()));
  }
  const protocolVersions = new Set();
  server = serve({ hostname: '127.0.0.1', port: 0, fetch: async (request, bindings) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/mcp') {
      const body = await request.clone().json().catch(() => ({}));
      if (body.method === 'initialize') protocolVersions.add(body.params?.protocolVersion);
    }
    return app.fetch(request, bindings);
  } });
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/api/mcp`;
  await mkdir('.data', { recursive: true });
  const scratch = await mkdtemp(resolve('.data/codex-mcp-'));
  const runtimeHome = resolve(scratch, 'home');
  await mkdir(runtimeHome);
  await writeFile(resolve(runtimeHome, 'config.toml'),
    `[mcp_servers.yuanplan]\nurl = ${JSON.stringify(endpoint)}\nbearer_token_env_var = "YUANPLAN_MCP_TOKEN"\n` +
    `[mcp_servers.yuanplan_readonly]\nurl = ${JSON.stringify(endpoint)}\nbearer_token_env_var = "YUANPLAN_MCP_READ_TOKEN"\n` +
    `[mcp_servers.yuanplan_stdio]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(bridgeEntry)}]\nenv_vars = ["YUANPLAN_MCP_URL", "YUANPLAN_MCP_TOKEN"]\n`);
  child = spawn(process.env.CODEX_BIN ?? (process.platform === 'win32' ? 'codex.exe' : 'codex'), ['app-server', '--stdio'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: runtimeHome, YUANPLAN_MCP_URL: endpoint, YUANPLAN_MCP_TOKEN: issued[0].token, YUANPLAN_MCP_READ_TOKEN: issued[1].token },
  });
  child.stderr.resume();
  const rejectPending = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Codex runtime disconnected')); }
    pending.clear();
  };
  child.on('error', rejectPending);
  child.on('close', rejectPending);
  lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (pending.has(message.id)) {
      const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) {
        // Keep the code for assertions, but never print raw server error bodies.
        const error = new Error('Codex MCP request rejected'); error.code = message.error.code;
        request.reject(error);
      } else request.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported in verification client' } }) + '\n');
    }
  });
  const init = await rpc('initialize', { clientInfo: { name: 'yuanplan-verification', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const inventory = await rpc('mcpServerStatus/list');
  for (const name of ['yuanplan', 'yuanplan_readonly']) {
    const status = inventory.data.find(item => item.name === name);
    assert.equal(status?.authStatus, 'bearerToken');
    assert.equal(status.toolsError, null);
    assert.ok(status.tools.create_task && status.tools.get_document);
  }
  const bridged = inventory.data.find(item => item.name === 'yuanplan_stdio');
  assert.equal(bridged?.toolsError, null);
  assert.deepEqual(Object.keys(bridged.tools).sort(), Object.keys(inventory.data.find(item => item.name === 'yuanplan').tools).sort());
  const started = await rpc('thread/start', { cwd: process.cwd(), ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' });
  const threadId = started.thread.id;
  const call = (tool, args, name = 'yuanplan') => rpc('mcpServer/tool/call', { threadId, server: name, tool, arguments: args });
  assert.deepEqual(result(await call('list_projects', {})).map(p => p.id), [project.id]);
  assert.deepEqual(result(await call('list_projects', {}, 'yuanplan_stdio')).map(p => p.id), [project.id]);
  toolError(await call('get_project', { projectId: other.id }), 'CREDENTIAL_SCOPE');
  toolError(await call('create_task', { projectId: project.id, title: 'Denied', operationId: randomUUID() }, 'yuanplan_readonly'), 'CREDENTIAL_SCOPE');
  assert.equal((await resources.listTasks(actor, project.id)).items.length, 0);
  const operationId = randomUUID();
  const create = { projectId: project.id, title: 'Created by Codex runtime', operationId };
  const task = result(await call('create_task', create));
  assert.equal(task.version, 1);
  assert.deepEqual(result(await call('create_task', create)), task);
  assert.equal(result(await call('update_task', { projectId: project.id, id: task.id, expectedVersion: 1, operationId: randomUUID(), changes: { status: 'done' } })).version, 2);
  toolError(await call('update_task', { projectId: project.id, id: task.id, expectedVersion: 1, operationId: randomUUID(), changes: { title: 'Stale' } }), 'VERSION_CONFLICT');
  assert.equal((await resources.history(actor, project.id, 'task', task.id)).items.length, 2);
  assert.deepEqual(await one(db, sql`SELECT actor_id,credential_id,source FROM audit_events WHERE operation_id=${operationId}`), { actorId: actor.userId, credentialId: issued[0].id, source: 'mcp' });
  const document = result(await call('create_document', { projectId: project.id, title: 'Codex Wiki', markdown: '# Codex\n\n中文接入验证。', operationId: randomUUID() }));
  assert.match(result(await call('get_document', { projectId: project.id, id: document.id })).markdown, /中文接入验证/);
  const bridgedTask = result(await call('create_task', { projectId: project.id, title: 'Codex through stdio', operationId: randomUUID() }, 'yuanplan_stdio'));
  assert.equal((await resources.getResource(actor, project.id, 'task', bridgedTask.id)).title, 'Codex through stdio');
  await credentials.revokeCredential(actor, issued[0].id, randomUUID());
  await assert.rejects(call('list_projects', {}), error => Number.isInteger(error.code));
  await assert.rejects(call('list_projects', {}, 'yuanplan_stdio'), error => Number.isInteger(error.code));
  const report = {
    runtime: init.userAgent, protocolVersions: [...protocolVersions],
    tools: Object.keys(inventory.data.find(item => item.name === 'yuanplan').tools).length,
    passed: ['authentication', 'discovery', 'project scope', 'read-only rejection', 'task write', 'idempotency', 'version conflict', 'Wiki round-trip', 'audit attribution', 'revocation', 'built stdio bridge read/write/revocation'],
    modelTurns: 0, scope: 'Installed Codex app-server runtime; not desktop UI interaction or Claude Desktop validation',
  };
  await writeFile(resolve(scratch, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close'); child.kill(); await closed;
  }
  lines?.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  // Revoke even if protocol negotiation or an assertion failed.
  try { for (const credential of issued) await credentials.revokeCredential(actor, credential.id, randomUUID()); }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool.end();
  }
}
