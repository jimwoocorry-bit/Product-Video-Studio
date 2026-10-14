import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createSessionGuard} from './session.mjs';
import {createBrowserProxy} from './browser-proxy.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=path.resolve(process.env.PVS_DATA_ROOT??'/data');
const guard=createSessionGuard(process.env.PVS_SESSION_TOKEN);
process.umask(0o077);
for(const directory of ['db','logs','config'])await fs.mkdir(path.join(data,directory),{recursive:true});
try{await fs.writeFile(path.join(data,'db/pvs.db'),'',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
try{await fs.copyFile(path.join(root,'config/p0-generation.json'),path.join(data,'config/p0-generation.json'),1);}catch(error){if(error.code!=='EEXIST')throw error;}
Object.assign(process.env,{DATABASE_URL:'file:'+path.join(data,'db/pvs.db').replaceAll('\\','/'),
  PROJECTS_ROOT:path.join(data,'projects'),PVS_SECRETS_ROOT:path.join(data,'.runtime-secrets/ai-providers'),
  PVS_RUNTIME_MODE:'fnos',PVS_SMART_WORKER_DISABLED:'1',PVS_SMART_WORKER_MANAGED_NEW_RUNS:process.env.PVS_VERIFY_ONLY==='1'?'0':'1'});
process.chdir(data);
const migrationLog=await fs.open(path.join(data,'logs/migrations.log'),'a');
try{
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,'node_modules/prisma/build/index.js'),'migrate','deploy','--schema',path.join(root,'prisma/schema.prisma')],
      {cwd:root,env:process.env,stdio:['ignore',migrationLog.fd,migrationLog.fd]});
    child.on('error',reject);child.on('exit',resolve);
  });
  if(code!==0)throw Error('Database migrations failed; see logs/migrations.log');
}finally{await migrationLog.close();}
process.env.NODE_ENV='test';
const {createDefaultDependencies,createAppServer}=await import('../dist/src/web/server.js');
process.env.NODE_ENV='production';
const {prisma}=await import('../dist/src/adapters/db/prisma-client.js');
const dependencies=createDefaultDependencies();
await dependencies.publishBridge.recoverInterruptedDirectPublishes();
const app=createAppServer(dependencies);
const handler=app.listeners('request')[0];app.removeAllListeners('request');
const proxy=createBrowserProxy(guard);
const attempts=new Map();
const loginPage='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PVS Linux 登录</title><style>body{font:16px system-ui;background:#f4f7fc;color:#172a46}main{max-width:420px;margin:15vh auto;background:white;padding:32px;border-radius:16px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #ccd5e2}button{background:#2767ca;color:white}</style><main><h1>Product Video Studio</h1><p>飞牛 / Linux 独立版</p><form method="post" action="/login"><label>访问口令<input type="password" name="password" autocomplete="current-password" required></label><button>进入工作台</button></form></main></html>';
app.on('request',async(req,res)=>{
  try{
    const url=new URL(req.url??'/','http://pvs.invalid');
    if(url.pathname==='/__pvs/health'&&req.method==='GET'){
      res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({status:'ok',service:'pvs-web-fnos',version:'0.1.0'}));
    }
    if(url.pathname==='/login'&&req.method==='GET'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(loginPage);
    }
    if(!guard.originAllowed(req)){res.writeHead(403);return res.end('Forbidden');}
    if(url.pathname==='/login'&&req.method==='POST'){
      const now=Date.now();for(const [key,value]of attempts)if(value.until<now)attempts.delete(key);
      const address=req.socket.remoteAddress;const attempt=attempts.get(address);
      if(attempt?.count>=10){res.writeHead(429,{'retry-after':'60'});return res.end('请稍后再试');}
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2048){res.writeHead(413);return res.end();}}
      if(!guard.checkPassword(new URLSearchParams(body).get('password'))){
        if(attempts.size>10000)attempts.delete(attempts.keys().next().value);
        attempts.set(address,{count:(attempt?.count??0)+1,until:now+60_000});
        res.writeHead(401,{'content-type':'text/plain; charset=utf-8'});return res.end('访问口令不正确');
      }
      attempts.delete(address);
      res.writeHead(303,{location:'/projects','cache-control':'no-store',
        'set-cookie':`pvs_session=${guard.issue()}; Path=/; HttpOnly; SameSite=Strict${process.env.PVS_COOKIE_SECURE==='1'?'; Secure':''}`});return res.end();
    }
    if(!guard.authenticated(req)){
      if(req.method==='GET'&&!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/browser/')){res.writeHead(303,{location:'/login'});return res.end();}
      res.writeHead(401);return res.end('请先登录 PVS');
    }
    if(url.pathname==='/logout'&&req.method==='POST'){
      guard.revoke(req);res.writeHead(303,{location:'/login','set-cookie':'pvs_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'});return res.end();
    }
    if(url.pathname==='/browser/douyin'&&req.method==='GET'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'SAMEORIGIN'});
      return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>抖音远程浏览器 · PVS</title><style>body{margin:0;font:15px system-ui;background:#eef3f9;color:#172a46}header{padding:14px;display:flex;gap:18px;align-items:center}iframe{width:100%;height:calc(100vh - 110px);border:0}button{padding:8px 14px}#status{padding:0 14px 12px}</style><header><a href="/douyin-ops">返回抖音运营</a><strong>服务器专用浏览器</strong><button id="launch">启动 / 恢复浏览器</button></header><div id="status">在下方浏览器中扫码登录。登录状态保存在此服务器；遇到验证码时请人工处理。</div><iframe title="抖音服务器浏览器" src="/browser/douyin/vnc.html?autoconnect=true&resize=scale&path=browser%2Fdouyin%2Fwebsockify"></iframe><script>document.getElementById('launch').onclick=async function(){this.disabled=true;try{const r=await fetch('/api/douyin/ops/launch',{method:'POST'});const result=await r.json();document.getElementById('status').textContent=result.message||'请检查连接';}catch{document.getElementById('status').textContent='浏览器服务暂不可用，请重试';}finally{this.disabled=false}};</script></html>`);
    }
    if(proxy.handle(req,res))return;
    return handler(req,res);
  }catch{if(!res.headersSent)res.writeHead(500);res.end('服务处理失败，请查看服务器日志。');}
});
app.on('upgrade',proxy.upgrade);
let stopping=false;
async function shutdown(){
  if(stopping)return;stopping=true;
  const timer=setTimeout(()=>process.exit(1),8000);timer.unref();
  proxy.close();app.closeIdleConnections?.();await new Promise(resolve=>app.close(resolve));await prisma.$disconnect();process.exit(0);
}
process.once('SIGTERM',()=>void shutdown());process.once('SIGINT',()=>void shutdown());
app.listen(Number(process.env.PVS_LISTEN_PORT??3090),process.env.PVS_LISTEN_HOST??'0.0.0.0',()=>console.log(JSON.stringify({event:'pvs-ready',mode:'fnos'})));
