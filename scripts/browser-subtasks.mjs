import 'dotenv/config';
import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const base=process.env.APP_URL??'http://localhost:5173';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('Local instance required');
const account=JSON.parse(await readFile('.data/preview-account.json','utf8'));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
async function api(path,body){const r=await context.request.fetch(`${base}/api${path}`,{method:body?'POST':'GET',headers:{Origin:base,'Idempotency-Key':randomUUID()},...(body?{data:body}:{})});if(!r.ok())throw new Error(`${path}: ${r.status()}`);return r.json();}
try {
 await api('/auth/sign-in/email',{email:account.email,password:account.password});
 const p=await api('/projects',{name:`子任务回归 ${Date.now()}`});
 const parent=await api(`/projects/${p.id}/tasks`,{title:'父任务：交付新版界面'});
 const existing=await api(`/projects/${p.id}/tasks`,{title:'已有任务：验收布局',status:'in_progress'});
 await page.goto(`${base}/projects/${p.id}?task=${parent.id}`);await page.getByLabel('添加子任务',{exact:true}).fill('新建子任务：修正间距');await page.getByRole('button',{name:'添加',exact:true}).click();await expect(page.getByRole('button',{name:'新建子任务：修正间距',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');await expect(page.locator('.task-card').filter({hasText:'新建子任务：修正间距'})).toBeVisible();
 await page.locator('.task-card').filter({hasText:'父任务：交付新版界面'}).first().click();
 await page.getByRole('button',{name:'关联已有任务',exact:true}).click();await page.getByLabel('搜索已有任务').fill(`#${existing.number}`);await page.getByRole('button',{name:'关联 已有任务：验收布局',exact:true}).click();
 await expect(page.getByRole('button',{name:'已有任务：验收布局',exact:true})).toBeVisible();
 expect(await api(`/projects/${p.id}/tasks/${existing.id}`)).toMatchObject({parentId:parent.id,status:'in_progress',number:existing.number});
 await page.getByRole('button',{name:'解除关联 已有任务：验收布局',exact:true}).click();await expect(page.getByRole('button',{name:'已有任务：验收布局',exact:true})).toHaveCount(0);expect((await api(`/projects/${p.id}/tasks/${existing.id}`)).parentId).toBeNull();
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'列表',exact:true}).click();await expect(page.locator('button.task-row')).toHaveCount(3);await expect(page.locator('summary')).toHaveCount(0);
 await page.getByRole('button',{name:'筛选',exact:true}).click();await page.getByLabel('隐藏子任务').check();await expect(page.locator('button.task-row')).toHaveCount(2);await page.getByRole('button',{name:'清空',exact:true}).click();await expect(page.locator('button.task-row')).toHaveCount(3);await page.getByRole('button',{name:'筛选',exact:true}).click();
 await page.getByRole('button',{name:'看板',exact:true}).click();
 const handle=page.getByRole('button',{name:'移动任务 新建子任务：修正间距',exact:true});const target=page.locator('.column-done');const h=await handle.boundingBox();const d=await target.boundingBox();
 await page.mouse.move(h.x+h.width/2,h.y+h.height/2);await page.mouse.down();await page.mouse.move(h.x+12,h.y+12,{steps:3});await page.mouse.move(d.x+d.width/2,d.y+100,{steps:15});await page.mouse.up();
 await expect(page.locator('.column-done .task-card').filter({hasText:'新建子任务：修正间距'})).toBeVisible();expect((await api(`/projects/${p.id}/tasks/${parent.id}`)).status).toBe('todo');
 await page.locator('.column-done .task-card').filter({hasText:'新建子任务：修正间距'}).click();await page.getByRole('button',{name:'解除父子关系',exact:true}).click();await expect(page.getByRole('button',{name:'返回父任务',exact:true})).toHaveCount(0);await page.keyboard.press('Escape');
 await page.screenshot({path:'.data/subtask-board.png',fullPage:true});expect(errors).toEqual([]);
 console.log('Subtask browser regression passed: create refresh, link by number, preserve state, unlink, flat list without duplicates, hide/reset, actual child drag and independent parent state, detach from child.');
} catch(e){await page.screenshot({path:'.data/subtask-failure.png',fullPage:true});throw e;} finally {await browser.close();}
