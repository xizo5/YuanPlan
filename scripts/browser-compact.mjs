import 'dotenv/config';
import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const base=process.env.APP_URL??'http://localhost:5173';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('Local instance required');
const account=JSON.parse(await readFile('.data/preview-account.json','utf8'));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:900}});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 const login=await context.request.post(`${base}/api/auth/sign-in/email`,{headers:{Origin:base},data:{email:account.email,password:account.password}});expect(login.ok()).toBe(true);
 const projects=await (await context.request.get(`${base}/api/projects`)).json();const project=projects.find(p=>!p.archivedAt&&!p.deletedAt);expect(project).toBeTruthy();
 const root={id:'compact-parent',number:1,title:'统一工作空间界面',status:'todo',priority:'high',assigneeId:null,dueDate:'2026-09-30',labels:['设计'],childCount:1,childDone:0,projectId:project.id};
 const child={...root,id:'compact-child',number:2,title:'检查窄屏布局',parentId:root.id,childCount:0};
 const done={...root,id:'compact-done',number:3,title:'移除重复副标题',status:'done',priority:'normal',childCount:0};
 // Read-only fixture for deterministic UI checks; no project data is changed.
 await page.route(`**/api/projects/${project.id}/tasks?*`,route=>{
  const params=new URL(route.request().url()).searchParams;let items=params.has('parentId')?[child]:[root,child,done];
  if(params.get('roots')==='true')items=items.filter(t=>!t.parentId);
  if(params.get('status'))items=items.filter(t=>t.status===params.get('status'));
  if(params.get('query'))items=items.filter(t=>t.title.includes(params.get('query')));
  if(params.get('dueFrom'))items=items.filter(t=>t.dueDate>=params.get('dueFrom'));
  return route.fulfill({contentType:'application/json',body:JSON.stringify({items,nextCursor:null})});
 });
 await page.goto(base);await page.locator('.project-row').first().waitFor();await expect(page.getByText('从一个清晰的目标，开始下一段协作。')).toHaveCount(0);
 await page.screenshot({path:'.data/compact-projects.png',fullPage:true});
 await page.goto(`${base}/projects/${project.id}`);await page.locator('.task-card').first().waitFor();await expect(page.getByLabel('截止日期从')).not.toBeVisible();
 await page.screenshot({path:'.data/compact-board.png',fullPage:true});
 await page.getByRole('button',{name:'列表',exact:true}).click();await expect(page.locator('button.task-row:visible')).toHaveCount(3);
 await expect(page.locator('summary')).toHaveCount(0);
 await page.getByRole('button',{name:'筛选',exact:true}).click();await page.getByRole('combobox',{name:'状态',exact:true}).click();await page.getByRole('option',{name:'已完成',exact:true}).click();await expect(page.locator('button.task-row:visible')).toHaveCount(1);
 await page.getByRole('button',{name:'筛选 · 1',exact:true}).click();await expect(page.getByLabel('截止日期从')).not.toBeVisible();await expect(page.locator('button.task-row:visible')).toHaveCount(1);
 await page.getByRole('button',{name:'清空',exact:true}).click();await expect(page.locator('button.task-row:visible')).toHaveCount(3);
 await page.getByRole('textbox',{name:'搜索任务',exact:true}).fill('统一');await expect(page.locator('button.task-row:visible')).toHaveCount(1);await page.getByRole('textbox',{name:'搜索任务',exact:true}).fill('');await expect(page.locator('button.task-row:visible')).toHaveCount(3);
 await page.getByRole('button',{name:'筛选',exact:true}).click();await page.getByLabel('截止日期从',{exact:true}).fill('2026-10-01');await expect(page.locator('button.task-row:visible')).toHaveCount(0);await page.getByRole('button',{name:'清空',exact:true}).click();await expect(page.locator('button.task-row:visible')).toHaveCount(3);await page.getByRole('button',{name:'筛选',exact:true}).click();
 await page.screenshot({path:'.data/compact-tasks.png',fullPage:true});
 for(const width of [360,768,1440]){
  await page.setViewportSize({width,height:900});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),{message:`No page overflow at ${width}px`}).toBe(true);
  await expect(page.getByRole('button',{name:'新建任务',exact:true})).toBeVisible();
  if(width===360)await page.screenshot({path:'.data/compact-mobile.png',fullPage:true});
 }
 expect(errors).toEqual([]);console.log('Compact UI passed: project rows, board/list switch, flat subtasks without duplicate expansion, status filter, collapsed filter persistence, clear, search and 360/768/1440px layouts. Screenshots saved to .data/compact-*.png.');
} finally {await browser.close();}
