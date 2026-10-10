import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { bridgeConfig } from './config.js';

const upstream = new Client({ name: 'yuanplan-stdio-bridge', version: '0.1.0' });
// A low-level server preserves the remote schemas and annotations verbatim.
const downstream = new Server({ name: 'yuanplan-stdio', version: '0.1.0' }, { capabilities: { tools: {} } });
let closing: Promise<void> | undefined;
function close() {
  return closing ??= (async () => {
    await Promise.allSettled([downstream.close(), upstream.close()]);
    process.stdin.pause();
  })();
}

async function forward<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch {
    // Do not echo SDK/HTTP errors: an untrusted response may contain credentials.
    throw new McpError(ErrorCode.InternalError, 'YuanPlan request failed. Check the endpoint, credential and permissions; read the current state before retrying a write with the same operationId.');
  }
}

async function main() {
  const { url, token } = bridgeConfig(process.env);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (input, init) => fetch(input, {
      ...init, redirect: 'error',
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    }),
  });
  upstream.onerror = () => {}; // Errors are reported through the sanitized request path.
  downstream.onerror = () => { console.error('[YuanPlan MCP] Invalid stdio protocol input.'); };
  downstream.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
    forward(() => upstream.listTools(request.params, { signal: extra.signal, timeout: 30000 })));
  downstream.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    forward(() => upstream.callTool(request.params, CallToolResultSchema, { signal: extra.signal, timeout: 30000 })));

  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  process.stdin.once('end', () => { void close(); });
  await upstream.connect(transport, { timeout: 10000 });
  if (!closing) await downstream.connect(new StdioServerTransport());
}

main().catch(async () => {
  console.error('[YuanPlan MCP] Cannot start. Check YUANPLAN_MCP_URL, YUANPLAN_MCP_TOKEN and server availability.');
  process.exitCode = 1;
  await close();
});
