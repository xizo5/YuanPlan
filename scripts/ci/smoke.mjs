import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export async function smoke(root, env) {
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], { cwd: root, env, stdio: 'inherit' });
  let failure;
  child.on('error', error => { failure = error; });
  const exited = once(child, 'exit').catch(() => {});
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error('Built server failed to start');
      try {
        const response = await fetch(`${env.APP_URL}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).status === 'ok') { ready = true; break; }
      } catch {}
      await delay(500);
    }
    if (!ready) throw new Error('Built server health check timed out');
    const page = await fetch(env.APP_URL, { signal: AbortSignal.timeout(5000) });
    const html = await page.text();
    if (!page.ok || !html.includes('<html') || !html.includes('/assets/')) throw new Error('Built web page missing');
    const asset = html.match(/(?:src|href)="(\/assets\/[^"<>]+\.js)"/)?.[1];
    if (!asset) throw new Error('Built web JavaScript missing');
    const js = await fetch(new URL(asset, env.APP_URL), { signal: AbortSignal.timeout(5000) });
    if (!js.ok || !(js.headers.get('content-type') ?? '').includes('javascript')) throw new Error('Built web asset unavailable');
    const notices = await fetch(new URL('/third-party-notices.txt', env.APP_URL), { signal: AbortSignal.timeout(5000) });
    if (!notices.ok || !(await notices.text()).startsWith('YuanPlan third-party license notices')) throw new Error('Third-party notices are not served');
    console.log('[CI] Built API, web page, JavaScript and license notices smoke check passed');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await exited;
  }
}
