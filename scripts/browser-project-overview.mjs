import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.APP_URL ?? 'http://localhost:5173';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use a local development server');
const output = resolve(process.env.OVERVIEW_SCREENSHOT_DIR ?? '.data');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
const kinds = ['status', 'priority', 'assignees', 'attention', 'upcoming', 'unassigned'];
let layout = { columns: 2, widgets: kinds.slice(0, 4).map(kind => ({ kind, width: 'half' })) };
let version = 0, role = 'admin', archived = false, fail = false, conflict = false, puts = 0, reads = 0, empty = false, allDone = false;
const requests = [];
const members = [{ userId: 'u1', name: '张明', role: 'admin' }, { userId: 'u2', name: '李珊', role: 'member' }, { userId: 'u3', name: '陈宇', role: 'member' }, { userId: 'u4', name: '王敏', role: 'viewer' }];
const today = '2026-09-30';
const tasks = [
  ['登录接口在弱网环境下重试失败', 'in_progress', 'urgent', 'u1', '2026-09-28'],
  ['项目文档搜索与关联体验优化', 'in_review', 'high', 'u2', '2026-10-02'],
  ['移动端任务详情交互验证', 'todo', 'high', 'u3', '2026-09-29'],
  ['附件下载权限与审计记录', 'in_progress', 'normal', 'u1', '2026-10-05'],
  ['整理首版验收清单', 'todo', 'normal', null, '2026-10-07'],
  ['成员邀请流程的异常提示', 'in_review', 'high', 'u2', null],
  ['评论图片缩略图与预览', 'done', 'normal', 'u3', null],
  ['任务状态筛选与列表分页', 'done', 'normal', 'u1', null],
  ['项目标签维护页面', 'done', 'low', 'u2', null],
  ['回收站恢复流程', 'done', 'high', 'u4', null],
  ['版本记录与变更记录合并', 'todo', 'low', 'u3', null],
  ['补充部署与备份说明', 'in_progress', 'normal', null, null],
].map(([title, status, priority, assigneeId, dueDate], index) => ({
  id: `t${index + 1}`, projectId: 'p1', number: index + 1, title, status, priority, assigneeId, dueDate, parentId: null,
  description: { type: 'doc', content: [{ type: 'paragraph' }] }, labels: [], version: 1, creatorId: 'u1', startDate: null,
  createdAt: '2026-09-15T08:00:00Z', updatedAt: '2026-09-30T01:00:00Z', archivedAt: null, deletedAt: null,
}));
const pending = tasks.filter(task => task.status !== 'done');
const overdue = task => task.dueDate && task.dueDate < today;
const upcoming = task => task.dueDate && task.dueDate >= today && task.dueDate <= '2026-10-07';
const attention = task => overdue(task) || upcoming(task) || ['high', 'urgent'].includes(task.priority);
const currentTasks = () => empty ? [] : allDone ? tasks.map(task => ({ ...task, status: 'done' })) : tasks;
function snapshot() {
  const active = currentTasks();
  const unfinished = active.filter(task => task.status !== 'done');
  const summary = { total: active.length, completed: active.length - unfinished.length, unfinished: unfinished.length, overdue: unfinished.filter(overdue).length, upcoming: unfinished.filter(upcoming).length, attention: unfinished.filter(attention).length, unassigned: unfinished.filter(t => !t.assigneeId).length };
  const project = { layout, version, today, upcomingTo: '2026-10-07', asOf: '2026-09-30T04:30:00Z', summary,
    statuses: ['todo', 'in_progress', 'in_review', 'done'].map(status => ({ status, count: active.filter(t => t.status === status).length })),
    priorities: ['low', 'normal', 'high', 'urgent'].map(priority => ({ priority, count: unfinished.filter(t => t.priority === priority).length })),
    assignees: [...members, { userId: null, name: '未分配' }].map(m => ({ assigneeId: m.userId, name: m.name, count: unfinished.filter(t => t.assigneeId === m.userId).length, overdue: unfinished.filter(t => t.assigneeId === m.userId && overdue(t)).length })).filter(m => m.count).sort((a, b) => b.count - a.count),
  };
  for (const [kind, predicate] of [['attention', attention], ['upcoming', upcoming], ['unassigned', t => !t.assigneeId]]) project[kind] = unfinished.filter(predicate).map(t => ({ ...t, assigneeName: members.find(m => m.userId === t.assigneeId)?.name ?? null }));
  return project;
}
await page.route('**/api/**', async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname;
  let data = [];
  if (path === '/api/me') data = { id: 'u1', name: '张明', email: 'test@example.test', isAdmin: false };
  else if (path === '/api/public/state') data = { initialized: true };
  else if (path === '/api/notifications/unread-count') data = { unreadCount: 0 };
  else if (path === '/api/projects/p1') data = { id: 'p1', name: 'YuanPlan 首版交付', description: '轻量项目协作 · 研发与测试共同推进', role, archivedAt: archived ? today : null, version: 1 };
  else if (path.endsWith('/members')) data = members;
  else if (path.endsWith('/overview')) {
    reads++;
    if (fail) return route.fulfill({ status: 500, json: { error: { message: '概览加载失败' } } });
    data = snapshot();
  } else if (path.endsWith('/overview/layout')) {
    puts++;
    if (conflict) return route.fulfill({ status: 409, json: { error: { code: 'VERSION_CONFLICT', message: '其他管理员已经修改了布局，请读取最新布局。' } } });
    const body = request.postDataJSON(); expect(body.expectedVersion).toBe(version); layout = body.layout; version++; data = { layout, version };
  } else if (path.endsWith('/tasks')) {
    const filters = Object.fromEntries(url.searchParams); requests.push(filters);
    const items = currentTasks().filter(t => (!filters.status || t.status === filters.status) && (!filters.priority || t.priority === filters.priority) && (!filters.assigneeId || (filters.assigneeId === 'unassigned' ? !t.assigneeId : t.assigneeId === filters.assigneeId)) && (!filters.focus || (t.status !== 'done' && (filters.focus === 'unfinished' || (filters.focus === 'overdue' && overdue(t)) || (filters.focus === 'upcoming' && upcoming(t)) || (filters.focus === 'attention' && attention(t))))));
    data = { items, nextCursor: null };
  } else if (/\/tasks\/t\d+$/.test(path)) data = tasks.find(t => path.endsWith(`/${t.id}`));
  else if (/\/(comments|activity|history)$/.test(path)) data = { items: [], nextCursor: null };
  await route.fulfill({ json: data });
});
async function choose(label, option) { await page.getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); }
async function overview() { await page.goto(`${base}/projects/p1?view=overview`); await expect(page.locator('.overview-widget')).toHaveCount(layout.widgets.length); }
try {
  await page.goto(`${base}/projects/p1?view=tasks&roots=true&focus=attention&asOfDate=${today}`); await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '项目概览', exact: true }).click();
  await expect(page.locator('.overview-widget')).toHaveCount(4);
  await page.getByRole('region', { name: '需要关注的任务', exact: true }).getByRole('button', { name: '查看全部', exact: true }).click();
  await expect(page.getByRole('tab', { name: '任务', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(/项目概览筛选：需要关注的任务/)).toBeVisible();
  await page.goBack(); await expect(page.getByRole('tab', { name: '项目概览', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(page.getByRole('tab', { name: '任务', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(/项目概览筛选：需要关注的任务/)).toBeVisible();
  await page.getByRole('button', { name: '筛选 · 2', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '概览范围', exact: true })).toHaveValue('需要关注的任务');
  await expect(page.getByLabel('统计日期', { exact: true })).toHaveValue(today);
  await expect(page.getByLabel('截止日期从', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('截止日期至', { exact: true })).toHaveValue('');
  await expect(page.getByText('未完成，且符合任一条件：逾期、未来 7 天到期、高或紧急优先级（无需设置截止日期）。', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '概览范围', exact: true })).toHaveAttribute('readonly', '');
  await page.screenshot({ path: resolve(output, 'project-overview-focus-filters.png'), fullPage: true });
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expect(page.locator('button.task-row')).toHaveCount(pending.filter(attention).length);
  await page.getByRole('button', { name: '取消范围筛选', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '概览范围', exact: true })).toHaveCount(0);
  await expect(page.locator('button.task-row')).toHaveCount(tasks.length);
  await page.getByRole('tab', { name: '项目概览', exact: true }).click();
  await expect(page.locator('.overview-widget')).toHaveCount(4);
  await expect(page.getByRole('button', { name: '查看逾期任务：2 项', exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(output, 'project-overview-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '查看逾期任务：2 项', exact: true }).click();
  await expect(page.getByText(/项目概览筛选：逾期任务/)).toBeVisible();
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expect(page.locator('button.task-row')).toHaveCount(2);
  expect(requests.at(-1)).toMatchObject({ roots: 'true', focus: 'overdue', asOfDate: today });
  await page.getByRole('button', { name: '清空', exact: true }).click();
  await expect(page.locator('button.task-row')).toHaveCount(12);
  await expect(page.getByText(/项目概览筛选：/)).toHaveCount(0);
  await overview();
  await page.getByRole('button', { name: '查看未完成的高优先级任务：3 项', exact: true }).click();
  await page.getByRole('button', { name: '列表', exact: true }).click(); await expect(page.locator('button.task-row')).toHaveCount(3);
  expect(requests.at(-1)).toMatchObject({ roots: 'true', focus: 'unfinished', priority: 'high' });
  await overview();
  await page.getByRole('button', { name: '配置概览', exact: true }).click();
  await choose('布局模板', '6 个模块');
  await expect(page.locator('.overview-layout-items > li')).toHaveCount(6); expect(puts).toBe(0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(puts).toBe(0);
  await page.getByRole('button', { name: '配置概览', exact: true }).click();
  await choose('布局模板', '6 个模块');
  await page.getByRole('button', { name: '上移未来 7 天到期', exact: true }).click();
  await choose('任务状态分布宽度', '占满一行');
  await page.screenshot({ path: resolve(output, 'project-overview-layout.png'), fullPage: true });
  await page.getByRole('button', { name: '保存布局', exact: true }).click();
  await expect(page.locator('.overview-widget')).toHaveCount(6); expect(puts).toBe(1);
  expect(layout.widgets[0].width).toBe('full'); expect(layout.widgets[3].kind).toBe('upcoming');
  await page.reload(); await expect(page.locator('.overview-widget')).toHaveCount(6);
  await page.getByRole('button', { name: '配置概览', exact: true }).click(); await choose('布局模板', '4 个模块'); await page.getByRole('button', { name: '保存布局', exact: true }).click(); await expect(page.locator('.overview-widget')).toHaveCount(4);
  await page.getByRole('button', { name: '配置概览', exact: true }).click();
  await choose('布局模板', '1 个模块'); await expect(page.getByRole('button', { name: '移除任务状态分布', exact: true })).toBeDisabled();
  await choose('布局模板', '2 个模块'); await choose('添加模块', '未分配任务'); await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('button', { name: '保存布局', exact: true }).click(); await expect(page.locator('.overview-widget')).toHaveCount(3);
  await page.getByRole('button', { name: '配置概览', exact: true }).click(); await page.getByRole('button', { name: '移除未分配任务', exact: true }).click(); await page.getByRole('button', { name: '恢复默认', exact: true }).click(); await page.getByRole('button', { name: '保存布局', exact: true }).click(); await expect(page.locator('.overview-widget')).toHaveCount(4);
  await page.getByRole('region', { name: '需要关注的任务', exact: true }).locator('.overview-task-item').first().click();
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue(tasks[0].title);
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); expect(new URL(page.url()).searchParams.get('focus')).toBe('attention');
  await overview();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.locator('.mantine-AppShell-main').evaluate(element => parseFloat(getComputedStyle(element).paddingLeft))).toBe(0);
  await page.screenshot({ path: resolve(output, 'project-overview-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.main-content').evaluate(element => element.getBoundingClientRect().width)).toBe(360);
  const widgetBoxes = await page.locator('.overview-widget').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().left)); expect(new Set(widgetBoxes).size).toBe(1);
  await page.getByRole('button', { name: '配置概览', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  for (const permission of ['member', 'viewer']) { role = permission; await overview(); await expect(page.getByRole('button', { name: '配置概览', exact: true })).toHaveCount(0); }
  role = 'admin'; archived = true; await overview(); await expect(page.getByRole('button', { name: '配置概览', exact: true })).toHaveCount(0);
  archived = false; await overview();
  await page.getByRole('button', { name: '配置概览', exact: true }).click(); await choose('页面列数', '单列'); conflict = true;
  await page.getByRole('button', { name: '保存布局', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('其他管理员已经修改了布局');
  await expect(page.getByRole('button', { name: '保存布局', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '读取最新布局', exact: true }).click(); await expect(page.locator('.overview-widget')).toHaveCount(4); conflict = false;
  allDone = true; await page.goto(`${base}/projects/p1?view=tasks&roots=true&focus=attention&asOfDate=${today}`);
  await page.getByRole('tab', { name: '项目概览', exact: true }).click();
  await expect(page.getByRole('button', { name: `查看已完成：${tasks.length} 项`, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '需要关注的任务', exact: true })).toContainText('暂无需要关注的任务');
  await page.getByRole('region', { name: '需要关注的任务', exact: true }).getByRole('button', { name: '查看全部', exact: true }).click();
  await expect(page.getByRole('tab', { name: '任务', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '列表', exact: true }).click(); await expect(page.locator('button.task-row')).toHaveCount(0);
  await page.getByRole('button', { name: '筛选 · 2', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '概览范围', exact: true })).toHaveValue('需要关注的任务');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '清空', exact: true }).click(); await expect(page.locator('button.task-row')).toHaveCount(tasks.length);
  allDone = false; empty = true; await overview(); await expect(page.getByRole('button', { name: '查看主任务总数：0 项', exact: true })).toBeVisible(); await expect(page.getByText('暂无未完成任务', { exact: true })).toBeVisible();
  fail = true; await page.getByRole('button', { name: '刷新', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('概览加载失败');
  fail = false; await page.getByRole('button', { name: '重新加载概览', exact: true }).click(); await expect(page.locator('.overview-widget')).toHaveCount(4);
  expect(errors).toEqual([]);
  console.log(`Passed: project overview charts, repeated same-URL drilldown, browser back/forward, visible scope/date filters, completed-only attention, filter reset, manual shared layout save/cancel/reload, templates, order/width, conflicts, roles, archived project, empty state, refresh recovery and mobile width. ${reads} mock reads; no real project data changed.`);
} catch (error) { await page.screenshot({ path: resolve(output, 'project-overview-failure.png'), fullPage: true }); console.error(errors); throw error; }
finally { await browser.close(); }
