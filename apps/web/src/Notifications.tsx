import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActionIcon, Badge, Button, Group, Popover, Stack, Text } from '@mantine/core';
import { IconBell } from '@tabler/icons-react';
import type { NotificationItem, NotificationPage } from '@yuanplan/contracts';
import { api, errorText, navigate } from './api';
import { Failure, Loading } from './ui';

const NotificationContext = createContext({ unreadCount: 0, revision: 0, error: '', refresh: () => {} });

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState('');
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const check = () => { if (!document.hidden) refresh(); };
    const timer = window.setInterval(check, 15_000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
    };
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    api<{ unreadCount: number }>('/notifications/unread-count', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setUnreadCount(result.unreadCount); setError(''); } })
      .catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, [revision]);
  return <NotificationContext.Provider value={{ unreadCount, revision, refresh, error }}>{children}</NotificationContext.Provider>;
}

function actionText(item: NotificationItem) {
  if (item.eventType === 'task.assigned' && item.actorName === '你') return '你为自己分配了任务';
  return `${item.actorName}${item.eventType === 'task.assigned' ? '将任务分配给你' : '评论了你负责的任务'}`;
}

export function NotificationBell() {
  const { unreadCount, revision, error: countError, refresh } = useContext(NotificationContext);
  const [opened, setOpened] = useState(false);
  const [data, setData] = useState<NotificationPage>();
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestId = useRef(0);
  const moreController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!opened) { moreController.current?.abort(); return; }
    const generation = ++requestId.current;
    const controller = new AbortController();
    moreController.current?.abort();
    setLoadingMore(false);
    setError('');
    api<NotificationPage>('/notifications?status=unread&page=1', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && requestId.current === generation) setData(result); })
      .catch(cause => { if (!controller.signal.aborted && requestId.current === generation) setError(errorText(cause)); });
    return () => controller.abort();
  }, [opened, revision]);

  async function loadMore() {
    if (!data || loadingMore || data.items.length >= data.total || busy || error) return;
    const generation = requestId.current;
    const controller = new AbortController();
    moreController.current = controller;
    setLoadingMore(true);
    try {
      const result = await api<NotificationPage>(`/notifications?status=unread&page=${data.page + 1}`, { signal: controller.signal });
      if (!controller.signal.aborted && requestId.current === generation) {
        setData(current => current && current.page === data.page
          ? { ...result, items: [...current.items, ...result.items.filter(item => !current.items.some(previous => previous.id === item.id))] }
          : current);
      }
    } catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)); }
    finally { if (!controller.signal.aborted) setLoadingMore(false); }
  }

  async function markRead(item: NotificationItem) {
    setBusy(item.id); setActionError('');
    try {
      await api(`/notifications/${item.id}/read`, { body: {} });
      setData(current => current ? { ...current, items: current.items.filter(row => row.id !== item.id),
        total: Math.max(0, current.total - 1), unreadCount: Math.max(0, current.unreadCount - 1) } : current);
      setOpened(false);
      refresh();
      navigate(`/projects/${item.projectId}?task=${item.taskId}`);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusy(null); }
  }

  async function markAllRead() {
    if (!data) return;
    setBusy('all'); setActionError('');
    try {
      await api('/notifications/read-all', { body: { asOf: data.asOf } });
      setData(current => current ? { ...current, items: [], total: 0, unreadCount: 0, page: 1 } : current);
      refresh();
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusy(null); }
  }

  return <Popover opened={opened} onChange={setOpened} onDismiss={() => setOpened(false)}
    width={380} position="bottom-end" offset={8} shadow="md" trapFocus zIndex={1000} classNames={{ dropdown: 'notification-popover' }}>
    <Popover.Target>
      <ActionIcon size={44} variant="subtle" color="gray" className="notification-bell"
        aria-label={countError ? '消息，未读数暂时无法更新' : `消息，${unreadCount} 条未读`}
        onClick={() => { if (!opened) setData(undefined); setOpened(value => !value); setActionError(''); }}>
        <IconBell size={20} aria-hidden="true"/>
        {unreadCount > 0 && <Badge className="notification-bell-count" size="xs" color="red" variant="filled" aria-hidden="true">
          {unreadCount > 99 ? '99+' : unreadCount}
        </Badge>}
      </ActionIcon>
    </Popover.Target>
    <Popover.Dropdown>
      <Group justify="space-between" gap="xs" mb="xs">
        <Text fw={650} size="sm" tabIndex={-1} data-autofocus>未读消息</Text>
        <Button size="compact-xs" variant="subtle" disabled={!data?.unreadCount || !!busy}
          loading={busy === 'all'} onClick={() => void markAllRead()}>全部标为已读</Button>
      </Group>
      <Failure error={error || actionError || countError}/>
      {(error || countError) && <Button size="xs" variant="light" onClick={refresh} mb="xs">重新加载</Button>}
      {!data && !error ? <Loading/> : data && data.items.length === 0
        ? <Text size="sm" c="dimmed" ta="center" py="xl" role="status">暂无新消息</Text>
        : <div className="notification-popover-list" onScroll={event => {
            const target = event.currentTarget;
            if (target.scrollTop + target.clientHeight >= target.scrollHeight - 80) void loadMore();
          }}>
          {data?.items.map(item => <button type="button" key={item.id} className="notification-popover-item"
            disabled={!!busy} onClick={() => void markRead(item)}>
            <Text size="sm" fw={600}>{actionText(item)}</Text>
            <Text size="sm" className="notification-title">{item.taskTitle}</Text>
            <Text size="xs" c="dimmed">{item.projectName} · {new Date(item.createdAt).toLocaleString('zh-CN')}</Text>
          </button>)}
          {loadingMore && <Loading/>}
        </div>}
    </Popover.Dropdown>
  </Popover>;
}
