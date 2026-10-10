import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, workspaceRoot, '');
  const apiUrl = env.VITE_API_URL || `http://127.0.0.1:${env.PORT || '18420'}`;
  if (command === 'serve') console.log(`[YuanPlan] API proxy: ${apiUrl}`);
  return {
    plugins: [react(), {
      name: 'yuanplan-api-ready',
      async configureServer() {
        const deadline = Date.now() + 30000;
        console.log('[YuanPlan] Waiting for API and database...');
        while (Date.now() < deadline) {
          try {
            const response = await fetch(`${apiUrl.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(1000) });
            if (response.ok && (await response.json()).status === 'ok') {
              console.log('[YuanPlan] API ready');
              return;
            }
          } catch { /* The API may still be starting alongside Vite. */ }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error('API 未在 30 秒内就绪。请检查 [api] 日志、数据库连接及 PORT / VITE_API_URL 配置。');
      },
    }],
    server: { port: 5173, strictPort: true, proxy: { '/api': apiUrl } },
    build: { manifest: true, chunkSizeWarningLimit: 650 },
  };
});
