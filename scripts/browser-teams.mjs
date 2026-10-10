import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const teams = Array.from({ length: 12 }, (_, index) => ({ id: `team-${index}`, name: `协作团队 ${index + 1}`, role: 'admin', memberCount: 2, version: 1 }));
let invites = [];
page.route('**/api/**', async route => {
  const request = route.request();
  const path = new URL(request.url()).pathname.replace('/api', '');
  const body = request.postDataJSON?.() ?? {};
  let data = {};
  if (path === '/public/state') data = { initialized: true };
  else if (path === '/me') data = { id: 'owner', name: '本地开发管理员', email: 'developer@yuanplan.local', isAdmin: true };
  else if (path === '/teams' && request.method() === 'GET') data = teams;
  else if (path === '/teams' && request.method() === 'POST') { data = { id: `team-${teams.length}`, name: body.name }; teams.unshift({ ...data, role: 'admin', memberCount: 1, version: 1 }); }
  else if (/^\/teams\/[^/]+\/members$/.test(path)) data = [{ userId: 'owner', name: '本地开发管理员', email: 'developer@yuanplan.local', role: 'admin' }];
  else if (path.startsWith('/invitations/team/')) { if (request.method() === 'POST') { invites.push({ id: String(invites.length), email: body.email, role: body.role, acceptedAt: null, revokedAt: null, expiresAt: '2027-01-01' }); data = { url: 'http://localhost:5173/invite/test' }; } else data = invites; }
  else if (/^\/teams\/[^/]+$/.test(path) && request.method() === 'PUT') { const item = teams.find(team => team.id === path.split('/')[2]); item.name = body.name; item.version++; data = item; }
  else if (path.endsWith('/manage')) { if (body.action === 'delete') teams.splice(teams.findIndex(team => team.id === path.split('/')[2]), 1); data = { ok: true }; }
  else if (path.endsWith('/revoke')) { invites.find(invite => invite.id === path.split('/')[2]).revokedAt = new Date().toISOString(); data = { ok: true }; }
  await route.fulfill({ json: data });
});

try {
  await page.goto('http://127.0.0.1:5173/teams');
  await expect(page.getByRole('heading', { name: '团队', exact: true })).toBeVisible();
  await expect(page.locator('.team-table tbody tr')).toHaveCount(10);
  await page.getByRole('textbox', { name: '搜索团队名称' }).fill('协作团队 12');
  await expect(page.locator('.team-table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: '查看成员' }).click();
  await expect(page.getByRole('heading', { name: '协作团队 12' })).toBeVisible();
  await expect(page.getByRole('table').getByText('developer@yuanplan.local')).toBeVisible();
  await page.getByRole('button', { name: '邀请成员' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByRole('textbox', { name: '受邀邮箱' }).fill('new@example.test');
  await page.getByRole('button', { name: '生成邀请链接' }).click();
  await expect(page.getByRole('textbox', { name: '邀请链接' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '返回团队列表' }).click();
  await page.getByRole('textbox', { name: '搜索团队名称' }).fill('');
  await page.getByRole('button', { name: '新增团队' }).click();
  await page.getByRole('textbox', { name: '团队名称', exact: true }).fill('新团队');
  await page.getByRole('button', { name: '创建团队' }).click();
  await expect(page.getByRole('heading', { name: '新团队' })).toBeVisible();
  await page.getByRole('button', { name: '编辑团队' }).click();
  await page.getByRole('textbox', { name: '团队名称', exact: true }).fill('重命名团队');
  await page.getByRole('button', { name: '保存名称' }).click();
  await expect(page.getByRole('heading', { name: '重命名团队' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.data/teams-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  console.log('Passed: team list, search, detail, invitation, create, rename, mobile layout.');
} finally { await browser.close(); }
