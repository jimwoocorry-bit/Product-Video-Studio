import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {pathToFileURL} from "node:url";
import {LinuxDouyinOpsLauncher,LinuxDouyinResearchAuthLauncher} from "../src/adapters/douyin/linux-douyin-ops-launcher.js";
import {LocalAesSecretStore} from "../src/adapters/store/platform-secret-store.js";

const runtime=(file:string)=>import(pathToFileURL(path.resolve("runtime",file)).href);
test("Profile recovery requires exclusive ownership and never removes ordinary files",async()=>{
  const {recoverProfileLocks}=await runtime("profile-locks.mjs");
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"pvs-profile-guard-"));
  await assert.rejects(recoverProfileLocks(directory),/Exclusive/);
  const file=path.join(directory,"SingletonLock");await fs.writeFile(file,"preserve this file");
  await assert.rejects(recoverProfileLocks(directory,{exclusiveLockHeld:true}),/refusing/);
  assert.equal(await fs.readFile(file,"utf8"),"preserve this file");
});
test("Linux profile recovery clears only stale singleton symlinks and preserves login data",{skip:process.platform!=="linux"},async()=>{
  const {recoverProfileLocks}=await runtime("profile-locks.mjs");
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"pvs-profile-recovery-"));
  await fs.writeFile(path.join(directory,"Preferences"),"mock-login-profile");
  for(const name of ["SingletonLock","SingletonCookie","SingletonSocket"])await fs.symlink("old-container-123",path.join(directory,name));
  await recoverProfileLocks(directory,{exclusiveLockHeld:true});
  assert.equal(await fs.readFile(path.join(directory,"Preferences"),"utf8"),"mock-login-profile");
  assert.deepEqual(await fs.readdir(directory),["Preferences"]);
});
test("Linux launcher reports failure honestly and reuses a live server browser",async()=>{
  const calls:Array<{url:string;method?:string}>=[];
  const request=(async(url:unknown,options:RequestInit)=>{
    calls.push({url:String(url),method:options.method});
    return Response.json({ok:true,alreadyRunning:true});
  }) as typeof fetch;
  const ready=await new LinuxDouyinOpsLauncher(request).launch();
  assert.equal(ready.ok,true);assert.match(ready.message,/复用/);
  assert.deepEqual(calls,[{url:"http://127.0.0.1:19424/launch",method:"POST"}]);
  const fail=(async()=>Response.json({ok:false},{status:503})) as typeof fetch;
  assert.equal((await new LinuxDouyinOpsLauncher(fail).launch()).status,"FAILED");
  const offline=(async()=>{throw Error("offline");}) as typeof fetch;
  assert.equal((await new LinuxDouyinOpsLauncher(offline).launch()).status,"UNAVAILABLE");
});

test("Linux research login uses the shared browser without exporting cookies",async()=>{
  const launcher=new LinuxDouyinOpsLauncher((async()=>Response.json({ok:true})) as typeof fetch);
  const research=new LinuxDouyinResearchAuthLauncher(launcher,(async()=>Response.json({ready:true})) as typeof fetch);
  assert.equal((await research.launch()).executable,"server-chromium");
  assert.deepEqual(await research.syncCookies(),{cookieCount:0,hasSession:true});
  const offline=new LinuxDouyinResearchAuthLauncher(launcher,(async()=>Response.json({ready:false})) as typeof fetch);
  await assert.rejects(offline.syncCookies(),/尚未连接/);
});

test("Linux API keys survive a store restart and reject tampering",async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"pvs-fnos-keys-"));
  const store=new LocalAesSecretStore(directory);
  await store.set("provider-1","mock-private-key");
  assert.equal(await new LocalAesSecretStore(directory).get("provider-1"),"mock-private-key");
  const filename=path.join(directory,"provider-1.json");
  const text=await fs.readFile(filename,"utf8");assert.equal(text.includes("mock-private-key"),false);
  const parsed=JSON.parse(text);parsed.tag=Buffer.alloc(16).toString("base64");
  await fs.writeFile(filename,JSON.stringify(parsed));await assert.rejects(store.get("provider-1"));
});

test("Session cookies cannot be forged from the static password; cross-origin requests fail",async()=>{
  const {createSessionGuard}=await runtime("session.mjs");
  const password="x".repeat(32),guard=createSessionGuard(password);
  const req=(value:string,origin="http://pvs.test")=>({headers:{host:"pvs.test",origin,cookie:"pvs_session="+value}});
  assert.equal(guard.allowed(req(password)),false);
  const session=guard.issue();assert.notEqual(session,password);
  assert.equal(guard.allowed(req(session)),true);
  assert.equal(guard.allowed(req(session,"http://evil.test")),false);
  assert.equal(guard.allowed(req(session,"malformed")),false);
  guard.revoke(req(session));assert.equal(guard.allowed(req(session)),false);
});

test("Remote-browser HTTP and WebSocket share PVS authentication and only proxy noVNC",async()=>{
  const {createSessionGuard}=await runtime("session.mjs");
  const {createBrowserProxy}=await runtime("browser-proxy.mjs");
  const guard=createSessionGuard("y".repeat(32)),cookie="pvs_session="+guard.issue();
  const sockets=new Set<import("node:net").Socket>();
  const upstream=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"text/html"});res.end(req.url);});
  upstream.on("upgrade",(req,socket)=>{
    const accept=createHash("sha1").update(String(req.headers["sec-websocket-key"])+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    socket.on("data",()=>socket.end());
  });
  upstream.listen(0,"127.0.0.1");await once(upstream,"listening");
  const proxy=createBrowserProxy(guard,{port:(upstream.address() as {port:number}).port});
  const app=http.createServer((req,res)=>{if(!proxy.handle(req,res)){res.writeHead(404);res.end();}});
  for(const server of [app,upstream])server.on("connection",socket=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));});
  app.on("upgrade",proxy.upgrade);app.listen(0,"127.0.0.1");await once(app,"listening");
  const origin="http://127.0.0.1:"+(app.address() as {port:number}).port;
  try{
    assert.equal((await fetch(origin+"/browser/douyin/vnc.html")).status,401);
    const response=await fetch(origin+"/browser/douyin/vnc.html",{headers:{cookie}});
    assert.equal(response.status,200);assert.equal(await response.text(),"/vnc.html");
    assert.equal((await fetch(origin+"/browser/douyin/vnc.html",{headers:{cookie,origin:"http://evil.test"}})).status,401);
    assert.equal(proxy.target("/browser/douyin/%2e%2e%2fprivate"),null);
    assert.equal(proxy.target("/browser/douyin/json/version"),null);
    const connect=(headers:Record<string,string>)=>new Promise<number>((resolve,reject)=>{
      const req=http.request(origin+"/browser/douyin/websockify",{headers:{connection:"Upgrade",upgrade:"websocket",
        "sec-websocket-key":Buffer.alloc(16).toString("base64"),"sec-websocket-version":"13",...headers}});
      req.on("response",res=>{res.resume();resolve(res.statusCode!);});
      req.on("upgrade",(res,socket)=>{socket.destroy();resolve(res.statusCode!);});req.on("error",reject);req.end();
    });
    assert.equal(await connect({origin}),403);
    assert.equal(await connect({cookie,origin:"http://evil.test"}),403);
    assert.equal(await connect({cookie,origin}),101);
  }finally{proxy.close();for(const socket of sockets)socket.destroy();app.closeAllConnections();upstream.closeAllConnections();app.close();upstream.close();}
});
