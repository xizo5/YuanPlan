import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.APP_URL ?? 'http://localhost:5173';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use a local server');
const output = resolve(process.env.SCHEDULE_SCREENSHOT_DIR ?? '.data');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
let role = 'admin', archived = false, fail = false, writes = 0;
const members = [{ userId: 'u1', name: '张明', role: 'admin' }, { userId: 'u2', name: '李珊', role: 'member' }];
let tasks = [
  ['需求评审与技术方案', 'done', 'high', '2026-09-03', '2026-09-09'],
  ['任务详情与评论附件', 'in_progress', 'high', '2026-09-21', '2026-10-02'],
  ['日历与时间线联调', 'in_review', 'normal', '2026-09-28', '2026-10-07'],
  ['回归测试截止', 'todo', 'urgent', null, '2026-09-30'],
  ['部署准备开始', 'todo', 'normal', '2026-09-30', null],
  ['移动端排期检查', 'in_progress', 'normal', '2026-09-29', '2026-10-01'],
  ['编写交付说明', 'todo', 'low', null, null],
].map(([title, status, priority, startDate, dueDate], index) => ({
  id: `t${index + 1}`, projectId: 'p1', number: index + 1, title, status, priority, startDate, dueDate,
  parentId: index === 5 ? 't2' : null, parentNumber: index === 5 ? 2 : null, parentTitle: index === 5 ? '任务详情与评论附件' : null,
  assigneeId: index % 2 ? 'u2' : 'u1', creatorId: 'u1', version: 1, labels: [],
  description: { type: 'doc', content: [{ type: 'paragraph' }] }, createdAt: '2026-09-01T08:00:00Z', updatedAt: '2026-09-30T01:00:00Z', archivedAt: null, deletedAt: null,
}));
const original = structuredClone(tasks);
function filtered(params) {
  return tasks.filter(t => (!params.get('query') || t.title.includes(params.get('query'))) && (!params.get('status') || t.status === params.get('status')) && (!params.get('priority') || t.priority === params.get('priority')) && (params.get('roots') !== 'true' || !t.parentId) && (!params.get('parentId') || t.parentId === params.get('parentId')));
}
await page.route('**/api/**', async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, params = url.searchParams;
  let data = [];
  if (path === '/api/me') data = { id: 'u1', name: '张明', email: 'test@example.test', isAdmin: false };
  else if (path === '/api/public/state') data = { initialized: true };
  else if (path === '/api/notifications/unread-count') data = { unreadCount: 0 };
  else if (path === '/api/projects/p1') data = { id: 'p1', name: 'YuanPlan 首版交付', description: '任务排期 · 研发与测试共同推进', role, archivedAt: archived ? '2026-09-30' : null, version: 1 };
  else if (path.endsWith('/members')) data = members;
  else if (path.endsWith('/task-schedule')) {
    requests.push(Object.fromEntries(params));
    if (fail) return route.fulfill({ status: 500, json: { error: { message: '排期加载失败' } } });
    const active = filtered(params), unplanned = active.filter(t => !t.startDate && !t.dueDate);
    const items = params.get('bucket') === 'unscheduled' ? unplanned : active.filter(t => (t.startDate ?? t.dueDate) && (t.startDate ?? t.dueDate) <= params.get('to') && (t.dueDate ?? t.startDate) >= params.get('from'));
    const offset = Number(params.get('cursor') ?? 0);
    data = { items: items.slice(offset, offset + 100), total: items.length, unscheduledTotal: unplanned.length, nextCursor: offset + 100 < items.length ? String(offset + 100) : null };
  } else if (path.endsWith('/tasks')) data = { items: filtered(params), nextCursor: null };
  else if (/\/tasks\/t\d+$/.test(path)) {
    const index = tasks.findIndex(t => path.endsWith(`/${t.id}`));
    if (request.method() === 'PUT') { writes++; const body = request.postDataJSON(); expect(body.expectedVersion).toBe(tasks[index].version); tasks[index] = { ...tasks[index], ...body.data, version: tasks[index].version + 1 }; }
    data = tasks[index];
  } else if (/\/(comments|activity|history)$/.test(path)) data = { items: [], nextCursor: null };
  await route.fulfill({ json: data });
});
async function enter(mode = 'calendar') {
  await page.goto(`${base}/projects/p1?view=tasks&mode=${mode}&scheduleDate=2026-09-30`);
  await expect(page.getByText('点击任务进入详情修改日期，保存后更新排期', { exact: true })).toBeVisible();
}
async function closeDetail() { await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); }
async function choose(label, option) { await page.getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); }
try {
  await enter();
  await expect(page.locator('.calendar-week')).toHaveCount(5);
  await expect(page.locator('.calendar-event').filter({ hasText: '任务详情与评论附件' })).toHaveCount(2);
  await expect(page.getByText('当前日期范围共 6 项任务', { exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(output, 'task-calendar-desktop.png'), fullPage: true });
  await page.locator('.calendar-event').filter({ hasText: '需求评审与技术方案' }).first().click();
  await expect(page.getByLabel('开始日期', { exact: true })).toHaveValue('2026-09-03'); await closeDetail();
  await page.locator('.calendar-overflow').filter({ hasText: '还有 2 项' }).click();
  await expect(page.getByRole('dialog').locator('.schedule-task-row')).toHaveCount(5);
  await page.getByRole('dialog').getByRole('button').filter({ hasText: '回归测试截止' }).click();
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue('回归测试截止');
  await page.getByLabel('截止日期', { exact: true }).fill('2026-10-10');
  expect(writes).toBe(0);
  await page.getByRole('button', { name: '保存任务内容', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存任务内容', exact: true })).toBeDisabled(); expect(writes).toBe(1);
  await closeDetail(); await expect(page.getByText('当前日期范围共 5 项任务', { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('mode')).toBe('calendar'); expect(new URL(page.url()).searchParams.get('scheduleDate')).toBe('2026-09-30');
  await page.getByRole('button', { name: '未排期任务 · 1', exact: true }).click();
  await page.locator('.schedule-unscheduled').getByRole('button').filter({ hasText: '编写交付说明' }).click();
  await page.getByLabel('开始日期', { exact: true }).fill('2026-09-30'); await page.getByLabel('截止日期', { exact: true }).fill('2026-10-02');
  expect(writes).toBe(1); await page.getByRole('button', { name: '保存任务内容', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存任务内容', exact: true })).toBeDisabled(); await closeDetail();
  await expect(page.getByRole('button', { name: '未排期任务 · 0', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看2026-09-30的任务，已加载 5 项', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.schedule-task-row').filter({ hasText: '编写交付说明' })).toHaveCount(1); await closeDetail();
  await page.getByRole('button', { name: '下个月', exact: true }).click(); await expect(page.getByText('2026年10月', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText('2026年10月', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '上个月', exact: true }).click(); await expect(page.getByText('2026年9月', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '筛选', exact: true }).click(); await choose('状态', '进行中');
  await expect(page.getByText('当前日期范围共 2 项任务', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '时间线', exact: true }).click(); await expect(page.locator('.timeline-row')).toHaveCount(2);
  await page.getByRole('button', { name: '列表', exact: true }).click(); await expect(page.locator('button.task-row')).toHaveCount(2);
  await page.getByRole('button', { name: '看板', exact: true }).click(); await expect(page.locator('.task-card')).toHaveCount(2);
  await page.getByRole('button', { name: '时间线', exact: true }).click(); await page.getByRole('button', { name: '清空', exact: true }).click();
  await page.getByLabel('时间线定位日期', { exact: true }).fill('2026-09-30');
  await expect(page.locator('.timeline-row')).toHaveCount(6); await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.locator('.timeline-task-child')).toHaveCount(1);
  await expect(page.locator('.timeline-task-point')).toHaveCount(2);
  await page.screenshot({ path: resolve(output, 'task-timeline-desktop.png'), fullPage: true });
  await page.locator('.timeline-task-point').first().click(); await expect(page.getByLabel('任务标题', { exact: true })).toBeVisible(); await closeDetail();
  await page.getByRole('button', { name: '周刻度', exact: true }).click(); await expect(page.locator('.timeline-tick')).toHaveCount(12);
  await page.reload(); await expect(page.getByRole('button', { name: '周刻度', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('时间线定位日期', { exact: true }).fill('2026-12-01'); await expect(page.getByText('这段时间暂无已排期任务', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '今天', exact: true }).click(); await expect(page.getByLabel('时间线定位日期', { exact: true })).not.toHaveValue('2026-12-01');
  await page.getByLabel('时间线定位日期', { exact: true }).fill('2026-09-30');
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('部署准备'); await expect(page.locator('.timeline-row')).toHaveCount(1);
  await page.getByRole('button', { name: '日历', exact: true }).click(); await expect(page.getByText('当前日期范围共 1 项任务', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('textbox', { name: '搜索任务', exact: true })).toHaveValue('部署准备');
  await expect(page.getByText('当前日期范围共 1 项任务', { exact: true })).toBeVisible();
  tasks = structuredClone(original);
  await enter(); await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.locator('.mantine-AppShell-main').evaluate(e => parseFloat(getComputedStyle(e).paddingLeft))).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(output, 'task-calendar-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '2026-09-30共有 5 项已加载任务', exact: true }).click(); await expect(page.getByRole('dialog').locator('.schedule-task-row')).toHaveCount(5); await closeDetail();
  await page.getByRole('button', { name: '时间线', exact: true }).click(); await expect(page.locator('.timeline-row')).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.task-timeline-scroll').evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true);
  await page.screenshot({ path: resolve(output, 'task-timeline-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  for (const permission of ['viewer', 'admin']) {
    role = permission; archived = permission === 'admin'; await enter('timeline');
    await page.locator('.timeline-task-info').first().click(); await expect(page.getByLabel('开始日期', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '保存任务内容', exact: true })).toHaveCount(0); await closeDetail();
    await expect(page.getByRole('button', { name: '新建任务', exact: true })).toHaveCount(0);
  }
  archived = false; role = 'admin';
  tasks = Array.from({ length: 207 }, (_, i) => ({ ...original[0], id: `t${i + 1}`, number: i + 1, title: `批量任务 ${i + 1}`, startDate: i < 105 ? '2026-09-01' : null, dueDate: i < 105 ? '2026-09-30' : null }));
  await enter('timeline'); await expect(page.locator('.timeline-row')).toHaveCount(100);
  await page.getByRole('button', { name: '加载更多已排期任务（100/105）', exact: true }).click(); await expect(page.locator('.timeline-row')).toHaveCount(105);
  await page.getByRole('button', { name: '未排期任务 · 102', exact: true }).click(); await expect(page.locator('.schedule-unscheduled .schedule-task-row')).toHaveCount(100);
  await page.getByRole('button', { name: '加载更多未排期任务（100/102）', exact: true }).click(); await expect(page.locator('.schedule-unscheduled .schedule-task-row')).toHaveCount(102);
  fail = true; await page.getByRole('button', { name: '刷新排期', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('排期加载失败');
  fail = false; await page.getByRole('button', { name: '重新加载排期', exact: true }).click(); await expect(page.locator('.timeline-row')).toHaveCount(100);
  expect(errors).toEqual([]); expect(writes).toBe(2);
  console.log(`Passed: calendar/timeline ranges, cross-week bars, day popup, manual save refresh, unscheduled scheduling, shared filters across four views, URL reload, day/week scales, mobile, permissions, pagination and retry. ${requests.length} mock schedule reads; no real data changed.`);
} catch (error) { await page.screenshot({ path: resolve(output, 'task-schedule-failure.png'), fullPage: true }); console.error(errors); throw error; }
finally { await browser.close(); }
