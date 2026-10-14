import http from 'node:http';

// Only noVNC static assets and its single WebSocket are forwarded. Chromium CDP
// and the internal control/Bridge services are never exposed by this proxy.
export function createBrowserProxy(guard,{host='127.0.0.1',port=6080}={}) {
  const prefix='/browser/douyin/';
  const sockets=new Set();
  function target(raw) {
    const url=new URL(raw,'http://pvs.invalid');
    if(!url.pathname.startsWith(prefix)) return null;
    let suffix;
    try{suffix=decodeURIComponent(url.pathname.slice(prefix.length));}catch{return null;}
    if(suffix.includes('..')||suffix.includes('\\')||suffix.includes('\0')||suffix.startsWith('/')) return null;
    const known=suffix==='vnc.html'||suffix==='websockify'||suffix==='defaults.json'||suffix==='mandatory.json'||
      suffix==='favicon.ico'||/^(app|core|vendor)\/[A-Za-z0-9_./-]+$/.test(suffix);
    return known?'/'+suffix+url.search:null;
  }
  function handle(req,res) {
    if(!req.url?.startsWith(prefix)) return false;
    if(!guard.allowed(req)){res.writeHead(401);res.end('请先登录 PVS');return true;}
    const path=target(req.url);
    if(req.method!=='GET'||!path||path.split('?')[0]==='/websockify'){res.writeHead(404);res.end();return true;}
    const upstream=http.request({host,port,path,method:'GET',headers:{host:`${host}:${port}`}},response=>{
      res.writeHead(response.statusCode??502,{'content-type':response.headers['content-type']??'application/octet-stream',
        'cache-control':'no-store','x-frame-options':'SAMEORIGIN','referrer-policy':'same-origin'});
      response.pipe(res);
    });
    upstream.setTimeout(10_000,()=>upstream.destroy());
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end('远程浏览器服务暂不可用');});
    req.on('aborted',()=>upstream.destroy());upstream.end();return true;
  }
  function upgrade(req,socket,head) {
    // An Origin is required for a browser-control WebSocket.
    const path=target(req.url??'');
    if(!guard.allowed(req)||!req.headers.origin||path?.split('?')[0]!=='/websockify'){
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;
    }
    const upstream=http.request({host,port,path:'/websockify',headers:{
      host:`${host}:${port}`,connection:'Upgrade',upgrade:'websocket',
      'sec-websocket-key':req.headers['sec-websocket-key'], 'sec-websocket-version':'13',
      ...(req.headers['sec-websocket-protocol']?{'sec-websocket-protocol':req.headers['sec-websocket-protocol']}:{})
    }});
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
    upstream.on('upgrade',(response,peer,peerHead)=>{
      const headers=Object.entries(response.headers).map(([key,value])=>`${key}: ${value}`).join('\r\n');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`);
      if(peerHead.length)socket.write(peerHead);if(head.length)peer.write(head);
      socket.pipe(peer).pipe(socket);
      const timer=setInterval(()=>{if(!guard.allowed(req))socket.destroy();},30000);timer.unref();
      socket.once('close',()=>clearInterval(timer));
      peer.on('error',()=>socket.destroy());socket.on('error',()=>peer.destroy());
      socket.on('close',()=>peer.destroy());peer.on('close',()=>socket.destroy());
    });
    upstream.on('response',response=>{response.resume();socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');});
    upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());upstream.end();
  }
  return {handle,upgrade,target,close:()=>{for(const socket of sockets)socket.destroy();}};
}
