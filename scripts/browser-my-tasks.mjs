import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const tasks = Array.from({ length: 25 }, (_, i) => ({
  id: `task-${i + 1}`, number: i + 1, title: `任务 ${String(i + 1).padStart(2, '0')}`,
  projectId: 'p1', projectName: '测试项目', status: i < 12 ? 'todo' : 'done',
  priority: i % 2 ? 'high' : 'normal', dueDate: null,
}));
const requests = [];
let fail = false;
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  let data = [];
  if (url.pathname === '/api/me') data = { id: 'u1', name: '测试用户', email: 'test@example.test', isAdmin: true };
  else if (url.pathname === '/api/public/state') data = { initialized: true };
  else if (url.pathname === '/api/my-tasks') {
    if (fail) return route.fulfill({ status: 500, json: { error: { message: '测试加载失败' } } });
    const options = Object.fromEntries(url.searchParams);
    requests.push(options);
    const items = tasks.filter(t => t.title.includes(options.query ?? '') && (!options.status || t.status === options.status) && (!options.priority || t.priority === options.priority));
    const size = Number(options.pageSize);
    const current = Math.min(Number(options.page), Math.max(1, Math.ceil(items.length / size)));
    data = { items: items.slice((current - 1) * size, current * size), total: items.length, page: current, pageSize: size };
  }
  await route.fulfill({ json: data });
});
async function choose(label, option) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
const rows = page.locator('button.personal-task-row');
try {
  await page.goto('http://localhost:5173/my-tasks');
  await expect(rows).toHaveCount(10);
  await expect(page.getByText('共 25 个任务', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '第 3 页', exact: true }).click();
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText('任务 21');
  await page.getByRole('textbox', { name: '搜索任务名称' }).fill('任务 25');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('任务 25');
  expect(requests.at(-1).page).toBe('1');
  await page.getByRole('button', { name: '清空筛选' }).click();
  await expect(rows).toHaveCount(10);
  await choose('任务状态', '待办');
  await expect(page.getByText('共 12 个任务', { exact: true })).toBeVisible();
  await choose('任务优先级', '高');
  await expect(rows).toHaveCount(6);
  await page.getByRole('textbox', { name: '搜索任务名称' }).fill('任务 0');
  await expect(rows).toHaveCount(4);
  expect(requests.at(-1)).toMatchObject({ query: '任务 0', status: 'todo', priority: 'high', page: '1' });
  await page.getByRole('textbox', { name: '搜索任务名称' }).fill('没有这个任务');
  await expect(page.getByRole('heading', { name: '没有匹配的任务' })).toBeVisible();
  await expect(page.getByText('共 0 个任务', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清空筛选' }).click();
  await expect(rows).toHaveCount(10);
  await choose('每页任务数', '20 条/页');
  await expect(rows).toHaveCount(20);
  await page.getByRole('button', { name: '第 2 页', exact: true }).click();
  await expect(rows).toHaveCount(5);
  await choose('每页任务数', '50 条/页');
  await expect(rows).toHaveCount(25);
  expect(requests.at(-1).page).toBe('1');
  await choose('每页任务数', '10 条/页');
  await expect(rows).toHaveCount(10);
  await page.screenshot({ path: '.data/my-tasks-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await page.locator('.task-list-scroll').boundingBox()).width).toBeGreaterThan(350);
  await page.screenshot({ path: '.data/my-tasks-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await page.locator('.task-list-scroll').boundingBox()).width).toBeGreaterThan(340);
  fail = true;
  await page.getByRole('textbox', { name: '搜索任务名称' }).fill('失败');
  await expect(page.getByRole('alert')).toContainText('测试加载失败');
  await expect(page.getByRole('heading', { name: '没有匹配的任务' })).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByRole('heading', { name: '没有匹配的任务' })).toBeVisible();
  await page.getByRole('button', { name: '清空筛选' }).click();
  await expect(rows).toHaveCount(10);
  await rows.first().click();
  await expect(page).toHaveURL(/\/projects\/p1\?task=task-1$/);
  expect(errors).toEqual([]);
  console.log('Passed: paging, name/status/priority combination, reset, page size, empty/error/retry states, mobile layout and task navigation. API mocked; no real tasks changed.');
} catch (error) {
  await page.screenshot({ path: '.data/my-tasks-failure.png', fullPage: true });
  throw error;
} finally { await browser.close(); }
