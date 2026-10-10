import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const credentials = Array.from({ length: 12 }, (_, index) => ({ id: `id-${index}`, name: `测试凭据 ${index + 1}`, prefix: `yp_${index}`, scope: index % 2 ? 'write' : 'read', projectIds: ['project-1'], createdAt: '2026-09-01T00:00:00Z', expiresAt: index === 1 ? '2026-01-01T00:00:00Z' : null, revokedAt: index === 2 ? '2026-09-02T00:00:00Z' : null }));
const projects = [{ id: 'project-1', name: '项目甲', role: 'admin' }];
await page.route('**/api/**', async route => {
  const request = route.request();
  const path = new URL(request.url()).pathname.replace('/api', '');
  const body = request.postDataJSON?.() ?? {};
  let data = {};
  if (path === '/public/state') data = { initialized: true };
  else if (path === '/me') data = { id: 'owner', name: '管理员', email: 'admin@example.test', isAdmin: true };
  else if (path === '/projects') data = projects;
  else if (path === '/credentials' && request.method() === 'GET') data = credentials;
  else if (path === '/credentials' && request.method() === 'POST') { data = { token: 'yp_example_one_time_token' }; credentials.unshift({ id: 'new-id', name: body.name, prefix: 'yp_example', scope: body.scope, projectIds: body.projectIds, createdAt: new Date().toISOString(), expiresAt: body.expiresAt, revokedAt: null }); }
  else if (path.endsWith('/revoke')) { credentials.find(item => item.id === path.split('/')[2]).revokedAt = new Date().toISOString(); data = { ok: true }; }
  await route.fulfill({ json: data });
});

try {
  await page.goto('http://127.0.0.1:5173/integrations');
  await expect(page.getByRole('heading', { name: 'AI 与集成' })).toBeVisible();
  await expect(page.locator('.integration-table tbody tr')).toHaveCount(10);
  await page.getByRole('textbox', { name: '搜索凭据名称' }).fill('测试凭据 12');
  await expect(page.locator('.integration-table tbody tr')).toHaveCount(1);
  await page.getByRole('textbox', { name: '搜索凭据名称' }).fill('');
  await page.getByRole('combobox', { name: '凭据状态' }).click();
  await page.getByRole('option', { name: '已过期' }).click();
  await expect(page.locator('.integration-table tbody tr')).toHaveCount(1);
  await page.getByRole('combobox', { name: '凭据状态' }).click();
  await page.getByRole('option', { name: '全部状态' }).click();
  await page.getByRole('button', { name: '新增凭据' }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('新凭据');
  await page.getByRole('combobox', { name: '允许访问的项目' }).fill('项目甲');
  await page.getByRole('option', { name: '项目甲' }).click();
  await page.getByRole('button', { name: '创建凭据' }).click();
  await expect(page.getByRole('textbox', { name: '新凭据' })).toHaveValue('yp_example_one_time_token');
  await page.getByRole('button', { name: '我已保存，关闭' }).click();
  await expect(page.getByRole('textbox', { name: '新凭据' })).toHaveCount(0);
  await page.getByRole('row', { name: /新凭据/ }).getByRole('button', { name: '撤销' }).click();
  await expect(page.getByRole('dialog')).toContainText('立即无法访问');
  await page.getByRole('button', { name: '确认撤销' }).click();
  await expect(page.getByRole('row', { name: /新凭据/ })).toContainText('已撤销');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: '.data/integrations-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  console.log('Passed: list, search, status, create with one-time token, revoke confirmation, mobile layout.');
} finally { await browser.close(); }
