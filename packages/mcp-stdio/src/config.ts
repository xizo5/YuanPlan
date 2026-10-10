export function bridgeConfig(env: NodeJS.ProcessEnv) {
  const token = env.YUANPLAN_MCP_TOKEN?.trim();
  if (!token || /\s/.test(token)) throw new Error('Set YUANPLAN_MCP_TOKEN to a YuanPlan project credential.');
  let url: URL;
  try { url = new URL(env.YUANPLAN_MCP_URL ?? ''); }
  catch { throw new Error('Set YUANPLAN_MCP_URL to the full /api/mcp endpoint URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS, or HTTP with a local loopback address.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The endpoint URL must not contain credentials, query parameters or a fragment.');
  }
  return { url, token };
}
