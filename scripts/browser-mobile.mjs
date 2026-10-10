import { chromium, expect } from '@playwright/test';

const base = 'http://127.0.0.1:5174';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const project = { id: 'p1', name: '手机验收项目', description: '', role: 'admin', version: 1, archivedAt: null, deletedAt: null, taskCount: 1, completedCount: 0 };
const task = { id: 't1', projectId: 'p1', number: 1, title: '在手机上处理任务', description: { type: 'doc', content: [{ type: 'paragraph' }] }, status: 'todo', priority: 'normal', assigneeId: 'u1', creatorId: 'u1', parentId: null, startDate: null, dueDate: null, labels: [], childCount: 0, childDone: 0, version: 1, createdAt: '2026-09-28T00:00:00Z', archivedAt: null, deletedAt: null };
const errors = [];
async function setup(page) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api', '');
    let data = [];
    if (path === '/me') data = { id: 'u1', name: '手机验收用户', email: 'mobile@example.test', isAdmin: true };
    else if (path === '/public/state') data = { initialized: true, registrationMode: 'invite' };
    else if (path === '/notifications/unread-count') data = { unreadCount: 0 };
    else if (path === '/projects') data = { items: [project], total: 1, page: 1, pageSize: 10 };
    else if (path === '/projects/p1') data = project;
    else if (path === '/projects/p1/members') data = [{ userId: 'u1', name: '手机验收用户', email: 'mobile@example.test', role: 'admin' }];
    else if (path === '/projects/p1/tasks') data = { items: new URL(route.request().url()).searchParams.get('status') && new URL(route.request().url()).searchParams.get('status') !== task.status ? [] : [task], nextCursor: null };
    else if (path === '/projects/p1/tasks/t1') { if (route.request().method() === 'PUT') Object.assign(task, route.request().postDataJSON().data, { version: task.version + 1 }); data = task; }
    else if (path === '/projects/p1/labels' || path === '/projects/p1/tasks/t1/files' || path === '/projects/p1/tasks/t1/documents') data = [];
    else if (path === '/projects/p1/tasks/t1/activity' || path === '/projects/p1/documents') data = { items: [], nextCursor: null };
    await route.fulfill({ json: data });
  });
}

try {
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await setup(mobile);
  await mobile.goto(`${base}/projects/p1`);
  await expect(mobile.getByRole('button', { name: '我的任务' })).toBeVisible();
  await expect(mobile.getByRole('button', { name: '我的项目' })).toBeVisible();
  await expect(mobile.getByRole('button', { name: '更多页面和账号操作' })).toBeVisible();
  await expect(mobile.locator('button.task-row')).toHaveCount(1);
  await expect(mobile.locator('.board')).toHaveCount(0);
  for (const width of [360, 390, 430, 768]) {
    await mobile.setViewportSize({ width, height: 844 });
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(mobile.locator('button.task-row')).toHaveCount(1);
  }
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.getByRole('button', { name: '更多页面和账号操作' }).click();
  await expect(mobile.getByRole('menuitem', { name: '团队' })).toBeVisible();
  await expect(mobile.getByRole('menuitem', { name: '系统管理' })).toBeVisible();
  await mobile.keyboard.press('Escape');
  await mobile.screenshot({ path: '.data/mobile-project-simplified.png', fullPage: true });
  await mobile.locator('button.task-row').click();
  await expect(mobile.getByRole('dialog').getByRole('textbox', { name: '任务标题' })).toHaveValue('在手机上处理任务');
  await mobile.getByRole('dialog').getByRole('combobox', { name: '状态', exact: true }).click();
  await mobile.getByRole('option', { name: '进行中' }).click();
  await mobile.getByRole('dialog').getByRole('button', { name: '保存任务' }).click();
  await expect.poll(() => task.status).toBe('in_progress');

  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await setup(desktop);
  await desktop.goto(`${base}/projects/p1`);
  await expect(desktop.locator('.task-card')).toHaveCount(1);
  await expect(desktop.getByRole('button', { name: '更多页面和账号操作' })).toBeHidden();
  expect(errors).toEqual([]);
  console.log('Passed: mobile navigation, compact project task list, task detail, no horizontal overflow, and desktop board default. Mock API only.');
} catch (error) { console.error('Page errors:', errors); throw error; } finally { await browser.close(); }
