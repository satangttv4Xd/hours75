import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
const root=path.resolve(import.meta.dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hours75-subpath-'));
const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;socket.close();
const origin=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,ADMIN_PASSWORD:'this-is-a-long-test-password',SESSION_SECRET:'b'.repeat(64),PUBLIC_ORIGIN:'https://witcha.dusit.ac.th',BASE_PATH:'/75hour',PORT:String(port),HOST:'127.0.0.1',DATA_DIR:temp},stdio:'ignore'});
for(let i=0;i<40;i++){try{await fetch(origin+'/75hour/');break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
test('subpath serves assets and protects API',async()=>{
  const redirect=await fetch(origin+'/75hour',{redirect:'manual'});assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'/75hour/');
  const rootPage=await fetch(origin+'/');assert.equal(rootPage.status,404);
  const page=await fetch(origin+'/75hour/');assert.equal(page.status,200);assert.match(await page.text(),/href="style.css"/);
  assert.equal((await fetch(origin+'/75hour/app.js')).status,200);
  assert.equal((await fetch(origin+'/75hour/api/students')).status,401);
  const login=await fetch(origin+'/75hour/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'this-is-a-long-test-password'})});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/Path=\/75hour/);
  assert.doesNotMatch(login.headers.get('set-cookie'),/; Secure/);
  const foreign=await fetch(origin+'/75hour/api/login',{method:'POST',headers:{origin:'https://unrelated.example','content-type':'application/json'},body:JSON.stringify({username:'admin',password:'this-is-a-long-test-password'})});assert.equal(foreign.status,403);
  const students=await fetch(origin+'/75hour/api/students',{headers:{cookie:login.headers.get('set-cookie').split(';')[0]}});assert.equal((await students.json()).students.length,15);
});
after(async()=>{
  child.kill();
  await new Promise(r=>{ child.on('exit',r); setTimeout(r,500); });
  try { fs.rmSync(temp,{recursive:true,force:true}); } catch {}
});
