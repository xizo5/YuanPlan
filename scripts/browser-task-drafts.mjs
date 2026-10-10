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
 const p=await api('/projects',{name:`附件与连续子任务回归 ${Date.now()}`});const parent=await api(`/projects/${p.id}/tasks`,{title:'父任务原始标题'});
 const existing=await api(`/projects/${p.id}/tasks`,{title:'已有任务'});
 await page.goto(`${base}/projects/${p.id}?task=${parent.id}`);
 await page.getByLabel('添加子任务',{exact:true}).fill('第一个子任务');await page.getByRole('button',{name:'添加',exact:true}).click();await expect(page.getByRole('button',{name:'第一个子任务',exact:true})).toBeVisible();
 await page.getByLabel('任务标题',{exact:true}).fill('尚未保存的父任务标题');await page.getByRole('textbox',{name:'正文编辑器',exact:true}).fill('尚未保存的正文');
 await page.getByLabel('添加子任务',{exact:true}).fill('第二个子任务');await page.getByRole('button',{name:'添加',exact:true}).click();await expect(page.getByRole('button',{name:'第二个子任务',exact:true})).toBeVisible();
 await page.getByLabel('添加子任务',{exact:true}).fill('第三个子任务');await page.getByRole('button',{name:'添加',exact:true}).click();await expect(page.getByRole('button',{name:'第三个子任务',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'关联已有任务',exact:true}).click();await page.getByLabel('搜索已有任务').fill(`#${existing.number}`);await page.getByRole('button',{name:'关联 已有任务',exact:true}).click();await expect(page.getByRole('button',{name:'已有任务',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'上传附件',exact:true})).toBeEnabled();
 const file={name:'attachment-regression.txt',mimeType:'text/plain',buffer:Buffer.from('attachment bytes preserved')};
 const upload=`**/api/projects/${p.id}/tasks/${parent.id}/files`;
 await page.route(upload,route=>route.request().method()==='POST'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_FAILURE',message:'模拟上传失败'}})}):route.continue());
 await page.locator('input[type=file]').setInputFiles(file);await expect(page.getByRole('alert')).toContainText('模拟上传失败');await expect(page.getByRole('button',{name:'上传附件',exact:true})).toBeEnabled();await page.unroute(upload);
 await page.locator('input[type=file]').setInputFiles(file);await expect(page.getByRole('link',{name:file.name,exact:true})).toBeVisible();
 await expect(page.getByLabel('任务标题',{exact:true})).toHaveValue('尚未保存的父任务标题');await expect(page.getByRole('textbox',{name:'正文编辑器',exact:true})).toHaveText('尚未保存的正文');
 expect((await api(`/projects/${p.id}/tasks/${parent.id}`)).title).toBe('父任务原始标题');
 const response=await context.request.get(base+await page.getByRole('link',{name:file.name,exact:true}).getAttribute('href'));expect(response.ok()).toBe(true);expect(await response.body()).toEqual(file.buffer);
 await page.locator('input[type=file]').setInputFiles({...file,name:'second-attachment.txt'});await expect(page.getByRole('link',{name:'second-attachment.txt',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'保存任务',exact:true}).click();await expect.poll(async()=>(await api(`/projects/${p.id}/tasks/${parent.id}`)).title).toBe('尚未保存的父任务标题');
 await page.reload();await expect(page.getByLabel('任务标题',{exact:true})).toHaveValue('尚未保存的父任务标题');await expect(page.getByRole('textbox',{name:'正文编辑器',exact:true})).toHaveText('尚未保存的正文');await expect(page.getByRole('link',{name:file.name,exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'第三个子任务',exact:true})).toBeVisible();
 expect((await api(`/projects/${p.id}/tasks?parentId=${parent.id}`)).items).toHaveLength(4);expect(errors).toEqual([]);
 console.log('Task draft regression passed: three consecutive subtasks, link while dirty, upload while dirty, failed upload retry, two attachments, download bytes, draft preservation, latest-version save and reload.');
} catch(e){await page.screenshot({path:'.data/task-draft-failure.png',fullPage:true});throw e;} finally {await browser.close();}
