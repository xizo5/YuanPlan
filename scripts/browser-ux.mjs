import 'dotenv/config';
import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const base=process.env.APP_URL??'http://localhost:5173';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('Local instance required');
const account=JSON.parse(await readFile('.data/preview-account.json','utf8'));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
async function api(path,body){const r=await context.request.fetch(`${base}/api${path}`,{method:body?'POST':'GET',headers:{Origin:base,'Idempotency-Key':randomUUID()},...(body?{data:body}:{})});if(!r.ok())throw new Error(`${path}: ${r.status()}`);return r.json();}
async function checkLayout(label){
 const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
 expect(overflow.scroll,`${label}: page horizontal overflow`).toBeLessThanOrEqual(overflow.width+1);
 await expect(page.getByRole('navigation',{name:'工作空间导航'})).toBeVisible();
 const unnamed=await page.locator('input:not([type=hidden]),textarea,[contenteditable=true]').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length&&!n.getAttribute('aria-label')&&!n.getAttribute('aria-labelledby')&&!n.labels?.length).map(n=>({tag:n.tagName,type:n.getAttribute('type')})));
 expect(unnamed,`${label}: unnamed form controls`).toEqual([]);
}
try{
 const scripts=[];page.on('request',request=>{if(request.resourceType()==='script')scripts.push(new URL(request.url()).pathname);});
 await page.goto(base);await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
 expect(scripts.some(path=>/\/(ProjectPage|Settings|Editor)-/.test(path)),'login should defer workspace and editor chunks').toBe(false);
 await api('/auth/sign-in/email',{email:account.email,password:account.password});
 const p=await api('/projects',{name:`体验回归 ${Date.now()}`});
 const t=await api(`/projects/${p.id}/tasks`,{title:'键盘与窄屏任务'});
 const d=await api(`/projects/${p.id}/documents`,{title:'窄屏文档',content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'长内容'.repeat(100)}]}]}});
 for(const width of [360,600,767,768,769,1024,1440]){
  await page.setViewportSize({width,height:1000});
  for(const [path,title] of [['/','我的项目'],['/my-tasks','我的任务'],['/teams','团队'],['/integrations','AI 与集成'],['/settings','实例设置']]){
   await page.goto(base+path);await page.getByRole('heading',{name:title,exact:true}).waitFor();await checkLayout(`${width} ${path}`);
  }
  await page.goto(`${base}/projects/${p.id}`);await page.locator('.task-card').waitFor();await checkLayout(`${width} board`);
  for(const name of ['成员','标签','项目管理']){await page.getByRole('tab',{name,exact:true}).click();await checkLayout(`${width} ${name}`);}await page.getByRole('tab',{name:'任务',exact:true}).click();await page.locator('.task-card').waitFor();
  await page.locator('.task-card').focus();await page.keyboard.press('Enter');await expect(page.getByLabel('任务标题',{exact:true})).toHaveValue(t.title);
  await expect(page.getByRole('textbox',{name:'正文编辑器',exact:true})).toHaveAttribute('contenteditable','true');await checkLayout(`${width} task drawer`);
  await page.keyboard.press('Escape');await expect(page.getByLabel('任务标题',{exact:true})).toHaveCount(0);await expect(page.locator('.task-card')).toBeFocused();
  await page.goto(`${base}/projects/${p.id}?document=${d.id}`);await page.getByRole('textbox',{name:'正文编辑器',exact:true}).waitFor();await checkLayout(`${width} wiki`);
 }
 await page.goto(base);const create=page.getByRole('button',{name:'新建项目',exact:true});await create.focus();await page.keyboard.press('Enter');await expect(page.getByRole('dialog')).toBeVisible();
 for(let i=0;i<12;i++){await page.keyboard.press('Tab');expect(await page.getByRole('dialog').evaluate(el=>el.contains(document.activeElement))).toBe(true);}
 await page.keyboard.press('Escape');await expect(create).toBeFocused();
 const nav=page.getByRole('navigation').getByRole('button',{name:'我的任务',exact:true});await nav.focus();await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:'我的任务',exact:true})).toBeVisible();
 await page.route('**/api/projects',route=>route.request().method()==='GET'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_UNAVAILABLE',message:'测试服务暂不可用'}})}):route.continue());
 await page.goto(base);await expect(page.getByRole('alert')).toContainText('测试服务暂不可用');await expect(page.getByRole('heading',{name:'第一个项目，从这里开始'})).toHaveCount(0);await page.unroute('**/api/projects');
 const viewer=await browser.newContext();
 try{
  const email=`ux-${randomUUID()}@example.test`,password=`UX-${randomUUID()}`;
  const invitation=await api(`/invitations/project/${p.id}`,{email,role:'viewer'});
  async function viewerPost(path,data){const r=await viewer.request.post(`${base}/api${path}`,{headers:{Origin:base},data});expect(r.ok(),path).toBe(true);}
  await viewerPost('/public/register',{name:'体验只读成员',email,password,inviteToken:new URL(invitation.url).searchParams.get('token')});
  await viewerPost('/auth/sign-in/email',{email,password});
  const vp=await viewer.newPage();await vp.setViewportSize({width:360,height:1000});
  await vp.goto(`${base}/projects/${p.id}?task=${t.id}`);await expect(vp.getByLabel('任务标题',{exact:true})).toHaveAttribute('readonly','');
  await expect(vp.getByRole('button',{name:'保存任务',exact:true})).toHaveCount(0);
  await expect(vp.getByRole('textbox',{name:'正文编辑器',exact:true})).toHaveAttribute('aria-readonly','true');
  await vp.keyboard.press('Escape');await expect(vp.getByText(/你是只读成员，可以查看/)).toBeVisible();
  await expect(vp.getByRole('button',{name:'新建任务',exact:true})).toHaveCount(0);await expect(vp.getByRole('tab',{name:'项目管理',exact:true})).toHaveCount(0);
  await vp.goto(`${base}/projects/${p.id}?document=${d.id}`);await expect(vp.getByRole('textbox',{name:'正文编辑器',exact:true})).toHaveAttribute('contenteditable','false');
  await expect(vp.getByRole('button',{name:'保存',exact:true})).toHaveCount(0);
 }finally{await viewer.close();}
 expect(errors).toEqual([]);console.log('UX regression passed: seven viewport widths, project/task/team/Wiki layouts, named inputs, keyboard navigation, editor semantics, dialog focus trap/restoration, viewer read-only task and Wiki controls.');
}catch(e){await page.screenshot({path:'.data/ux-regression-failure.png',fullPage:true});throw e;}finally{await browser.close();}
