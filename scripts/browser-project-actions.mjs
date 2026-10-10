import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const projects = [
  { id: 'active', name: '产品设计', description: '正在推进的项目', role: 'admin', version: 1, archivedAt: null, deletedAt: null, taskCount: 5, completedCount: 2 },
  { id: 'viewer', name: '协作项目', description: '', role: 'viewer', version: 1, archivedAt: null, deletedAt: null, taskCount: 1, completedCount: 0 },
  { id: 'archived', name: '历史项目', description: '', role: 'admin', version: 1, archivedAt: '2026-01-01', deletedAt: null, taskCount: 2, completedCount: 2 },
];
await page.route('**/api/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace('/api', '');
  let data = {};
  if (path === '/public/state') data = { initialized: true };
  else if (path === '/me') data = { id: 'owner', name: '管理员', email: 'admin@example.test', isAdmin: true };
  else if (path === '/teams') data = [];
  else if (path === '/projects') { const status = url.searchParams.get('status'); const items = projects.filter(project => !project.deletedAt && (status === 'all' || (status === 'archived' ? project.archivedAt : !project.archivedAt))); data = { items, total: items.length, page: 1, pageSize: 10 }; }
  else if (path.includes('/lifecycle/')) { const project = projects.find(item => item.id === path.split('/').at(-1)); if (request.postDataJSON().action === 'unarchive') project.archivedAt = null; project.version++; data = project; }
  await route.fulfill({ json: data });
});

try {
  await page.goto('http://127.0.0.1:5173/');
  const active = page.locator('.project-list-entry').filter({ hasText: '产品设计' });
  const viewer = page.locator('.project-list-entry').filter({ hasText: '协作项目' });
  await expect(active.getByRole('button', { name: '编辑项目信息：产品设计' })).toBeVisible();
  await expect(active.getByRole('button', { name: '归档项目：产品设计' })).toBeVisible();
  await expect(active.getByRole('button', { name: '移入回收站：产品设计' })).toBeVisible();
  await expect(viewer.locator('.project-row-actions')).toHaveCount(0);
  await page.screenshot({ path: '.data/project-actions-active.png' });
  await active.getByRole('button', { name: '归档项目：产品设计' }).hover();
  await expect(page.getByRole('tooltip', { name: '归档项目' })).toBeVisible();
  await active.getByRole('button', { name: '编辑项目信息：产品设计' }).click();
  await expect(page.getByRole('dialog')).toContainText('项目信息');
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: '项目状态' }).click();
  await page.getByRole('option', { name: '已归档' }).click();
  const archived = page.locator('.project-list-entry').filter({ hasText: '历史项目' });
  await expect(archived.getByRole('button', { name: '重新启用：历史项目' })).toBeVisible();
  await expect(archived.getByRole('button', { name: '编辑项目信息：历史项目' })).toHaveCount(0);
  await page.screenshot({ path: '.data/project-actions-desktop.png' });
  await archived.getByRole('button', { name: '重新启用：历史项目' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('重新启用');
  await page.getByRole('alertdialog').getByRole('button', { name: '确认' }).click();
  await expect(archived).toHaveCount(0);
  await page.getByRole('combobox', { name: '项目状态' }).click();
  await page.getByRole('option', { name: '进行中' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await expect(active.getByRole('button', { name: '编辑项目信息：产品设计' })).toBeVisible();
  await expect(active.getByRole('button', { name: '归档项目：产品设计' })).toBeVisible();
  await page.screenshot({ path: '.data/project-actions-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  console.log('Passed: icon actions, tooltips, viewer permissions, unarchive confirmation, mobile layout.');
} finally { await browser.close(); }
