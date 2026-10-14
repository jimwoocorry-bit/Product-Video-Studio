import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {recoverProfileLocks} from './profile-locks.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=path.resolve(process.env.PVS_DATA_ROOT??'/data');
const cli=path.join(root,'vendor/douyin-cli');
const children=new Map();
let stopping=false,browser=null,launchPromise=null;
process.umask(0o077);
for(const directory of ['db','logs','config','browser/douyin','.runtime-secrets'])await fsp.mkdir(path.join(data,directory),{recursive:true,mode:0o700});
const configFile=path.join(data,'.runtime-secrets/douyin-bridge.json');
try {await fsp.writeFile(configFile,JSON.stringify({bridge:{host:'127.0.0.1',port:19422,token:randomBytes(32).toString('hex'),
  heartbeatInterval:30000,heartbeatTimeout:10000,heartbeatMaxFailures:3,requestTimeout:30000,maxBodySize:8*1024*1024}}),{flag:'wx',mode:0o600});}
catch(error){if(error.code!=='EEXIST')throw error;}
Object.assign(process.env,{DISPLAY:':99',PVS_RUNTIME_MODE:'fnos',PVS_DATA_ROOT:data,
  PVS_DOUYIN_OPS_ROOT:cli,PVS_DOUYIN_CONFIG_PATH:configFile,PVS_DOUYIN_CDP_URL:'http://127.0.0.1:9223',
  PVS_DOUYIN_BRIDGE_SOURCE:path.join(cli,'scripts/douyin.user.js')});
if(process.platform!=='linux'||process.getuid()===0)throw Error('Linux browser runtime must run as a non-root user');
if(process.env.PVS_PROFILE_LOCK_HELD!=='1')throw Error('Start the runtime through its exclusive flock entry point');

function start(name,command,args,{critical=true}={}) {
  const log=fs.openSync(path.join(data,'logs',name+'.log'),'a',0o600);
  const child=spawn(command,args,{cwd:root,env:process.env,stdio:['ignore',log,log]});
  fs.closeSync(log);children.set(name,child);
  child.on('error',error=>{console.error(JSON.stringify({event:'service-error',service:name,code:error.code}));if(critical)void shutdown(1);});
  child.on('exit',code=>{
    if(children.get(name)===child)children.delete(name);
    if(name==='chromium')browser=null;
    if(!stopping&&critical){console.error(JSON.stringify({event:'service-exit',service:name,code}));void shutdown(1);}
  });
  return child;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(check,timeout=10000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return true;await sleep(200);}return false;
}
async function probe(url) {try{return (await fetch(url,{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}}

start('display','/usr/bin/Xvfb',[':99','-screen','0','1440x900x24','-nolisten','tcp','-ac']);
if(!await wait(()=>Promise.resolve(fs.existsSync('/tmp/.X11-unix/X99'))))throw Error('Display startup timed out');
start('window-manager','/usr/bin/openbox',['--sm-disable']);
start('vnc','/usr/bin/x11vnc',['-display',':99','-forever','-shared','-localhost','-rfbport','5900','-nopw','-noxdamage']);
start('remote-view','/usr/bin/websockify',['--web=/usr/share/novnc','127.0.0.1:6080','127.0.0.1:5900']);
start('douyin-bridge',process.execPath,[path.join(cli,'server.js')]);
start('cdp-bridge',process.execPath,[path.join(root,'scripts/douyin-ops-cdp-bridge.mjs')]);

async function launch() {
  if(launchPromise)return launchPromise;
  launchPromise=(async()=>{
    if(browser&&await probe('http://127.0.0.1:9223/json/version'))return {ok:true,alreadyRunning:true};
    if(browser){browser.kill('SIGTERM');await sleep(300);}
    await recoverProfileLocks(path.join(data,'browser/douyin'),{exclusiveLockHeld:true});
    browser=start('chromium','/usr/bin/chromium',[
      '--user-data-dir='+path.join(data,'browser/douyin'),'--remote-debugging-address=127.0.0.1','--remote-debugging-port=9223',
      '--no-first-run','--no-default-browser-check','--start-maximized','--disable-dev-shm-usage','--disable-session-crashed-bubble',
      'https://www.douyin.com/'
    ],{critical:false});
    if(!await wait(()=>probe('http://127.0.0.1:9223/json/version'),15000))return {ok:false,code:'BROWSER_START_FAILED'};
    return {ok:true,alreadyRunning:false};
  })().finally(()=>{launchPromise=null;});
  return launchPromise;
}
const controller=http.createServer(async(req,res)=>{
  if(req.headers.origin){res.writeHead(403);res.end();return;}
  if(req.url==='/health'&&req.method==='GET') {
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,browserRunning:Boolean(browser)}));return;
  }
  if(req.url!=='/launch'||req.method!=='POST'){res.writeHead(404);res.end();return;}
  const result=await launch().catch(()=>({ok:false,code:'BROWSER_START_FAILED'}));
  res.writeHead(result.ok?200:503,{'content-type':'application/json'});res.end(JSON.stringify(result));
});
await new Promise((resolve,reject)=>{controller.once('error',reject);controller.listen(19424,'127.0.0.1',resolve);});
if(!await wait(()=>probe('http://127.0.0.1:19422/api/health')))throw Error('Bridge startup timed out');
start('pvs',process.execPath,['--use-system-ca',path.join(root,'runtime/server.mjs')]);
console.log(JSON.stringify({event:'fnos-runtime-started',browserLaunch:'explicit-user-action'}));

async function shutdown(code=0) {
  if(stopping)return;stopping=true;controller.close();
  // Chromium must finish writing its profile before Xvfb/window manager exit.
  if(browser){browser.kill('SIGTERM');await wait(()=>Promise.resolve(!children.has('chromium')),6000);}
  for(const child of children.values())child.kill('SIGTERM');
  const deadline=Date.now()+10000;
  while(children.size&&Date.now()<deadline)await sleep(200);
  for(const child of children.values())child.kill('SIGKILL');
  process.exit(code);
}
process.once('SIGTERM',()=>void shutdown());process.once('SIGINT',()=>void shutdown());
