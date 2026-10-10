import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sql } from 'drizzle-orm';
import { app } from '../apps/server/src/app';
import { db, one, pool } from '../apps/server/src/db';
import { migrate } from '../apps/server/src/db/migrate';
import * as projects from '../apps/server/src/modules/projects';
import * as resources from '../apps/server/src/modules/resources';
import * as credentials from '../apps/server/src/modules/credentials';
import type { Actor } from '../apps/server/src/modules/core';
import { bridgeConfig } from '../packages/mcp-stdio/src/config';

const bridgePath = fileURLToPath(new URL('../packages/mcp-stdio/src/index.ts', import.meta.url));
const tsxPath = import.meta.resolve('tsx');
const bridgeArgs = process.env.YUANPLAN_MCP_TEST_ENTRY
  ? [resolve(process.env.YUANPLAN_MCP_TEST_ENTRY)] : ['--import', tsxPath, bridgePath];
const actor: Actor = { userId: randomUUID(), source: 'web' };
let server: HttpServer;
let url: string;
const clients: Client[] = [];
const children: ChildProcess[] = [];

beforeAll(async () => {
  await migrate(process.env.TEST_DATABASE_URL);
  await db.execute(sql`INSERT INTO users(id,name,email,identity_source) VALUES(${actor.userId},'Bridge test',${`${actor.userId}@example.test`},'invite')`);
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as HttpServer;
  await once(server, 'listening');
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mcp`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    }
  }
});
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await pool.end();
});

async function fixture(scope: 'read' | 'write' = 'write') {
  const project = await projects.createProject(actor, { name: 'Stdio integration' }, randomUUID());
  const credential = await credentials.createCredential(actor, { name: 'Stdio test', projectIds: [project.id], scope }, randomUUID());
  return { project, credential };
}

async function connect(token: string) {
  const client = new Client({ name: 'stdio-integration-client', version: '1.0.0' });
  clients.push(client);
  const transport = new StdioClientTransport({
    command: process.execPath, args: bridgeArgs, cwd: tmpdir(),
    env: { YUANPLAN_MCP_URL: url, YUANPLAN_MCP_TOKEN: token }, stderr: 'pipe',
  });
  let diagnostic = '';
  transport.stderr?.on('data', chunk => { diagnostic += chunk.toString(); });
  await client.connect(transport, { timeout: 10000 });
  return { client, diagnostic: () => diagnostic };
}

function content(result: CallToolResult | Awaited<ReturnType<Client['callTool']>>) {
  const first = (result.content as CallToolResult['content'])[0];
  if (first.type !== 'text') throw new Error('Expected text tool result');
  return JSON.parse(first.text);
}

function raw(env: Record<string, string>) {
  const child = spawn(process.execPath, bridgeArgs, {
    env: { ...getDefaultEnvironment(), ...env }, cwd: tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  return { child, output: () => ({ stdout, stderr }), closed: once(child, 'close') };
}

describe('stdio to HTTP MCP bridge', () => {
  it('preserves tool schemas and annotations and enforces project scope', async () => {
    const { project, credential } = await fixture();
    const { client, diagnostic } = await connect(credential.token);
    const direct = new Client({ name: 'direct-comparison', version: '1.0.0' }); clients.push(direct);
    await direct.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${credential.token}` } } }));
    expect(await client.listTools()).toEqual(await direct.listTools());
    expect(client.getServerVersion()?.name).toBe('yuanplan-stdio');
    expect(content(await client.callTool({ name: 'list_projects', arguments: {} })).map((p: { id: string }) => p.id)).toEqual([project.id]);
    const other = await projects.createProject(actor, { name: 'Outside credential' }, randomUUID());
    const denied = await client.callTool({ name: 'get_project', arguments: { projectId: other.id } });
    expect(denied.isError).toBe(true); expect(content(denied).code).toBe('CREDENTIAL_SCOPE');
    expect(diagnostic()).not.toContain(credential.token);
  });

  it('preserves task and Wiki writes, conflicts, idempotency and MCP audit attribution', async () => {
    const { project, credential } = await fixture();
    const { client } = await connect(credential.token);
    const operationId = randomUUID();
    const call = { name: 'create_task', arguments: { projectId: project.id, title: 'From stdio', operationId } };
    const first = content(await client.callTool(call));
    expect(content(await client.callTool(call))).toMatchObject({ id: first.id, version: 1 });
    const updated = content(await client.callTool({ name: 'update_task', arguments: { projectId: project.id, id: first.id, expectedVersion: 1, operationId: randomUUID(), changes: { status: 'done' } } }));
    expect(updated).toMatchObject({ id: first.id, status: 'done', version: 2 });
    const conflict = await client.callTool({ name: 'update_task', arguments: { projectId: project.id, id: first.id, expectedVersion: 1, operationId: randomUUID(), changes: { title: 'Stale' } } });
    expect(conflict.isError).toBe(true); expect(content(conflict).code).toBe('VERSION_CONFLICT');
    expect((await resources.history(actor, project.id, 'task', first.id)).items).toHaveLength(2);
    expect(await one(db, sql`SELECT actor_id,credential_id,source FROM audit_events WHERE operation_id=${operationId}`)).toMatchObject({ actorId: actor.userId, credentialId: credential.id, source: 'mcp' });
    const doc = content(await client.callTool({ name: 'create_document', arguments: { projectId: project.id, title: 'Bridge Wiki', markdown: '# Stdio document\n\n保存中文内容。', operationId: randomUUID() } }));
    const read = content(await client.callTool({ name: 'get_document', arguments: { projectId: project.id, id: doc.id } }));
    expect(read.markdown).toContain('保存中文内容。'); expect(read.version).toBe(1);
  });

  it('rejects writes with a read-only credential and rechecks revocation on the same stdio connection', async () => {
    const { project, credential } = await fixture('read');
    const { client, diagnostic } = await connect(credential.token);
    const operationId = randomUUID();
    const denied = await client.callTool({ name: 'create_task', arguments: { projectId: project.id, title: 'Denied', operationId } });
    expect(denied.isError).toBe(true); expect(content(denied).code).toBe('CREDENTIAL_SCOPE');
    expect((await resources.listTasks(actor, project.id)).items).toHaveLength(0);
    expect(await one(db, sql`SELECT id FROM audit_events WHERE operation_id=${operationId}`)).toBeUndefined();
    await credentials.revokeCredential(actor, credential.id, randomUUID());
    await expect(client.listTools()).rejects.toThrow('YuanPlan request failed');
    await expect(client.callTool({ name: 'list_projects', arguments: {} })).rejects.toThrow('YuanPlan request failed');
    expect(diagnostic()).not.toContain(credential.token);
  });

  it('exits cleanly on stdin EOF and emits only JSON-RPC on stdout', async () => {
    const { credential } = await fixture();
    const process = raw({ YUANPLAN_MCP_URL: url, YUANPLAN_MCP_TOKEN: credential.token });
    process.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'eof-client', version: '1' } } }) + '\n');
    await vi.waitFor(() => expect(process.output().stdout).toContain('"id":1'), { timeout: 10000 });
    process.child.stdin!.end();
    await vi.waitFor(() => expect(process.child.exitCode).toBe(0), { timeout: 5000 });
    await process.closed;
    for (const line of process.output().stdout.trim().split('\n')) expect(JSON.parse(line).jsonrpc).toBe('2.0');
    expect(process.output().stderr).toBe('');
  });

  it('fails closed without logging an invalid credential or emitting stdout', async () => {
    const token = `yp_invalid_${randomUUID()}`;
    const process = raw({ YUANPLAN_MCP_URL: url, YUANPLAN_MCP_TOKEN: token });
    await vi.waitFor(() => expect(process.child.exitCode).toBe(1), { timeout: 10000 });
    expect(process.output().stdout).toBe('');
    expect(process.output().stderr).toContain('Cannot start');
    expect(process.output().stderr).not.toContain(token);
  });

  it('rejects redirects before forwarding the credential to another endpoint', async () => {
    let targetRequests = 0;
    const target = createServer((_req, res) => { targetRequests++; res.writeHead(500).end(); });
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}/api/mcp`;
    let redirectRequests = 0;
    const redirect = createServer((_req, res) => { redirectRequests++; res.writeHead(307, { Location: targetUrl }).end(); });
    redirect.listen(0, '127.0.0.1'); await once(redirect, 'listening');
    try {
      const process = raw({ YUANPLAN_MCP_URL: `http://127.0.0.1:${(redirect.address() as { port: number }).port}/api/mcp`, YUANPLAN_MCP_TOKEN: 'yp_redirect_test' });
      await vi.waitFor(() => expect(process.child.exitCode).toBe(1), { timeout: 10000 });
      expect(redirectRequests).toBeGreaterThan(0);
      expect(targetRequests).toBe(0); expect(process.output().stdout).toBe('');
    } finally {
      redirect.closeAllConnections(); target.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => redirect.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
    }
  });
});

it('accepts secure endpoints and loopback HTTP, rejects ambiguous or credential-bearing URLs', () => {
  const token = 'yp_config_test';
  for (const url of ['https://example.test/api/mcp', 'http://localhost:18420/api/mcp', 'http://127.0.0.1:18420/api/mcp', 'http://[::1]:18420/api/mcp']) {
    expect(bridgeConfig({ YUANPLAN_MCP_URL: url, YUANPLAN_MCP_TOKEN: token }).token).toBe(token);
  }
  for (const url of ['', 'file:///tmp/mcp', 'http://example.test/api/mcp', 'https://user:password@example.test/api/mcp', 'https://example.test/api/mcp?token=secret', 'https://example.test/api/mcp#secret']) {
    expect(() => bridgeConfig({ YUANPLAN_MCP_URL: url, YUANPLAN_MCP_TOKEN: token })).toThrow();
  }
  expect(() => bridgeConfig({ YUANPLAN_MCP_URL: 'http://localhost/api/mcp' })).toThrow('YUANPLAN_MCP_TOKEN');
});
