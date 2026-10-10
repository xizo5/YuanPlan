import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const project = { id: 'p1', name: '产品项目', description: '', role: 'admin', version: 1, archivedAt: null, deletedAt: null, teamId: null };
const members = Array.from({ length: 12 }, (_, index) => ({ userId: `u${index}`, name: `项目成员 ${index + 1}`, email: `member${index + 1}@example.test`, role: index ? 'member' : 'admin', disabled: false }));
const labels = Array.from({ length: 12 }, (_, index) => ({ id: `l${index}`, name: `标签 ${index + 1}`, version: 1 }));
await page.route('**/api/**', async route => {
  const request = route.request();
  const path = new URL(request.url()).pathname.replace('/api', '');
  const body = request.postDataJSON?.() ?? {};
  let data = {};
  if (path === '/public/state') data = { initialized: true };
  else if (path === '/me') data = { id: 'u0', name: '项目成员 1', email: 'member1@example.test', isAdmin: true };
  else if (path === '/projects/p1') data = project;
  else if (path === '/projects/p1/members' && request.method() === 'GET') data = members;
  else if (path.startsWith('/projects/p1/members/') && request.method() === 'PUT') { const member = members.find(item => item.userId === path.split('/').at(-1)); if (body.role) member.role = body.role; else members.splice(members.indexOf(member), 1); data = { ok: true }; }
  else if (path === '/projects/p1/labels' && request.method() === 'GET') data = labels;
  else if (path === '/projects/p1/labels' && request.method() === 'POST') { const label = { id: `l${labels.length}`, name: body.name, version: 1 }; labels.push(label); data = label; }
  else if (path.startsWith('/projects/p1/labels/') && request.method() === 'PUT') { const label = labels.find(item => item.id === path.split('/').at(-1)); if (body.name === null) labels.splice(labels.indexOf(label), 1); else { label.name = body.name; label.version++; } data = { ok: true }; }
  else if (path === '/teams') data = [{ id: 'team-1', name: '协作团队' }];
  else if (path === '/teams/team-1/members') data = members;
  else if (path === '/invitations/project/p1') data = request.method() === 'GET' ? [] : { url: 'http://localhost:5173/invite/mock' };
  else if (path.startsWith('/projects/p1/tasks')) data = { items: [], nextCursor: null };
  await route.fulfill({ json: data });
});

try {
  await page.goto('http://127.0.0.1:5173/projects/p1');
  await page.getByRole('tab', { name: '成员', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目成员' })).toBeVisible();
  await expect(page.locator('.project-management-table tbody tr')).toHaveCount(10);
  await page.screenshot({ path: '.data/project-members-desktop.png' });
  await page.getByRole('textbox', { name: '搜索项目成员' }).fill('项目成员 12');
  await expect(page.locator('.project-management-table tbody tr')).toHaveCount(1);
  await page.getByRole('textbox', { name: '搜索项目成员' }).fill('');
  await page.getByRole('combobox', { name: '项目成员 2的角色' }).click();
  await page.getByRole('option', { name: '只读' }).click();
  await expect(page.getByRole('combobox', { name: '项目成员 2的角色' })).toHaveValue('只读');
  await page.getByRole('row', { name: /项目成员 2/ }).getByRole('button', { name: '移除成员' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('未归档任务将改为未分配');
  await page.getByRole('alertdialog').getByRole('button', { name: '确认移除' }).click();
  await expect(page.getByRole('row', { name: /项目成员 2/ })).toHaveCount(0);
  await page.getByRole('button', { name: '邀请成员' }).click();
  await expect(page.getByRole('dialog')).toContainText('受邀邮箱');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '从团队添加' }).click();
  await expect(page.getByRole('dialog')).toContainText('选择团队人员');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '标签', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目标签' })).toBeVisible();
  await expect(page.locator('.project-label-table tbody tr')).toHaveCount(10);
  await page.screenshot({ path: '.data/project-labels-desktop.png' });
  await page.getByRole('textbox', { name: '搜索项目标签' }).fill('标签 12');
  await expect(page.locator('.project-label-table tbody tr')).toHaveCount(1);
  await page.getByRole('textbox', { name: '搜索项目标签' }).fill('');
  await page.getByRole('button', { name: '新增标签' }).click();
  await page.getByRole('textbox', { name: '标签名称', exact: true }).fill('新标签');
  await page.getByRole('button', { name: '创建标签' }).click();
  await expect(page.getByRole('row', { name: /新标签/ })).toBeVisible();
  await page.getByRole('row', { name: /新标签/ }).getByRole('button', { name: '改名' }).click();
  await page.getByRole('textbox', { name: '标签新名称' }).fill('改名标签');
  await page.getByRole('button', { name: '保存名称' }).click();
  await expect(page.getByRole('row', { name: /改名标签/ })).toBeVisible();
  await page.getByRole('row', { name: /改名标签/ }).getByRole('button', { name: '删除' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('全部相关任务');
  await page.getByRole('alertdialog').getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('row', { name: /改名标签/ })).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索项目标签' }).fill('');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: '.data/project-labels-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('tab', { name: '成员', exact: true }).click();
  await page.screenshot({ path: '.data/project-members-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  project.role = 'viewer';
  await page.reload();
  await page.getByRole('tab', { name: '成员', exact: true }).click();
  await expect(page.getByRole('button', { name: '邀请成员' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '从团队添加' })).toHaveCount(0);
  await page.getByRole('tab', { name: '标签', exact: true }).click();
  await expect(page.getByRole('button', { name: '新增标签' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除' })).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log('Passed: member and label lists, search, modals, label create/rename/delete, mobile layout.');
} finally { await browser.close(); }
