import 'dotenv/config';
import { chromium } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const base=process.env.APP_URL ?? 'http://localhost:5173';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname)) throw new Error('This smoke test only runs against a local development instance');
await mkdir('.data',{recursive:true});
let account;
try { account=JSON.parse(await readFile('.data/preview-account.json','utf8')); } catch {
  const state=await fetch(`${base}/api/public/state`).then(r=>r.json());
  if(state.initialized)throw new Error('Instance already initialized; configure a local test account in .data/preview-account.json');
  account={email:'developer@yuanplan.local',name:'本地开发管理员',password:randomBytes(24).toString('base64url')};
  const result=await fetch(`${base}/api/public/setup`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({...account,setupToken:process.env.SETUP_TOKEN})});
  if(!result.ok)throw new Error(`Setup failed: ${await result.text()}`);
  await writeFile('.data/preview-account.json',JSON.stringify(account,null,2));
}
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.stack));
try{
 await page.goto(base);await page.getByLabel('邮箱').fill(account.email);await page.getByLabel('密码').fill(account.password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('heading',{name:'我的项目',exact:true}).waitFor();
 await page.getByRole('button',{name:'新建项目',exact:true}).click();const projectDialog=page.getByRole('dialog',{name:'新建项目',exact:true});await projectDialog.waitFor();await projectDialog.getByRole('textbox',{name:/^项目名称/}).fill(`产品体验验证 ${Date.now()}`);await projectDialog.getByLabel('项目简介').fill('验证任务协作、项目文档与可追溯的每一次保存。');await projectDialog.getByRole('button',{name:'创建项目',exact:true}).click();
 await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByLabel('任务标题').fill('完成产品首轮验证');await page.getByRole('button',{name:'创建任务',exact:true}).click();await page.getByRole('button',{name:'保存任务内容',exact:true}).waitFor();
 await page.getByLabel('任务标题',{exact:true}).fill('完成首轮验证并记录结果');await page.getByRole('button',{name:'保存任务内容',exact:true}).click();await page.getByText(/版本 2/).waitFor();await page.getByRole('button',{name:'变更记录',exact:true}).click();await page.getByText('本地开发管理员 · update').waitFor();await page.keyboard.press('Escape');await page.keyboard.press('Escape');
 await page.screenshot({path:'.data/board-preview.png',fullPage:true});
 await page.getByRole('tab',{name:'项目文档'}).click();await page.getByRole('button',{name:'新建',exact:true}).click();await page.getByLabel('文档标题').fill('项目需求说明');await page.getByRole('button',{name:'创建文档',exact:true}).click();await page.locator('.tiptap').waitFor();await page.locator('.tiptap').fill('每次成功保存都要能找到对应的人。');await page.getByText('版本 2',{exact:true}).waitFor({timeout:10000});await page.getByText('已保存',{exact:true}).waitFor();await page.screenshot({path:'.data/wiki-preview.png',fullPage:true});
 await page.reload();await page.getByRole('tab',{name:'项目文档'}).click();await page.getByRole('button',{name:'项目需求说明',exact:true}).click();await page.getByText('每次成功保存都要能找到对应的人。',{exact:true}).waitFor();
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('Browser smoke passed: login, project, task save/history, Wiki autosave and reload.');
}catch(e){await page.screenshot({path:'.data/browser-failure.png',fullPage:true});console.error(errors);console.error(await page.locator('body').innerText());throw e;}finally{await browser.close();}
