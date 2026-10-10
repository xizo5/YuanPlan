import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const project = { id: 'p1', name: '详情回归项目', description: '', role: 'admin', version: 1, archivedAt: null };
const task = { id: 't1', projectId: 'p1', projectName: project.name, number: 1, title: '详情回归任务',
  description: { type: 'doc', content: [{ type: 'paragraph' }] }, status: 'todo', priority: 'normal',
  assigneeId: 'u1', creatorId: 'u1', labels: [], version: 1, parentId: null, childCount: 0,
  createdAt: '2026-09-23T00:00:00Z', startDate: null, dueDate: null };
async function mock(page) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname;
    let data = [];
    if (path === '/api/me') data = { id: 'u1', name: '测试用户', isAdmin: true };
    else if (path === '/api/public/state') data = { initialized: true };
    else if (path === '/api/notifications/unread-count') data = { unreadCount: 0 };
    else if (path === '/api/projects') data = { items: [project], total: 1, page: 1, pageSize: 10 };
    else if (path === '/api/projects/p1') data = project;
    else if (path === '/api/projects/p1/members') data = [{ userId: 'u1', name: '测试用户', role: 'admin' }];
    else if (path === '/api/my-tasks') data = { items: [task], total: 1, page: 1, pageSize: 10 };
    else if (path === '/api/projects/p1/tasks/t1') data = task;
    else if (path === '/api/projects/p1/tasks') data = { items: url.searchParams.has('parentId') || (url.searchParams.has('status') && url.searchParams.get('status') !== 'todo') ? [] : [task], nextCursor: null };
    else if (path === '/api/projects/p1/documents' || path.endsWith('/activity')) data = { items: [], nextCursor: null };
    await route.fulfill({ json: data });
  });
}
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await mock(page);
  await page.goto('http://localhost:5173/');
  await page.locator('button.project-row').click();
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '我的任务', exact: true }).click();
  await page.locator('button.personal-task-row').click();
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue(task.title);
  await expect(page.locator('.tiptap')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存任务', exact: true })).toBeVisible();
  await page.screenshot({ path: '.data/task-detail-desktop.png' });
  await page.locator('.task-detail-drawer-content').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: '.data/task-detail-activity.png' });
  await page.locator('.task-detail-drawer-content').evaluate(element => { element.scrollTop = 0; });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toBeVisible();
  await page.screenshot({ path: '.data/task-detail-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.press('Escape');
  await page.getByRole('navigation').getByRole('button', { name: '我的项目', exact: true }).click();
  await expect(page.locator('button.project-row')).toHaveCount(1);
  await page.locator('button.project-row').click();
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await page.close();

  // A rejected lazy import must not unmount navigation or unrelated routes.
  const broken = await browser.newPage();
  await mock(broken);
  await broken.route('**/src/ProjectPage.tsx*', route => route.abort('failed'));
  await broken.goto('http://localhost:5173/projects/p1');
  await expect(broken.getByRole('alert')).toContainText('页面加载失败');
  await broken.getByRole('button', { name: '我的任务', exact: true }).click();
  await expect(broken.locator('button.personal-task-row')).toHaveCount(1);
  await broken.locator('button.personal-task-row').click();
  await expect(broken.getByRole('alert')).toContainText('页面加载失败');
  await broken.unroute('**/src/ProjectPage.tsx*');
  await broken.getByRole('button', { name: '重新加载页面', exact: true }).click();
  await expect(broken.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue(task.title);
  await expect(broken.locator('.tiptap')).toBeVisible();
  await broken.close();
  console.log('Passed: project click, my-task detail with editor, return navigation, failed module isolation and reload recovery. API mocked; no real data changed.');
} finally { await browser.close(); }
