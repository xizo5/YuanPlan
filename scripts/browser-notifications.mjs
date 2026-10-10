import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let items = [];
let fail = false;
let nextId = 1;
let now = Date.now();
let countCalls = 0;
function add(title = '实现任务消息提醒', eventType = 'task.assigned') {
  const id = nextId++;
  items.unshift({ id: String(id), taskId: `task-${id}`, projectId: 'p1', eventType, actorName: '张三',
    taskTitle: title, projectName: 'YuanPlan 项目', createdAt: new Date(++now).toISOString(), readAt: null });
}
await page.route('**/api/**', async route => {
  const req = route.request();
  const url = new URL(req.url());
  const path = url.pathname;
  let data = [];
  if (path === '/api/me') data = { id: 'u1', name: '测试用户', email: 'test@example.test', isAdmin: true };
  else if (path === '/api/public/state') data = { initialized: true };
  else if (path === '/api/my-tasks') data = { items: [], total: 0, page: 1, pageSize: 10 };
  else if (path.startsWith('/api/notifications')) {
    if (fail) return route.fulfill({ status: 500, json: { error: { message: '消息服务暂不可用' } } });
    if (path.endsWith('/unread-count')) { countCalls++; data = { unreadCount: items.filter(item => !item.readAt).length }; }
    else if (path.endsWith('/read-all')) {
      const { asOf } = req.postDataJSON();
      items.forEach(item => { if (item.createdAt <= asOf) item.readAt ||= new Date(++now).toISOString(); });
      data = { ok: true };
    } else if (path.endsWith('/read')) {
      const item = items.find(item => item.id === path.split('/').at(-2));
      item.readAt ||= new Date(++now).toISOString(); data = { ok: true };
    } else {
      const filtered = items.filter(item => url.searchParams.get('status') !== 'unread' || !item.readAt);
      const current = Number(url.searchParams.get('page') ?? 1);
      data = { items: filtered.slice((current - 1) * 20, current * 20), total: filtered.length, page: current, pageSize: 20,
        unreadCount: items.filter(item => !item.readAt).length, asOf: new Date(now).toISOString() };
    }
  }
  await route.fulfill({ json: data });
});
try {
  await page.clock.install();
  await page.goto('http://localhost:5173/my-tasks');
  expect(await page.getByRole('link', { name: '消息' }).count()).toBe(0);
  await expect(page.getByRole('button', { name: '消息，0 条未读' })).toBeVisible();
  add();
  await page.clock.fastForward(15_000);
  await expect(page.getByRole('button', { name: '消息，1 条未读' })).toBeVisible();
  expect(countCalls).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: '消息，1 条未读' }).click();
  await expect(page.getByText('未读消息', { exact: true })).toBeVisible();
  await expect(page.locator('.notification-popover-item')).toHaveCount(1);
  await page.locator('.notification-popover-item').click();
  await expect(page).toHaveURL(/\/projects\/p1\?task=task-1$/);
  await expect(page.getByRole('button', { name: '消息，0 条未读' })).toBeVisible();
  expect(items[0].readAt).toBeTruthy();
  await page.getByRole('button', { name: '消息，0 条未读' }).click();
  await expect(page.getByText('暂无新消息')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '我的任务' }).click();
  for (let i = 0; i < 25; i++) add(`待处理任务 ${i + 1}`);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: '消息，25 条未读' })).toBeVisible();
  await page.getByRole('button', { name: '消息，25 条未读' }).click();
  await expect(page.locator('.notification-popover-item')).toHaveCount(20);
  await page.locator('.notification-popover-list').evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
  await expect(page.locator('.notification-popover-item')).toHaveCount(25);
  await page.getByRole('button', { name: '全部标为已读' }).click();
  await expect(page.getByText('暂无新消息')).toBeVisible();
  await expect(page.getByRole('button', { name: '消息，0 条未读' })).toBeVisible();
  add('新分配：支持站内消息');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.notification-popover-item')).toHaveCount(1);
  await page.screenshot({ path: '.data/notifications-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '消息，1 条未读' })).toBeVisible();
  await page.getByRole('button', { name: '消息，1 条未读' }).click();
  await expect(page.locator('.notification-popover:visible')).toBeVisible();
  await expect.poll(async () => (await page.locator('.notification-popover:visible').boundingBox()).width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.waitForTimeout(250);
  await page.screenshot({ path: '.data/notifications-mobile.png', fullPage: true });
  fail = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert')).toContainText('消息服务暂不可用');
  await expect(page.getByRole('button', { name: '消息，未读数暂时无法更新' })).toContainText('1');
  fail = false;
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  for (let i = 0; i < 100; i++) add();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: '消息，101 条未读' })).toContainText('99+');
  await page.goto('http://localhost:5173/notifications');
  await expect(page).toHaveURL('http://localhost:5173/my-tasks');
  expect(errors).toEqual([]);
  console.log('Passed: polling badge, unread-only popover, read navigation, lazy loading, read-all, error recovery, 99+ and mobile. API mocked.');
} catch (error) {
  await page.screenshot({ path: '.data/notifications-failure.png', fullPage: true });
  throw error;
} finally { await browser.close(); }
