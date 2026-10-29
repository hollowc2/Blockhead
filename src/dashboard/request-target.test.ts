import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { requestTarget } from "./http-guard.js";

test("only origin-form targets with stable routing are accepted", () => {
  for (const target of ["http://[", "http://evil.example/viewer/", "//evil/viewer/", "*", "evil:80", "/foo\\bar", "/a/../viewer/", "/%2e%2e/viewer/", "/%zz", "/#fragment", "/bad\nheader"]) assert.equal(requestTarget(target), null, target);
  assert.equal(requestTarget("/socket.io/?EIO=4&transport=polling")?.pathname, "/socket.io/");
});

test("malformed HTTP/upgrades survive in an isolated process, never reach upstream, and valid requests still work", async () => {
  const source = `
    import assert from 'node:assert/strict';
    import {createServer} from 'node:http';
    import {connect} from 'node:net';
    import {ViewerShellServer} from './src/dashboard/viewer-shell.ts';
    import {ReadOnlyViewerServer} from './src/dashboard/viewer-server.ts';
    import {DashboardServer} from './src/dashboard/server.ts';
    import {EventEmitter} from 'node:events';
    let seen=0;
    const upstream=createServer((q,s)=>{seen++;s.end('ok')});
    await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
    const upstreamPort=upstream.address().port;
    const shells = ['public','private'].map(mode=>new ViewerShellServer({host:'127.0.0.1',port:0,viewerPort:upstreamPort,statsPort:upstreamPort,mode,publicState:async()=>({public:true})}));
    for(const shell of shells) await shell.start();
    const bot=new EventEmitter();
    const raw=new ReadOnlyViewerServer(bot,{host:'127.0.0.1',port:0,viewDistance:1,maxConnections:2,maxPublicConnections:1}); await raw.start();
    const dashboard=new DashboardServer({host:'127.0.0.1',port:0,snapshot:()=>({})});dashboard.start();
    while(!dashboard.address())await new Promise(r=>setImmediate(r));
    const ports=[...shells.map(s=>s.server.address().port),raw.http.address().port,dashboard.address().port];
    for(const port of ports) {
      for(const target of ['http://[','//[','http://evil.example/viewer/']) {
        await new Promise((resolve,reject)=>{const s=connect(port,'127.0.0.1',()=>s.end('GET '+target+' HTTP/1.1\\r\\nHost: local\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\\r\\n\\r\\n'));s.on('data',()=>{});s.on('error',reject);s.on('close',resolve);s.setTimeout(1000,()=>s.destroy());});
      }
      for(const target of ['http://[','//evil/viewer/']) {
        await new Promise((resolve,reject)=>{const s=connect(port,'127.0.0.1',()=>s.end('GET '+target+' HTTP/1.1\\r\\nHost: local\\r\\nConnection: close\\r\\n\\r\\n'));s.on('data',()=>{});s.on('error',reject);s.on('close',resolve);s.setTimeout(1000,()=>s.destroy());});
      }
      assert.equal((await fetch('http://127.0.0.1:'+port+'/')).status,200);
    }
    assert.equal(seen,0);
    for(const shell of shells)shell.stop(); raw.close(); dashboard.stop(); upstream.closeAllConnections(); await new Promise(r=>upstream.close(r));
    console.log('survived');
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", c => { output += c; }); child.stderr.on("data", c => { output += c; });
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    assert.equal(code, 0, output); assert.match(output, /survived/);
  } finally { clearTimeout(timer); child.kill(); }
});
