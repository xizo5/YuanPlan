import { useCallback, useEffect, useState } from 'react';
export class ApiError extends Error { constructor(public code: string, message: string, public details?: unknown) { super(message); } }
export async function api<T = any>(path: string, options: { method?: string; body?: unknown; operationId?: string; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['Idempotency-Key'] = options.operationId ?? crypto.randomUUID();
  if (options.body !== undefined && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers, body: options.body instanceof FormData ? options.body : options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(result.error?.code ?? 'REQUEST_FAILED', result.error?.message ?? result.message ?? '请求失败，请稍后重试', result.error?.details);
  return result as T;
}
export function useData<T>(path: string | null) {
  const [data, setData] = useState<T>(); const [error, setError] = useState<string>(); const [loading, setLoading] = useState(true); const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(r => r + 1), []);
  useEffect(() => { setData(undefined); if (!path) { setLoading(false); return; } const controller = new AbortController(); setLoading(true); setError(undefined); api<T>(path, { signal: controller.signal }).then(d => { setData(d); setLoading(false); }).catch(e => { if (e.name !== 'AbortError') { setError(e.message); setLoading(false); } }); return () => controller.abort(); }, [path, revision]);
  return { data, setData, error, loading, reload };
}
export function errorText(error: unknown) { return error instanceof Error ? error.message : '操作失败，请重试'; }
const dirtyChecks = new Set<() => boolean>();
export function registerDirty(check: () => boolean) { dirtyChecks.add(check); return () => { dirtyChecks.delete(check); }; }
export function confirmNavigation() { return ![...dirtyChecks].some(check => check()) || window.confirm('存在尚未保存的修改，确定放弃并离开吗？'); }
export function navigate(path: string) { if (!confirmNavigation()) return; window.history.pushState(null, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }
export function useRoute() {
  const [route, setRoute] = useState(() => ({ path: location.pathname + location.search, revision: 0 }));
  useEffect(() => {
    // Local tabs and filters use replaceState; explicit navigation must also work
    // when its destination matches the last path observed by the app.
    const change = () => setRoute(current => ({ path: location.pathname + location.search, revision: current.revision + 1 }));
    window.addEventListener('popstate', change);
    return () => window.removeEventListener('popstate', change);
  }, []);
  return route;
}
