// Read-only production checks; the only action starts/reuses the dedicated browser.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const origin='http://127.0.0.1:3090';
const call=(url,options={})=>fetch(origin+url,options);
assert.equal((await (await call('/__pvs/health')).json()).service,'pvs-web-fnos');
assert.equal((await call('/api/projects')).status,401);
assert.equal((await call('/browser/douyin/vnc.html')).status,401);
assert.equal((await call('/login',{method:'POST',body:'password=wrong'})).status,401);
assert.equal((await call('/login',{method:'POST',headers:{origin:'invalid'},body:'password=x'})).status,403);
const login=await call('/login',{method:'POST',body:new URLSearchParams({password:process.env.PVS_SESSION_TOKEN}),redirect:'manual'});
assert.equal(login.status,303);
const cookie=login.headers.get('set-cookie').split(';')[0];assert.equal(cookie.includes(process.env.PVS_SESSION_TOKEN),false);
const headers={cookie};const pages={};
for(const page of ['/projects','/tasks','/settings/ai','/douyin-ops','/browser/douyin','/browser/douyin/vnc.html','/browser/douyin/core/rfb.js']){
  const response=await call(page,{headers});assert.equal(response.status,200,page);pages[page]=response.status;
}
assert.equal((await (await call('/api/projects',{headers})).json()).projects.length,0);
const rfb=await new Promise((resolve,reject)=>{
  const request=http.request(origin+'/browser/douyin/websockify',{headers:{cookie,origin,connection:'Upgrade',upgrade:'websocket',
    'sec-websocket-key':Buffer.alloc(16).toString('base64'),'sec-websocket-version':'13','sec-websocket-protocol':'binary'}});
  request.on('response',response=>{response.resume();reject(Error('VNC upgrade '+response.statusCode));});
  request.on('upgrade',(_response,socket,head)=>{
    const timer=setTimeout(()=>{socket.destroy();reject(Error('VNC greeting timeout'));},5000);
    const inspect=bytes=>{if(bytes.includes(Buffer.from('RFB '))){clearTimeout(timer);socket.destroy();resolve(true);}};
    if(head.length)inspect(head);socket.on('data',inspect);socket.on('error',reject);
  });request.on('error',reject);request.end();
});
const launch=await call('/api/douyin/ops/launch',{method:'POST',headers});
assert.equal(launch.status,200,await launch.text());
const reuse=await call('/api/douyin/ops/launch',{method:'POST',headers});
assert.equal(reuse.status,200);assert.match((await reuse.json()).message,/复用/);
const version=await (await fetch('http://127.0.0.1:9223/json/version')).json();
assert.ok(version.Browser.startsWith('Chrome/'));
const profile=path.join(process.env.PVS_DATA_ROOT??'/data','browser/douyin');
await fs.access(path.join(profile,'Default'));
process.env.DATABASE_URL='file:/data/db/pvs.db';
const {prisma}=await import('../dist/src/adapters/db/prisma-client.js');
assert.equal((await prisma.$queryRawUnsafe('PRAGMA integrity_check'))[0].integrity_check,'ok');
const counts={projects:await prisma.project.count(),attempts:await prisma.generationAttemptRecord.count()};
assert.deepEqual(counts,{projects:0,attempts:0});await prisma.$disconnect();
const source=await fs.readFile(path.join(profile,'Local State'),'utf8');assert.ok(source.length>0);
let cdp;
for(let count=0;count<20;count++){
  cdp=await (await fetch('http://127.0.0.1:19423/health')).json();
  if(cdp.ready)break;await new Promise(resolve=>setTimeout(resolve,1000));
}
console.log(JSON.stringify({result:'PASS',pages,remoteVncHandshake:rfb,sessionCookieHidesPassword:true,
  browserLaunch:true,browserReuse:true,chromium:version.Browser,profilePersistentDirectory:true,
  cdpBridgeRunning:cdp.running,cdpBridgeRegistered:cdp.ready,counts,sqliteIntegrity:'ok',
  loginPerformed:false,paidGeneration:false,publishing:false}));
