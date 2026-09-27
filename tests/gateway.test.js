'use strict';
const {before,after,beforeEach,it}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const http=require('node:http');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'titian-gateway-'));
process.env.TITIAN_DATA_DIR=dir;
const {server}=require('../src/gateway/server.cjs');
const upstream=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({path:req.url}));});
let base,port;
const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
const save=projects=>fs.writeFileSync(path.join(dir,'projects.json'),JSON.stringify(projects));
before(async()=>{await listen(upstream);port=upstream.address().port;await listen(server);base='http://127.0.0.1:'+server.address().port;});
beforeEach(()=>save([{slug:'alpha',authPort:port},{slug:'off',authPort:port,enabled:false}]));
after(async()=>{for(const s of [server,upstream]){s.closeAllConnections();await new Promise(r=>s.close(r));}fs.rmSync(dir,{recursive:true,force:true});});
it('routes project traffic and preserves query strings',async()=>{
 const r=await fetch(base+'/projects/alpha/mcp?sample=1');assert.equal(r.status,200);assert.equal((await r.json()).path,'/mcp?sample=1');
});
it('routes scoped OAuth discovery',async()=>{
 const r=await fetch(base+'/.well-known/oauth-authorization-server/projects/alpha');assert.equal((await r.json()).path,'/.well-known/oauth-authorization-server');
});
it('rejects unknown and disabled projects without root fallback',async()=>{
 for(const route of ['/projects/missing/mcp','/projects/off/mcp','/mcp'])assert.equal((await fetch(base+route)).status,404);
});
it('preserves an explicitly migrated root route and reloads registry changes',async()=>{
 save([{slug:'desktop',authPort:port,rootRoute:true}]);
 assert.equal((await(await fetch(base+'/authorize?state=test')).json()).path,'/authorize?state=test');
 save([{slug:'desktop',authPort:port,rootRoute:true,enabled:false}]);assert.equal((await fetch(base+'/mcp')).status,404);
});
it('reports invalid registry while keeping the gateway health check available',async()=>{
 fs.writeFileSync(path.join(dir,'projects.json'),'invalid');
 assert.equal((await fetch(base+'/projects/alpha/mcp')).status,503);assert.equal((await fetch(base+'/healthz')).status,200);
});
