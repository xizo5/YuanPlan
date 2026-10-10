import 'dotenv/config';
import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const base=process.env.APP_URL??'http://localhost:5173';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('Local instance required');
const account=JSON.parse(await readFile('.data/preview-account.json','utf8'));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const admin=await browser.newContext();const old=await browser.newContext();const recovery=await browser.newContext();const page=await recovery.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
async function api(context,path,body,method=body?'POST':'GET'){const r=await context.request.fetch(`${base}/api${path}`,{method,headers:{Origin:base,'Idempotency-Key':randomUUID()},...(body?{data:body}:{})});if(!r.ok())throw new Error(`${path}: ${r.status()}`);return r.json();}
try{
 await api(admin,'/auth/sign-in/email',{email:account.email,password:account.password});const p=await api(admin,'/projects',{name:`恢复回归 ${Date.now()}`});
 const email=`recovery-${randomUUID()}@example.test`;const invitation=await api(admin,`/invitations/project/${p.id}`,{email,role:'member'});
 const before=`Before-${randomUUID()}`,after=`After-${randomUUID()}`;
 await api(old,'/public/register',{name:'恢复回归账号',email,password:before,inviteToken:new URL(invitation.url).searchParams.get('token')});await api(old,'/auth/sign-in/email',{email,password:before});const me=await api(old,'/me');
 const credential=await api(old,'/credentials',{name:'recovery regression',projectIds:[p.id],scope:'read'});
 await page.goto(base);await page.getByRole('button',{name:'忘记密码？',exact:true}).click();await expect(page.getByRole('heading',{name:'找回账号',exact:true})).toBeVisible();
 const state=await api(admin,'/public/state');if(!state.emailEnabled)await expect(page.getByRole('button',{name:'发送恢复邮件',exact:true})).toBeDisabled();
 const link=await api(admin,`/instance/users/${me.id}/recovery`,{});await page.goto(link.url);await page.getByLabel('密码').fill(after);await page.getByRole('button',{name:'重置密码',exact:true}).click();await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
 expect((await old.request.get(`${base}/api/me`)).status()).toBe(401);
 const tokenResponse=await old.request.post(`${base}/api/mcp`,{headers:{Authorization:`Bearer ${credential.token}`,Origin:base,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},data:{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'recovery-test',version:'1'}}}});expect(tokenResponse.ok()).toBe(false);
 await page.getByLabel('邮箱').fill(email);await page.getByLabel('密码').fill(after);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('heading',{name:'我的项目',exact:true}).waitFor();
 await page.goto(link.url);await page.getByLabel('密码').fill(`Replay-${randomUUID()}`);await page.getByRole('button',{name:'重置密码',exact:true}).click();await expect(page.getByText('恢复链接无效或已过期',{exact:true})).toBeVisible();
 if(errors.length)throw new Error(errors.join('\n'));console.log('Recovery browser regression passed: recovery entry, no-mail guidance, password reset, session/MCP revocation, new-password login, token replay rejection.');
}catch(e){await page.screenshot({path:'.data/recovery-regression-failure.png',fullPage:true});throw e;}finally{await browser.close();}
